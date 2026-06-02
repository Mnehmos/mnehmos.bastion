#!/usr/bin/env node
// Bastion narrator — hash-gated OpenAI TTS, per-biography voice (website-spec §5.5, PUBLISHING.md §3b).
//
// For each chapter: extract narration-ready text (strip [OOC]/sfx, flatten bubbles
// to "Speaker: …", keep prose + captions), hash it, and re-synthesize ONLY when the
// hash changed. Voice + tone come from themes/theme-<slug>.yaml (voice / voice_notes).
//
// Storage: mp3 + .hashes.json live in the SOURCE tree at
//   bastion/biographies/<slug>/audio/<id>.mp3
// so a clean `build-site` rebuild never forces a paid re-synthesis; build-site copies
// them into docs/. Re-voicing an unchanged chapter is a bug, not a no-op-with-cost.
//
// Usage:  node scripts/narrate.mjs            (all chapters, changed only)
//         node scripts/narrate.mjs --force    (re-voice everything)
//         node scripts/narrate.mjs operator   (one biography)

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIO_DIR = join(ROOT, 'bastion', 'biographies');
const THEME_DIR = join(ROOT, 'themes');

const MODEL = process.env.BASTION_TTS_MODEL || 'gpt-4o-mini-tts'; // supports steerable voices incl. sage
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const onlySlug = args.find(a => !a.startsWith('--'));

// ───────── OpenAI key (env, or the engine repo's .env) ─────────
function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  for (const p of [join(ROOT, '.env'), 'F:/Github/mnehmos.rpg.mcp/.env']) {
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/^\s*OPENAI_API_KEY\s*=\s*["']?([^"'\r\n]+)/m);
      if (m) return m[1].trim();
    }
  }
  return null;
}
const KEY = loadKey();

// ───────── tiny YAML (voice + voice_notes only) ─────────
function themeVoice(slug) {
  const f = join(THEME_DIR, `theme-${slug}.yaml`);
  if (!existsSync(f)) return { voice: 'onyx', voice_notes: '' };
  const text = readFileSync(f, 'utf8');
  const voice = (text.match(/^voice:\s*["']?([A-Za-z0-9_-]+)/m) || [])[1] || 'onyx';
  let notes = '';
  const nm = text.match(/^voice_notes:\s*\|\s*\n([\s\S]*?)(?=^\S|\Z)/m);
  if (nm) notes = nm[1].split(/\r?\n/).map(l => l.replace(/^\s{0,2}/, '')).join(' ').trim();
  return { voice, voice_notes: notes };
}

// ───────── narration-text extraction (strip DSL/OOC, flatten bubbles) ─────────
function stripFrontMatter(md) { const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/); return m ? m[1] : md; }
function deMarkdown(s) {
  return s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1').replace(/^\s*>\s?/g, '').replace(/^\s*[-*]\s+/g, '').replace(/^\s*\d+\.\s+/g, '');
}
function narrationText(md) {
  const body = stripFrontMatter(md);
  const lines = body.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^\s*(\[OOC\]\s*)?:::\s*([A-Za-z0-9_-]+)\s*(.*)$/);
    if (open && !/^\s*:::\s*$/.test(lines[i])) {
      const ooc = !!open[1], type = open[2], rest = (open[3] || '').trim();
      const who = (rest.match(/who="([^"]*)"/) || [])[1] || '';
      const buf = []; i++;
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      if (ooc || type === 'sfx') continue; // skip mechanical + sound-effect blocks for the listen
      const text = buf.map(deMarkdown).join('\n').replace(/\n{2,}/g, '\n\n').trim();
      if (!text) continue;
      if (type === 'bubble' && who) out.push(`${who}: ${text}`);
      else out.push(text);
    } else { i++; }
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ───────── chunk to TTS input limit (~4096 chars) on paragraph breaks ─────────
function chunk(text, max = 3800) {
  const paras = text.split(/\n\n+/);
  const chunks = []; let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > max && cur) { chunks.push(cur); cur = p; }
    else cur = cur ? cur + '\n\n' + p : p;
    while (cur.length > max) { chunks.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function synth(input, voice, instructions) {
  const body = { model: MODEL, voice, input, response_format: 'mp3' };
  if (instructions) body.instructions = instructions;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`TTS ${res.status}: ${t.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  if (!KEY) { console.error('No OPENAI_API_KEY (env or .env). Aborting — refusing to pretend audio was made.'); process.exit(1); }
  const slugs = readdirSync(BIO_DIR).filter(s => statSync(join(BIO_DIR, s)).isDirectory() && (!onlySlug || s === onlySlug));
  let voiced = 0, skipped = 0;
  for (const slug of slugs) {
    const chDir = join(BIO_DIR, slug, 'chapters');
    if (!existsSync(chDir)) continue;
    const { voice, voice_notes } = themeVoice(slug);
    const audioDir = join(BIO_DIR, slug, 'audio');
    mkdirSync(audioDir, { recursive: true });
    const hashFile = join(audioDir, '.hashes.json');
    const hashes = existsSync(hashFile) ? JSON.parse(readFileSync(hashFile, 'utf8')) : {};
    for (const f of readdirSync(chDir).filter(x => x.endsWith('.md')).sort()) {
      const id = f.replace(/\.md$/, '');
      const md = readFileSync(join(chDir, f), 'utf8');
      const text = narrationText(md);
      const h = createHash('sha256').update(`${MODEL}|${voice}|${text}`).digest('hex');
      const mp3Path = join(audioDir, `${id}.mp3`);
      if (!FORCE && hashes[id] === h && existsSync(mp3Path)) { skipped++; console.log(`  skip  ${slug}/${id} (unchanged)`); continue; }
      const chunks = chunk(text);
      console.log(`  voice ${slug}/${id} → ${voice} · ${text.length} chars · ${chunks.length} chunk(s)…`);
      const bufs = [];
      for (const c of chunks) bufs.push(await synth(c, voice, voice_notes));
      writeFileSync(mp3Path, Buffer.concat(bufs));
      hashes[id] = h; voiced++;
    }
    writeFileSync(hashFile, JSON.stringify(hashes, null, 2));
  }
  console.log(`Narration done: ${voiced} voiced, ${skipped} unchanged.`);
}
main().catch(e => { console.error('narrate failed:', e.message); process.exit(1); });
