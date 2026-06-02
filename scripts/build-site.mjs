#!/usr/bin/env node
// Bastion static-site generator (dependency-free).
// Reads bastion/biographies/<slug>/{chapters/*.md, character.json} + themes/theme-<slug>.yaml
// + ledger/<slug>/<id>.json + bastion/world.json  ->  renders docs/.
//
// Per bastion-website-spec.md (§2.1 generator, §3 IA, §5 engine-as-feature,
// §6 content/theme formats, §6.4 [OOC] convention) and PUBLISHING.md.
// docs/ is BUILD OUTPUT — never hand-edited. The build is idempotent.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const BIO_DIR = join(ROOT, 'bastion', 'biographies');
const THEME_DIR = join(ROOT, 'themes');
const LEDGER_DIR = join(ROOT, 'ledger');

const FONTS = 'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=JetBrains+Mono:wght@400;500&family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,500&display=swap';

// ───────────────────────── tiny YAML (controlled subset) ─────────────────────────
function stripQuotes(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}
function parseInlineArray(v) {
  const inner = v.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
}
function parseScalar(v) {
  v = v.trim();
  if (v.startsWith('[')) return parseInlineArray(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return stripQuotes(v);
}
// Parse a 2-level YAML map (top scalars/arrays + one nested-map level + block scalars).
function parseYaml(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) { i++; continue; }
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      const line = raw.replace(/\s+#.*$/, '');
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1]; let val = m[2];
      if (val === '|' || val === '>') {            // block scalar — consume indented lines
        i++; const buf = [];
        while (i < lines.length && (lines[i].trim() === '' || (lines[i].length - lines[i].trimStart().length) >= 2)) {
          buf.push(lines[i].replace(/^\s{0,2}/, '')); i++;
        }
        out[key] = buf.join('\n').trim();
        continue;
      }
      if (val === '') {                            // possible nested map
        const nested = {}; let any = false; i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) { i++; continue; }
          const ind = l.length - l.trimStart().length;
          if (ind < 2) break;
          const mm = l.replace(/\s+#.*$/, '').match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
          if (mm) { nested[mm[1]] = parseScalar(mm[2]); any = true; }
          i++;
        }
        out[key] = any ? nested : '';
        continue;
      }
      out[key] = parseScalar(val); i++;
    } else { i++; }
  }
  return out;
}
function parseFrontMatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: md };
  return { data: parseYaml(m[1]), body: m[2] };
}

