# mnehmos.bastion

**This is the publication repo for Bastion.** Reader-facing only — the static site, the chapters, the themes, the narration, the published `docs/`. The game engine that produces the committed state behind every page lives in a separate repository.

## Repo split — engine as moat, publication as product

Bastion is deliberately split into two repos so the audiences, lifecycles, and trust surfaces stay clean:

- **Engine repo (the moat):** [`mnehmos.rpg.mcp`](https://github.com/Mnehmos/mnehmos.rpg.mcp) — the rpg-mcp game engine, the LLM-driven NPC runtime, the ledger, the committed-state spine. This is where the dice actually roll and where every event Bastion publishes is first committed. Closed to readers; primary surface for builders.
- **Publication repo (the product — this repo):** the static site at `docs/` (served via GitHub Pages), the per-biography content under `bastion/biographies/<slug>/`, the exported ledger snippets under `ledger/<slug>/`, the per-biography themes, and the build + narrate scripts.

The split is the **engine-as-moat / publication-as-product** principle: the engine is the trust spine ("every die rolled by the engine," "every event committed by the System"), but the reader experience is a clean novel — the moat is a feature they can opt into via the collapsible Engine Log, never the foreground.

## Where the lore beats live

The narrative scaffolding — the LitRPG-cohort decisions, the Operator-is-Mnehmos beat, the founding rite of Sebastopyr, the spawn prompts, the system charter — lives in the engine repo under `docs/bastion/` (and the top-level `bastion-*.md` specs). This repo consumes the *output* of those decisions (chapters, engine logs, theme tokens); it does not host the design docs themselves.

Key references in the engine repo:
- `bastion-specification.md` — architecture spec.
- `SYSTEM.md` — the adjudicating LLM's operating charter.
- `bastion-opening-prompts.md` — the Operator and Mnehmos spawn prompts. The **Operator-is-Mnehmos** binding is wired here (and recorded at spawn time as a `secret_manage` entry).
- `bastion-website-spec.md` — the spec this repo's frame implements.
- `bastion-deliverables.md` — the master manifest; the **LitRPG cohort** decision is recorded there (popular LitRPG tropes; max-2 concurrent writers).
- `PUBLISHING.md` — the canonical publish workflow this repo follows.

## Layout

```
bastion/biographies/      per-biography content (front-matter + prose)
  mnehmos/chapters/         the devlog / summoner biography
  operator/chapters/        the Operator biography
ledger/                   exported engine-log JSON per chapter
themes/                   per-biography theme token sets
  theme-operator.yaml
  theme-mnehmos.yaml
scripts/
  build-site.mjs            renders content + themes + ledger -> docs/
  narrate.mjs               hash-gated OpenAI TTS per chapter
docs/                     the published site (GitHub Pages target)
PUBLISHING.md             pointer to the canonical workflow in the engine repo
```

## Publishing

This repo follows the publishing workflow defined in the engine repo:
[PUBLISHING.md](https://github.com/Mnehmos/mnehmos.rpg.mcp/blob/main/PUBLISHING.md).

Summary: play in rpg-mcp -> export chapter + engine log here -> `node scripts/build-site.mjs` -> (when prose final) `node scripts/narrate.mjs` -> review `docs/` -> commit + push -> Pages serves `docs/`.

Two invariants worth re-stating:
- **`docs/` is generated.** Never hand-edit a file under `docs/`.
- **Narration is hash-gated.** `narrate.mjs` never re-voices an unchanged chapter.