// ───────────────────────── inline + block markdown ─────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  let t = esc(s);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, a, b) => `<a href="${b}">${a}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  return t;
}
// Render a block's lines: paragraphs, - bullets, 1. ordered, > quotes.
function renderBody(lines) {
  const out = [];
  let i = 0; const n = lines.length;
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  while (i < n) {
    const line = lines[i];
    if (line.trim() === '') { flush(); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      flush(); const items = [];
      while (i < n && /^\s*[-*]\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`); i++; }
      out.push(`<ul>${items.join('')}</ul>`); continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flush(); const items = [];
      while (i < n && /^\s*\d+\.\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`); i++; }
      out.push(`<ol>${items.join('')}</ol>`); continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush(); const q = [];
      while (i < n && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`); continue;
    }
    para.push(line); i++;
  }
  flush();
  return out.join('\n');
}

// ───────────────────────── DSL parser (:::type / [OOC] :::type) ─────────────────────────
function parseDSL(body) {
  const blocks = [];
  const lines = body.split(/\r?\n/);
  let i = 0;
  let loose = [];
  const flushLoose = () => { if (loose.join('').trim()) blocks.push({ ooc: false, type: 'panel', attrs: {}, lines: loose.slice() }); loose = []; };
  while (i < lines.length) {
    const open = lines[i].match(/^\s*(\[OOC\]\s*)?:::\s*([A-Za-z0-9_-]+)\s*(.*)$/);
    if (open && !/^\s*:::\s*$/.test(lines[i])) {
      flushLoose();
      const ooc = !!open[1];
      const type = open[2];
      const rest = (open[3] || '').trim();
      const attrs = {}; let modifier = '';
      const am = rest.match(/(\w+)="([^"]*)"/g);
      if (am) am.forEach(a => { const mm = a.match(/(\w+)="([^"]*)"/); attrs[mm[1]] = mm[2]; });
      else if (rest) modifier = rest;
      attrs.__modifier = modifier;
      const buf = []; i++;
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // consume closing :::
      blocks.push({ ooc, type, attrs, lines: buf });
    } else { loose.push(lines[i]); i++; }
  }
  flushLoose();
  return blocks;
}
function renderBlocks(blocks, sigil) {
  return blocks.map(b => {
    const body = renderBody(b.lines);
    if (b.ooc) {
      return `<aside class="ooc ooc--${esc(b.type)}"><header class="ooc__label"><span class="ooc__tag">[OOC]</span> <span class="ooc__type">${esc(b.type)}</span> <span class="ooc__sigil" title="committed by the System">${sigil}</span></header><div class="ooc__body">${body}</div></aside>`;
    }
    switch (b.type) {
      case 'bubble': {
        const who = b.attrs.who || '';
        return `<div class="bubble"><span class="bubble__who">${esc(who)}</span><div class="bubble__say">${body}</div></div>`;
      }
      case 'sfx': return `<div class="sfx">${body}</div>`;
      case 'cap': return `<div class="cap">${body}</div>`;
      case 'panel':
      default: {
        const mod = b.attrs.__modifier ? ` panel--${esc(b.attrs.__modifier)}` : '';
        return `<div class="panel${mod}">${body}</div>`;
      }
    }
  }).join('\n');
}

// ───────────────────────── theme → css vars ─────────────────────────
const CITY_THEME = {
  name: 'Bastion', palette: { night: '#0b0c0e', paper: '#e9e4d8', accent: '#c4632a', ash: '#6b6258', line: 'rgba(196,99,42,.25)' },
  type: { display: 'Oswald', serif: 'Newsreader', mono: 'JetBrains Mono' }, sigil: '◆', motif: 'ash',
};
function themeVars(theme) {
  const p = theme.palette || {};
  const t = theme.type || {};
  const vars = [];
  for (const [k, v] of Object.entries(p)) vars.push(`--c-${k}: ${v};`);
  vars.push(`--f-display: "${t.display || 'Oswald'}", system-ui, sans-serif;`);
  vars.push(`--f-serif: "${t.serif || 'Newsreader'}", Georgia, serif;`);
  vars.push(`--f-mono: "${t.mono || 'JetBrains Mono'}", ui-monospace, monospace;`);
  if (!p.line) vars.push(`--c-line: rgba(255,255,255,.14);`);
  return vars.join(' ');
}

// ───────────────────────── layout ─────────────────────────
function rel(depth) { return depth === 0 ? '.' : Array(depth).fill('..').join('/'); }
function layout({ title, theme, depth, bodyClass = '', content, motif }) {
  const root = rel(depth);
  const nav = [
    `<a href="${root}/index.html">Bastion</a>`,
    `<a href="${root}/biographies/operator/index.html">The Operator</a>`,
    `<a href="${root}/biographies/mnehmos/index.html">Mnehmos</a>`,
    `<a href="${root}/city/timeline.html">City Timeline</a>`,
    `<a href="${root}/about.html">About</a>`,
  ].join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="${root}/assets/site.css">
<style>:root{ ${themeVars(theme)} }</style>
</head>
<body class="${bodyClass} motif-${motif || theme.motif || 'none'}">
<div class="bg" aria-hidden="true"></div>
<header class="site-head">
  <div class="wrap site-head__row">
    <a class="brand" href="${root}/index.html"><span class="brand__sigil">${theme.sigil || '◆'}</span> BASTION</a>
    <nav class="site-nav">${nav}</nav>
  </div>
</header>
<main class="wrap">
${content}
</main>
<footer class="site-foot">
  <div class="wrap">
    <p class="committed"><span class="committed__sigil">${theme.sigil || '◆'}</span> Every event on this site was committed by the System before it was written. The dice are honest; the numbers are real; the protagonist can lose — and the reader can check.</p>
    <p class="foot-meta">Bastion — generated from committed rpg-mcp state. Source of truth: the ledger. <a href="${root}/about.html">How this is made</a>.</p>
  </div>
</footer>
</body>
</html>`;
}

// ───────────────────────── HUD sheet ─────────────────────────
const MOD = (s) => { const m = Math.floor((s - 10) / 2); return (m >= 0 ? '+' : '') + m; };
function hudSheet(ch, theme) {
  if (!ch) return '';
  const st = ch.stats || {};
  const statRow = ['str', 'dex', 'con', 'int', 'wis', 'cha'].map(k =>
    `<div class="stat"><span class="stat__k">${k.toUpperCase()}</span><span class="stat__v">${st[k] ?? '—'}</span><span class="stat__m">${st[k] != null ? MOD(st[k]) : ''}</span></div>`
  ).join('');
  const hpPct = ch.maxHp ? Math.round((ch.hp / ch.maxHp) * 100) : 0;
  const pools = ch.resourcePools || {};
  const poolBars = Object.entries(pools).map(([k, v]) => {
    const pct = v.max ? Math.round((v.current / v.max) * 100) : 0;
    const label = k.replace(/_/g, ' ');
    return `<div class="bar bar--pool"><div class="bar__label">${esc(label)} <b>${v.current}/${v.max}</b></div><div class="bar__track"><div class="bar__fill" style="width:${pct}%"></div></div></div>`;
  }).join('');
  const bound = (ch.boundSubsystems || []).map(s => `<span class="chip">${esc(s)}</span>`).join('');
  return `<aside class="hud">
  <div class="hud__head"><span class="hud__sigil">${theme.sigil || '◆'}</span><div><div class="hud__name">${esc(ch.name)}</div><div class="hud__sub">${esc(ch.race || '')} · ${esc(ch.characterClass || '')} · L${ch.level}</div></div></div>
  <div class="bar"><div class="bar__label">HP <b>${ch.hp}/${ch.maxHp}</b></div><div class="bar__track"><div class="bar__fill bar__fill--hp" style="width:${hpPct}%"></div></div></div>
  <div class="hud__ac">AC <b>${ch.ac}</b></div>
  ${poolBars}
  <div class="hud__stats">${statRow}</div>
  ${bound ? `<div class="hud__bound"><span class="hud__bound-label">Bound subsystems</span>${bound}</div>` : ''}
  <div class="hud__note">Engine-validated. This sheet is <code>character_manage</code> state, rendered.</div>
</aside>`;
}

// ───────────────────────── engine log ─────────────────────────
function renderEngineLog(ledger) {
  if (!ledger) return '<p class="muted">No engine log exported for this chapter.</p>';
  const parts = [];
  if (ledger.perception_assessments) {
    for (const a of ledger.perception_assessments) {
      if (a.target_ref_id === 'recovery_grant') {
        parts.push(`<div class="elog__row"><div class="elog__h">recover · grant <span class="elog__hash">seq ${a.seq} · ${(a.event_hash || '').slice(0, 12)}…</span></div><p>Attentional pool initialized to ${a.capacity_remaining_after}. The lens is bound; the cost of looking begins.</p></div>`);
        continue;
      }
      const hz = (a.hazards || []).map(h => `<li><b>${esc(h.name)}</b> — ${esc(h.kind)} · ${esc(h.severity)} <span class="muted">(${esc(h.sourceEvidence?.tool || '')} ${esc((h.sourceEvidence?.rowId || '').slice(0, 8))})</span></li>`).join('');
      const ct = (a.applicable_controls || []).map(c => `<li><b>${esc(c.level)}</b> — ${esc(c.countermeasureSummary)} <span class="conf conf--${esc(c.confidence)}">${esc(c.confidence)}</span>${c.missingDataForHigherLevel ? `<br><span class="muted">↳ ${esc(c.missingDataForHigherLevel)}</span>` : ''}</li>`).join('');
      const bs = (a.blind_spots || []).map(b => `<li><b>${esc(b.whatKindOfDataIsMissing)}</b> — ${esc(b.whyItMatters)}</li>`).join('');
      parts.push(`<div class="elog__row">
        <div class="elog__h">perception · assess · <span class="conf conf--${esc(a.disposition)}">${esc(a.disposition)}</span> <span class="elog__hash">seq ${a.seq} · cost ${a.cost_paid} · left ${a.capacity_remaining_after} · ${(a.event_hash || '').slice(0, 12)}…</span></div>
        ${hz ? `<div class="elog__sec"><h5>Hazards</h5><ul>${hz}</ul></div>` : ''}
        ${ct ? `<div class="elog__sec"><h5>Controls (Hierarchy of Controls)</h5><ol>${ct}</ol></div>` : ''}
        ${bs ? `<div class="elog__sec"><h5>Blind spots</h5><ul>${bs}</ul></div>` : ''}
      </div>`);
    }
  }
  if (ledger.rite) {
    const arr = (ledger.rite.committedArrivals || []).filter(Boolean).map(c => `<li><b>${esc(c.name)}</b> — ${esc(c.character_class || '')} <span class="muted">${esc(c.origin?.universe || '')}</span></li>`).join('');
    const named = (ledger.rite.namedButNotYetInstanced || []).map(s => `<li class="muted">${esc(s)}</li>`).join('');
    parts.push(`<div class="elog__row"><div class="elog__h">rite · ${esc(ledger.rite.name)} <span class="elog__hash">wave ${(ledger.rite.cohortWave || '').slice(0, 8)}…</span></div>
      <div class="elog__sec"><h5>Committed arrivals</h5><ul>${arr}</ul></div>
      ${named ? `<div class="elog__sec"><h5>Named in the rite, not yet instanced</h5><ul>${named}</ul></div>` : ''}</div>`);
  }
  if (ledger.agent_calls) {
    const rows = ledger.agent_calls.map(c => `<tr><td>${esc((c.id || '').slice(0, 8))}</td><td>${esc(c.model)}</td><td>${esc(c.reasoning_effort || '')}</td><td>${c.prompt_tokens ?? '—'}/${c.completion_tokens ?? '—'}</td><td class="conf conf--${esc(c.status)}">${esc(c.status)}</td></tr>`).join('');
    parts.push(`<div class="elog__row"><div class="elog__h">agent calls (LLM audit)</div><table class="elog__tbl"><thead><tr><th>call</th><th>model</th><th>effort</th><th>tok in/out</th><th>status</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  }
  const raw = esc(JSON.stringify(ledger, null, 2));
  parts.push(`<details class="elog__raw"><summary>Raw committed ledger (JSON)</summary><pre>${raw}</pre></details>`);
  return parts.join('\n');
}

// ───────────────────────── load data ─────────────────────────
function loadTheme(slug) {
  const f = join(THEME_DIR, `theme-${slug}.yaml`);
  return existsSync(f) ? parseYaml(readFileSync(f, 'utf8')) : { name: slug, palette: {}, type: {} };
}
function loadJson(f) { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; }

function loadBiographies() {
  const bios = [];
  for (const slug of readdirSync(BIO_DIR)) {
    const dir = join(BIO_DIR, slug);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    const chDir = join(dir, 'chapters');
    const chapters = [];
    if (existsSync(chDir)) {
      for (const f of readdirSync(chDir).filter(x => x.endsWith('.md')).sort()) {
        const { data, body } = parseFrontMatter(readFileSync(join(chDir, f), 'utf8'));
        const id = data.id || f.replace(/\.md$/, '');
        chapters.push({ id, file: f, data, body });
      }
    }
    bios.push({ slug, theme: loadTheme(slug), character: loadJson(join(dir, 'character.json')), chapters });
  }
  const order = ['operator', 'mnehmos'];
  bios.sort((a, b) => (order.indexOf(a.slug) + 1 || 99) - (order.indexOf(b.slug) + 1 || 99));
  return bios;
}

// resolve ledger by chapter id (ledger/<slug>/<id>.json or ledger/<slug>/ch01.json)
function ledgerFor(slug, id) {
  const candidates = [`${id}.json`];
  const m = id.match(/^(ch\d+)/i); if (m) candidates.push(`${m[1]}.json`);
  for (const c of candidates) { const f = join(LEDGER_DIR, slug, c); if (existsSync(f)) return loadJson(f); }
  return null;
}

// ───────────────────────── page helpers ─────────────────────────
function bioTitle(b) { return b.character?.name ? `${b.character.name}` : b.theme.name; }
function bioRole(b) { return b.slug === 'mnehmos' ? 'The Summoner-Priest · Biography #1 (the devlog)' : `${b.character?.characterClass || ''} · Biography #2`; }
function write(rel0, html) { const out = join(DOCS, rel0); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, html); }

function build() {
  for (const e of ['index.html', 'about.html', 'biographies', 'city', 'assets']) {
    const p = join(DOCS, e); if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  mkdirSync(join(DOCS, 'assets'), { recursive: true });
  writeFileSync(join(DOCS, 'assets', 'site.css'), CSS);
  writeFileSync(join(DOCS, '.nojekyll'), ''); // serve generated site verbatim (no Jekyll)

  const world = loadJson(join(ROOT, 'bastion', 'world.json')) || {};
  const bios = loadBiographies();

  // ----- landing -----
  const bioCards = bios.map(b => {
    const first = b.chapters[0];
    return `<a class="biocard" href="biographies/${b.slug}/index.html" style="--card-accent:${(b.theme.palette || {}).accent || '#c4632a'}">
      <div class="biocard__sigil">${b.theme.sigil || '◆'}</div>
      <div class="biocard__name">${esc(bioTitle(b))}</div>
      <div class="biocard__role">${esc(bioRole(b))}</div>
      <div class="biocard__world">${esc((b.theme.source_world) || '')}</div>
      ${first ? `<div class="biocard__teaser">${esc(first.data.teaser || '')}</div>` : '<div class="biocard__teaser muted">first life incoming…</div>'}
      <span class="biocard__go">Read →</span>
    </a>`;
  }).join('');
  const cohort = (world.cohort || []).map(c => `<li><b>${esc(c.name)}</b> <span class="muted">— ${esc(c.role || '')}${c.future ? ' · future biography' : ''}</span></li>`).join('');
  const landing = `
  <section class="hero hero--city">
    <p class="hero__kicker">The last city · PD ${esc(world.pd || '606')}</p>
    <h1 class="hero__title">Bastion is the last city.<br>It summons heroes from every kind of world.</h1>
    <p class="hero__lede">Their powers arrive intact. Nothing is balanced. The city only records what survives. <strong>Every number is real; the dice are honest; the protagonist can actually lose — and did.</strong> Read it as a novel, or check the math yourself.</p>
    <div class="hero__cta"><a class="btn" href="city/timeline.html">The city timeline →</a><a class="btn btn--ghost" href="about.html">How this is made</a></div>
  </section>

  <section class="sec">
    <h2 class="sec__h">The lives</h2>
    <div class="biogrid">${bioCards}</div>
  </section>

  <section class="sec">
    <h2 class="sec__h">The first cohort</h2>
    <p class="sec__lede">One rite. Many souls, chosen on purpose. The Operator was not summoned alone — these arrived with him, and each is a life still to be written.</p>
    <ul class="cohort">${cohort}</ul>
  </section>

  <section class="sec sec--made">
    <h2 class="sec__h">How this is made <span class="sigil">◆</span></h2>
    <p>Bastion runs on a real game engine. Souls are LLM-driven players inside it; they petition a System that is the physics of the world, and the System commits — or refuses — against a gated ledger. The chapters you read are the transcript of committed events, not authored ahead of them. The inline <span class="ooc-inline">[OOC]</span> readouts and the collapsible <em>Engine Log</em> under each chapter read the <em>same</em> committed rows — so the numbers in the prose and the numbers in the audit always match. <a href="about.html">The full method →</a></p>
  </section>`;
  write('index.html', layout({ title: 'Bastion — the last city', theme: CITY_THEME, depth: 0, bodyClass: 'page-city', content: landing }));

  // ----- about -----
  const about = `
  <section class="hero hero--sub"><p class="hero__kicker">The method</p><h1 class="hero__title">Honest crunch.</h1>
  <p class="hero__lede">The differentiator is not how much crunch — it is that the crunch is real.</p></section>
  <section class="prose-col">
    <h2>The story is the transcript</h2>
    <p>Every biography on this site is run, not written. A soul is an LLM-driven player inside the rpg-mcp engine. It cannot author outcomes; it can only <em>petition</em> the System — the adjudicating layer that is the physics of the world — and the System commits the result to a gated ledger, or refuses it. The chapter is the record of what was committed. "Narrate from state, never ahead of it."</p>
    <h2>The dice are honest — and checkable</h2>
    <p>LitRPG readers are used to inline stat boxes and rolls. Ordinarily those numbers are the author typing a number. Here, every inline <span class="ooc-inline">[OOC]</span> readout is pulled from the committed ledger — the same rows shown in the chapter's collapsible <em>Engine Log</em>. Two registers share one column: unmarked text is the world; <span class="ooc-inline">[OOC]</span> is the engine speaking. Skim the prose, or audit the math — both are first-class.</p>
    <h2>The protagonist can lose</h2>
    <p>Because the engine can say no, growth means something when it says yes — and loss is real when it comes. When an agent fails honestly, that is a headline, not an embarrassment. The most persuasive thing a Bastion page can show is a protagonist who did not get his way, because the System would not grant it.</p>
    <h2>The maker is a petitioner too</h2>
    <p>Even Mnehmos, who performs the rite, only asks. The System is the sole thing that writes to the world. His biography — the devlog — is the seam where building the world and telling its myth are the same act: the ceremony is the commit, the liturgy is the changelog.</p>
  </section>`;
  write('about.html', layout({ title: 'Bastion — how this is made', theme: CITY_THEME, depth: 0, bodyClass: 'page-about', content: about }));

  // ----- per biography -----
  for (const b of bios) {
    const t = b.theme;
    const chList = b.chapters.map((c, idx) => `<a class="ch-item" href="chapters/${c.id}.html">
      <span class="ch-item__n">${String(idx + 1).padStart(2, '0')}</span>
      <span class="ch-item__body"><span class="ch-item__title">${esc(c.data.title || c.id)}</span>
      <span class="ch-item__when">${esc(c.data.when || '')}</span>
      <span class="ch-item__teaser">${esc(c.data.teaser || '')}</span></span>
      ${(c.data.convergence && c.data.convergence.length) ? `<span class="ch-item__conv" title="convergence">${t.sigil || '◆'} convergence</span>` : ''}
    </a>`).join('');

    const hero = `
    <section class="bio-hero">
      <div class="bio-hero__main">
        <p class="hero__kicker">${esc(bioRole(b))}</p>
        <h1 class="hero__title">${esc(bioTitle(b))}</h1>
        <p class="bio-hero__world">${esc(t.source_world || '')}</p>
        <p class="hero__lede">${esc(b.chapters[0]?.data.teaser || '')}</p>
        <div class="hero__cta"><a class="btn" href="story.html">All chapters →</a>${b.chapters[0] ? `<a class="btn btn--ghost" href="chapters/${b.chapters[0].id}.html">Start reading</a>` : ''}</div>
      </div>
      ${hudSheet(b.character, t)}
    </section>
    <section class="sec"><h2 class="sec__h">Arc so far</h2><div class="ch-list">${chList || '<p class="muted">No chapters yet.</p>'}</div></section>`;
    write(`biographies/${b.slug}/index.html`, layout({ title: `${bioTitle(b)} — Bastion`, theme: t, depth: 2, bodyClass: `page-bio bio-${b.slug}`, content: hero }));

    const acts = {};
    for (const c of b.chapters) { const a = c.data.act || 'Chapters'; (acts[a] ||= []).push(c); }
    const toc = Object.entries(acts).map(([act, cs]) => `<section class="sec"><h2 class="sec__h">${esc(act)}</h2><div class="ch-list">${cs.map((c, i) => `<a class="ch-item" href="chapters/${c.id}.html"><span class="ch-item__n">${String(i + 1).padStart(2, '0')}</span><span class="ch-item__body"><span class="ch-item__title">${esc(c.data.title || c.id)}</span><span class="ch-item__when">${esc(c.data.when || '')}</span><span class="ch-item__teaser">${esc(c.data.teaser || '')}</span></span></a>`).join('')}</div></section>`).join('');
    write(`biographies/${b.slug}/story.html`, layout({ title: `${bioTitle(b)} — chapters`, theme: t, depth: 2, bodyClass: `page-toc bio-${b.slug}`, content: `<section class="hero hero--sub"><p class="hero__kicker">${esc(bioTitle(b))}</p><h1 class="hero__title">Chapters</h1></section>${toc}` }));

    b.chapters.forEach((c, idx) => {
      const prev = b.chapters[idx - 1], next = b.chapters[idx + 1];
      const blocks = parseDSL(c.body);
      const story = renderBlocks(blocks, t.sigil || '◆');
      const ledger = ledgerFor(b.slug, c.id);
      const conv = (c.data.convergence || []).map(ref => {
        const [oslug, oid] = ref.split('/');
        const ob = bios.find(x => x.slug === oslug);
        const oname = ob ? bioTitle(ob) : oslug;
        return `<a class="conv-card" href="../../${oslug}/chapters/${oid}.html"><span class="conv-card__sigil">${t.sigil || '◆'}</span><span><b>The same event, another interior</b><br>${esc(oname)} — read this rite from their side.</span></a>`;
      }).join('');
      const nav = `<nav class="ch-nav">${prev ? `<a href="${prev.id}.html">← ${esc(prev.data.title || prev.id)}</a>` : '<span></span>'}<a class="ch-nav__toc" href="../story.html">All chapters</a>${next ? `<a href="${next.id}.html">${esc(next.data.title || next.id)} →</a>` : '<span></span>'}</nav>`;
      const content = `
      <article class="chapter">
        <header class="chapter__head">
          <p class="chapter__act">${esc(c.data.act || '')}</p>
          <h1 class="chapter__title">${esc(c.data.title || c.id)}</h1>
          <p class="chapter__when">${esc(c.data.when || '')}</p>
          ${(c.data.tags && c.data.tags.length) ? `<div class="chapter__tags">${c.data.tags.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}
        </header>
        ${conv ? `<div class="conv-row">${conv}</div>` : ''}
        <div class="chapter__body">${story}</div>
        ${conv ? `<div class="conv-row conv-row--foot">${conv}</div>` : ''}
        <details class="enginelog"><summary><span class="enginelog__sigil">${t.sigil || '◆'}</span> Engine Log — the committed state behind this chapter</summary><div class="enginelog__body">${renderEngineLog(ledger)}</div></details>
        ${nav}
      </article>`;
      write(`biographies/${b.slug}/chapters/${c.id}.html`, layout({ title: `${c.data.title || c.id} — ${bioTitle(b)}`, theme: t, depth: 3, bodyClass: `page-chapter bio-${b.slug}`, content }));
    });
  }

  // ----- city timeline -----
  const interiors = bios.flatMap(b => b.chapters.map(c => ({ b, c })))
    .filter(x => (x.c.data.convergence || []).length || /606|day 1|first rite|arrival/i.test(x.c.data.when || ''));
  const seen = new Set();
  const nodeRows = interiors.filter(x => { const k = x.b.slug + '/' + x.c.id; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(x => `<a class="tl-interior" href="../biographies/${x.b.slug}/chapters/${x.c.id}.html" style="--card-accent:${(x.b.theme.palette || {}).accent || '#c4632a'}"><span class="tl-interior__sigil">${x.b.theme.sigil || '◆'}</span><span><b>${esc(bioTitle(x.b))}</b> — ${esc(x.c.data.title || '')}<br><span class="muted">${esc(x.c.data.teaser || '')}</span></span></a>`).join('');
  const timeline = `
  <section class="hero hero--sub"><p class="hero__kicker">The shared clock</p><h1 class="hero__title">City Timeline</h1>
  <p class="hero__lede">All lives positioned on one clock. Where two accounts share a node, it is the <em>same committed event</em> — neither can contradict the other, because both read the same ledger.</p></section>
  <ol class="timeline">
    <li class="tl-node">
      <div class="tl-node__date">PD ${esc(world.pd || '606')} <span class="muted">· the first rite</span></div>
      <div class="tl-node__title">The Calling — and the Arrival <span class="conv-badge">◆ convergence</span></div>
      <p class="tl-node__lede">Mnehmos performs the first <em>Vocatio Sebastina</em>; the Operator is one of the souls who arrives. One committed rite, read from two interiors.</p>
      <div class="tl-node__interiors">${nodeRows}</div>
    </li>
  </ol>`;
  write('city/timeline.html', layout({ title: 'Bastion — city timeline', theme: CITY_THEME, depth: 1, bodyClass: 'page-timeline', content: timeline }));

  console.log(`Built: ${bios.length} biographies, ${bios.reduce((n, b) => n + b.chapters.length, 0)} chapters → docs/`);
  for (const b of bios) console.log(`  · ${b.slug}: ${b.chapters.map(c => c.id).join(', ') || '(none)'}`);
}

// ───────────────────────── CSS (shared frame) ─────────────────────────
const CSS = String.raw`
:root{ --maxw: 1140px; --rad: 14px; }
*{box-sizing:border-box} html{scroll-behavior:smooth}
body{margin:0;background:var(--c-night,#0b0c0e);color:var(--c-paper,#e9e4d8);
  font-family:var(--f-serif);line-height:1.65;font-size:18px;-webkit-font-smoothing:antialiased;position:relative;min-height:100vh}
.bg{position:fixed;inset:0;z-index:-1;opacity:.5;pointer-events:none;
  background:radial-gradient(1200px 700px at 78% -10%, color-mix(in srgb, var(--c-accent) 16%, transparent), transparent 60%),
             radial-gradient(900px 600px at -10% 110%, color-mix(in srgb, var(--c-accent) 10%, transparent), transparent 60%);}
.motif-load-lines .bg{background-image:
  radial-gradient(1100px 650px at 80% -10%, color-mix(in srgb, var(--c-accent) 14%, transparent), transparent 60%),
  repeating-linear-gradient(135deg, var(--c-line) 0 1px, transparent 1px 46px),
  repeating-linear-gradient(45deg, var(--c-line) 0 1px, transparent 1px 46px);}
.motif-rite-glyphs .bg{background-image:
  radial-gradient(1000px 700px at 50% -20%, color-mix(in srgb, var(--c-accent) 16%, transparent), transparent 60%),
  repeating-radial-gradient(circle at 50% 0%, var(--c-line) 0 1px, transparent 1px 70px);}
.motif-ash .bg{background-image:
  radial-gradient(1200px 700px at 70% -10%, color-mix(in srgb, var(--c-accent) 15%, transparent), transparent 55%),
  repeating-linear-gradient(0deg, var(--c-line) 0 1px, transparent 1px 80px);}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 22px}
a{color:var(--c-accent);text-decoration:none} a:hover{text-decoration:underline}
strong,b{color:color-mix(in srgb, var(--c-paper) 88%, var(--c-accent))}
code{font-family:var(--f-mono);font-size:.86em;background:color-mix(in srgb,var(--c-paper) 8%,transparent);padding:.08em .35em;border-radius:5px}
h1,h2,h3,h4,h5{font-family:var(--f-display);font-weight:600;line-height:1.12;letter-spacing:.01em}
blockquote{margin:0} p{margin:0 0 16px}

.site-head{position:sticky;top:0;z-index:20;backdrop-filter:blur(9px);
  background:color-mix(in srgb,var(--c-night) 78%,transparent);border-bottom:1px solid var(--c-line)}
.site-head__row{display:flex;align-items:center;justify-content:space-between;gap:18px;height:60px}
.brand{font-family:var(--f-display);font-weight:700;letter-spacing:.16em;color:var(--c-paper)}
.brand:hover{text-decoration:none;color:var(--c-accent)} .brand__sigil{color:var(--c-accent)}
.site-nav{display:flex;gap:18px;flex-wrap:wrap;font-family:var(--f-display);font-size:.82rem;letter-spacing:.06em;text-transform:uppercase}
.site-nav a{color:color-mix(in srgb,var(--c-paper) 72%,transparent)} .site-nav a:hover{color:var(--c-accent);text-decoration:none}
.site-foot{margin-top:80px;border-top:1px solid var(--c-line);padding:34px 0 60px;color:color-mix(in srgb,var(--c-paper) 62%,transparent);font-size:.9rem}
.committed{display:flex;gap:10px;align-items:flex-start;max-width:760px}
.committed__sigil{color:var(--c-accent);font-size:1.2em} .foot-meta{margin-top:10px;font-size:.82rem;opacity:.8}

.hero{padding:64px 0 30px;max-width:880px}
.hero--sub{padding:48px 0 14px}
.hero__kicker{font-family:var(--f-display);text-transform:uppercase;letter-spacing:.22em;font-size:.78rem;color:var(--c-accent);margin:0 0 14px}
.hero__title{font-size:clamp(2.1rem,5vw,3.6rem);margin:0 0 18px}
.hero__lede{font-size:1.18rem;color:color-mix(in srgb,var(--c-paper) 86%,transparent);max-width:720px}
.hero__cta{display:flex;gap:12px;margin-top:26px;flex-wrap:wrap}
.btn{font-family:var(--f-display);text-transform:uppercase;letter-spacing:.08em;font-size:.82rem;
  background:var(--c-accent);color:var(--c-night);padding:12px 20px;border-radius:999px;font-weight:600}
.btn:hover{text-decoration:none;filter:brightness(1.08)}
.btn--ghost{background:transparent;color:var(--c-paper);border:1px solid var(--c-line)}

.sec{margin:54px 0}
.sec__h{font-size:1.5rem;margin:0 0 18px;display:flex;align-items:center;gap:10px}
.sec__h .sigil,.sigil{color:var(--c-accent)}
.sec__lede{color:color-mix(in srgb,var(--c-paper) 80%,transparent);max-width:720px;margin:0 0 18px}
.sec--made p{max-width:780px;color:color-mix(in srgb,var(--c-paper) 84%,transparent)}
.muted{color:color-mix(in srgb,var(--c-paper) 55%,transparent)}

.biogrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}
.biocard{display:flex;flex-direction:column;gap:7px;padding:22px;border:1px solid var(--c-line);border-radius:var(--rad);
  background:color-mix(in srgb,var(--c-paper) 4%,transparent);position:relative;overflow:hidden;color:var(--c-paper)}
.biocard:hover{text-decoration:none;border-color:var(--card-accent);transform:translateY(-2px);transition:.18s}
.biocard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--card-accent)}
.biocard__sigil{font-size:1.5rem;color:var(--card-accent)}
.biocard__name{font-family:var(--f-display);font-size:1.45rem;font-weight:600}
.biocard__role{font-family:var(--f-display);text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;color:var(--card-accent)}
.biocard__world{font-style:italic;color:color-mix(in srgb,var(--c-paper) 66%,transparent);font-size:.92rem}
.biocard__teaser{color:color-mix(in srgb,var(--c-paper) 82%,transparent);font-size:.96rem;margin-top:4px}
.biocard__go{margin-top:auto;font-family:var(--f-display);font-size:.8rem;letter-spacing:.05em;color:var(--card-accent);padding-top:10px}
.cohort{columns:2;gap:24px;list-style:none;padding:0;max-width:760px}
.cohort li{margin:0 0 8px;break-inside:avoid}
.ooc-inline{font-family:var(--f-mono);font-size:.82em;color:var(--c-accent);border:1px solid var(--c-line);padding:0 .3em;border-radius:4px}

.bio-hero{display:grid;grid-template-columns:1fr;gap:28px;padding:54px 0 10px}
@media(min-width:880px){.bio-hero{grid-template-columns:1.4fr .9fr;align-items:start}}
.bio-hero__world{font-style:italic;color:color-mix(in srgb,var(--c-paper) 70%,transparent);margin:-6px 0 6px}
.hud{border:1px solid var(--c-line);border-radius:var(--rad);padding:18px;background:color-mix(in srgb,var(--c-paper) 5%,transparent);font-family:var(--f-mono);font-size:.84rem}
.hud__head{display:flex;gap:12px;align-items:center;margin-bottom:14px}
.hud__sigil{font-size:1.7rem;color:var(--c-accent);line-height:1}
.hud__name{font-family:var(--f-display);font-size:1.25rem;font-weight:600}
.hud__sub{color:color-mix(in srgb,var(--c-paper) 65%,transparent);font-size:.78rem}
.bar{margin:8px 0}
.bar__label{display:flex;justify-content:space-between;font-size:.74rem;letter-spacing:.04em;text-transform:uppercase;color:color-mix(in srgb,var(--c-paper) 68%,transparent);margin-bottom:3px}
.bar__track{height:9px;border-radius:6px;background:color-mix(in srgb,var(--c-paper) 10%,transparent);overflow:hidden}
.bar__fill{height:100%;background:var(--c-accent);border-radius:6px}
.bar__fill--hp{background:linear-gradient(90deg,#cf4b3a,#e0843a)}
.hud__ac{margin:10px 0;font-size:.92rem}
.hud__stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0}
.stat{border:1px solid var(--c-line);border-radius:8px;padding:7px;text-align:center}
.stat__k{display:block;font-size:.66rem;letter-spacing:.08em;color:color-mix(in srgb,var(--c-paper) 60%,transparent)}
.stat__v{font-family:var(--f-display);font-size:1.3rem;font-weight:600;display:block}
.stat__m{font-size:.74rem;color:var(--c-accent)}
.hud__bound{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.hud__bound-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:color-mix(in srgb,var(--c-paper) 60%,transparent);width:100%}
.chip{display:inline-block;font-family:var(--f-mono);font-size:.72rem;border:1px solid var(--c-line);border-radius:999px;padding:2px 9px;color:var(--c-accent)}
.hud__note{margin-top:12px;font-size:.72rem;color:color-mix(in srgb,var(--c-paper) 55%,transparent)}

.ch-list{display:flex;flex-direction:column;gap:2px}
.ch-item{display:flex;gap:16px;align-items:flex-start;padding:16px 14px;border:1px solid transparent;border-bottom:1px solid var(--c-line);color:var(--c-paper)}
.ch-item:hover{text-decoration:none;background:color-mix(in srgb,var(--c-paper) 5%,transparent);border-radius:10px;border-color:var(--c-line)}
.ch-item__n{font-family:var(--f-display);font-size:1.5rem;color:var(--c-accent);min-width:40px}
.ch-item__body{display:flex;flex-direction:column;gap:2px}
.ch-item__title{font-family:var(--f-display);font-size:1.16rem;font-weight:600}
.ch-item__when{font-size:.8rem;color:color-mix(in srgb,var(--c-paper) 60%,transparent)}
.ch-item__teaser{color:color-mix(in srgb,var(--c-paper) 80%,transparent);font-size:.95rem}
.ch-item__conv{margin-left:auto;font-family:var(--f-mono);font-size:.72rem;color:var(--c-accent);white-space:nowrap}

.chapter{max-width:760px;margin:30px auto 0}
.chapter__head{margin-bottom:22px;border-bottom:1px solid var(--c-line);padding-bottom:20px}
.chapter__act{font-family:var(--f-display);text-transform:uppercase;letter-spacing:.16em;font-size:.74rem;color:var(--c-accent);margin:0 0 8px}
.chapter__title{font-size:clamp(1.9rem,4vw,2.8rem);margin:0 0 8px}
.chapter__when{color:color-mix(in srgb,var(--c-paper) 62%,transparent);font-size:.92rem;margin:0}
.chapter__tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
.chapter__body>*{margin:0 0 4px}
.panel{padding:8px 0;font-size:1.08rem}
.panel--tone{font-size:1.16rem;color:color-mix(in srgb,var(--c-paper) 92%,transparent)}
.bubble{margin:18px 0;padding:14px 16px 12px;border-left:3px solid var(--c-accent);background:color-mix(in srgb,var(--c-paper) 5%,transparent);border-radius:0 10px 10px 0}
.bubble__who{display:block;font-family:var(--f-display);text-transform:uppercase;letter-spacing:.1em;font-size:.72rem;color:var(--c-accent);margin-bottom:5px}
.bubble__say{font-style:italic} .bubble__say p{margin:0 0 8px}
.sfx{font-family:var(--f-display);font-weight:700;letter-spacing:.1em;font-size:1.5rem;color:var(--c-accent);text-align:center;margin:18px 0;opacity:.85}
.cap{margin:22px 0;padding:14px 18px;border:1px dashed var(--c-line);border-radius:10px;font-style:italic;color:color-mix(in srgb,var(--c-paper) 76%,transparent);font-size:.98rem;text-align:center}

.ooc{margin:22px 0;border:1px solid var(--c-accent);border-radius:12px;overflow:hidden;
  background:color-mix(in srgb,var(--c-accent) 9%,var(--c-night));font-family:var(--f-mono);font-size:.86rem}
.ooc__label{display:flex;align-items:center;gap:8px;padding:8px 14px;background:color-mix(in srgb,var(--c-accent) 16%,transparent);
  border-bottom:1px solid var(--c-accent);font-size:.74rem;letter-spacing:.08em;text-transform:uppercase}
.ooc__tag{font-weight:700;color:var(--c-accent)} .ooc__type{color:color-mix(in srgb,var(--c-paper) 80%,transparent)}
.ooc__sigil{margin-left:auto;color:var(--c-accent)} .ooc__body{padding:12px 16px}
.ooc__body p{margin:0 0 10px} .ooc__body ol,.ooc__body ul{margin:6px 0;padding-left:22px} .ooc__body li{margin:4px 0}
.ooc__body blockquote{margin:10px 0;padding-left:12px;border-left:2px solid var(--c-accent);color:color-mix(in srgb,var(--c-paper) 75%,transparent)}

.conv-row{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0}
.conv-row--foot{margin-top:30px}
.conv-card{display:flex;gap:12px;align-items:center;padding:14px 16px;border:1px solid var(--c-accent);border-radius:12px;
  background:color-mix(in srgb,var(--c-accent) 8%,transparent);color:var(--c-paper);font-size:.92rem;flex:1;min-width:260px}
.conv-card:hover{text-decoration:none;filter:brightness(1.06)}
.conv-card__sigil{font-size:1.5rem;color:var(--c-accent)}

.enginelog{margin:34px 0;border:1px solid var(--c-line);border-radius:12px;background:color-mix(in srgb,var(--c-paper) 4%,transparent)}
.enginelog>summary{cursor:pointer;padding:14px 18px;font-family:var(--f-display);letter-spacing:.04em;list-style:none}
.enginelog>summary::-webkit-details-marker{display:none}
.enginelog__sigil{color:var(--c-accent);margin-right:8px}
.enginelog[open]>summary{border-bottom:1px solid var(--c-line)}
.enginelog__body{padding:16px 18px;font-family:var(--f-mono);font-size:.84rem}
.elog__row{padding:12px 0;border-bottom:1px solid var(--c-line)}
.elog__h{font-weight:600;color:var(--c-paper);margin-bottom:8px}
.elog__hash{color:color-mix(in srgb,var(--c-paper) 50%,transparent);font-size:.76rem;font-weight:400;margin-left:6px}
.elog__sec{margin:8px 0} .elog__sec h5{margin:6px 0 4px;font-family:var(--f-display);font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;color:var(--c-accent)}
.elog__sec ul,.elog__sec ol{margin:4px 0;padding-left:20px} .elog__sec li{margin:3px 0}
.elog__tbl{width:100%;border-collapse:collapse;font-size:.78rem} .elog__tbl th,.elog__tbl td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--c-line)}
.elog__raw{margin-top:12px} .elog__raw pre{overflow:auto;max-height:340px;background:var(--c-night);padding:12px;border-radius:8px;font-size:.74rem;border:1px solid var(--c-line)}
.conf{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;padding:1px 7px;border-radius:999px;border:1px solid currentColor}
.conf--commit,.conf--ok,.conf--high{color:#5cba6b} .conf--partial{color:var(--c-accent)} .conf--unknown,.conf--error,.conf--reject_inert{color:#cf6a5a}

.ch-nav{display:flex;justify-content:space-between;gap:12px;margin:30px 0 0;padding-top:18px;border-top:1px solid var(--c-line);font-family:var(--f-display);font-size:.86rem}
.ch-nav__toc{color:color-mix(in srgb,var(--c-paper) 65%,transparent)}
.prose-col{max-width:740px;margin:10px auto} .prose-col h2{margin:34px 0 10px;font-size:1.4rem}

.timeline{list-style:none;padding:0;max-width:820px}
.tl-node{border-left:2px solid var(--c-accent);padding:0 0 30px 26px;position:relative}
.tl-node::before{content:"◆";position:absolute;left:-11px;top:-2px;color:var(--c-accent)}
.tl-node__date{font-family:var(--f-display);text-transform:uppercase;letter-spacing:.1em;font-size:.82rem;color:var(--c-accent)}
.tl-node__title{font-family:var(--f-display);font-size:1.5rem;margin:4px 0 6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.conv-badge{font-family:var(--f-mono);font-size:.7rem;color:var(--c-accent);border:1px solid var(--c-accent);border-radius:999px;padding:1px 9px}
.tl-node__lede{color:color-mix(in srgb,var(--c-paper) 82%,transparent);max-width:680px}
.tl-node__interiors{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}
.tl-interior{display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid var(--c-line);border-left:3px solid var(--card-accent);border-radius:10px;color:var(--c-paper);font-size:.9rem;flex:1;min-width:260px}
.tl-interior:hover{text-decoration:none;border-color:var(--card-accent)}
.tl-interior__sigil{font-size:1.3rem;color:var(--card-accent)}
`;

build();
