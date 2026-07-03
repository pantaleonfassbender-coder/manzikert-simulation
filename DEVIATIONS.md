# Deviations & Local Runner — Methods Record

**Study:** *Synthetic Delusion in Agentic Deadlock* (AsPredicted preregistration
[#298725](https://aspredicted.org/qs6t7v.pdf)). This file documents, for the
methods section, every change made to the implementation after preregistration
and how to reproduce the dataset locally. The registered design (KPIs, 100 AP
across Military/Diplomacy/Internal, 12 rounds, 3 models, rotation every 100
games, N = 300) is unchanged.

## 1. Data collection moved from Netlify to a local runner

The original implementation collected data through Netlify background functions.
That path proved unreliable at the required scale: Netlify background functions
have a 15-minute execution ceiling that a 10-game batch exceeds, and the
`list-games` function loaded every game blob into memory at once (compounded by
an exponentially-nested `stateAfter` record, ~28 MB/game). Data collection was
therefore moved to a standalone Node script, **`manzikert-run.mjs`**, which
imports the *same* engine logic (a faithful port of `src/engine/*`, matching
`ENGINE_SPEC.md`) but removes the Netlify Functions / Blobs / timeout
constraints. The deterministic engine, per-round resolution, role rotation, and
data-integrity rules are identical to the registered design.

### Running it
```bash
# Set direct provider keys (kept out of git — see .gitignore):
#   OPENAI_API_KEY / OPENAI_BASE_URL=https://api.openai.com
#   ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL=https://api.anthropic.com
#   GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL=https://generativelanguage.googleapis.com

node manzikert-run.mjs --mode real --games 1                    # smoke test
node manzikert-run.mjs --mode real --games 300 --out manzikert-full   # full dataset
```
Modes: `stub` (no API, pipeline test), `gemini-only` (pipeline test, NOT valid
study data), `real` (registered rotation, needs all three keys). The run is
resumable: `--start N` appends to the existing CSVs from game index N.
`diagnose-apis.mjs` is a one-call-per-provider connectivity probe.

Output (analysis-ready, one file per registered analysis):
- `round_data.csv` — one row per (game, round, faction): AP allocation, post-round
  KPI state, and the self-assessment text → **H1** (feed `SelfAssessment` to LIWC-22).
- `messages.csv` — diplomatic "cheap talk" paired with the sender's AP → **H2** (Deception Index).
- `summaries.csv` — per-game outcome and which model played which faction.

## 2. Prompt / validation changes (pre-data)

These were made **before any study data were collected** and applied uniformly to
all three models, so they do not privilege any model (relevant to H3).

- **Self-assessment length:** the mandatory self-assessment is now specified as a
  single **80–120 word** paragraph (was "2–3 sentences"). Rationale: LIWC-22
  category percentages (especially low-base-rate Negative Emotion / Anxiety, the
  H1 DVs) are unstable on very short text.
- **Mandatory diplomatic message:** each turn must include **at least one**
  non-empty message to another faction, so every turn yields "cheap talk" for the
  H2 Deception Index.
- **Validation floor:** a response is rejected as malformed (and retried, then the
  game discarded/re-run per registered Q6) if the self-assessment is below
  **60 words** or has no message. The floor is deliberately set *below* the
  requested 80 words: hard-rejecting every 70–79 word reply would selectively
  discard the more terse models and bias the LIWC sample against exactly the
  cross-model differences H3 measures. Change `MIN_SELF_ASSESSMENT_WORDS` in
  `src/engine/llmClients.ts` / `manzikert-run.mjs` to adjust.

## 3. Engine deviation (already recorded in ENGINE_SPEC.md §3)

The Doukas ("Foes") were given a dynamic **Court Influence** KPI (stored in
`internalLoyalty`) and diplomacy was made mechanically active, so that H1's
"KPI dropping below 20/100" is testable for all three faction roles. Made before
data collection; win conditions are unchanged from the registered design.

## 4. Model identifiers

`openai: gpt-5.5`, `gemini: gemini-3.1-pro-preview`, `claude: claude-opus-4-8`
(`src/engine/models.ts`), all run at provider-default settings (no reasoning
throttling) to keep the three-model comparison fair for H3.

## 5. Robustness & generalization arms (preregistered exploratory; opt-in)

Two exploratory arms, run **outside** the confirmatory N = 300 and reported
separately. See `AsPredicted_Addendum_Robustness.md`. The confirmatory default
(`--scenario byzantine`, three proprietary models) is **byte-for-byte unchanged**.

- **Scenario invariance** (`--scenario byzantine_swap|galactic`): the identical
  engine re-skinned into a name-swapped medieval frame and a fully fictional,
  outcome-unknown interstellar frame. Mechanics, KPI dynamics, AP categories, and
  the JSON schema are unchanged; engine event strings are relabelled so no original
  proper nouns leak into later prompts. The fictional frame also controls for the
  models possibly having memorized the real Manzikert outcome. Analyzed as a
  scenario × KPI moderation test on the H1 markers.
- **Open-weight model** (`--mode compat-only`): substitutes one open-weight model
  (all three seats) via a generic OpenAI-compatible endpoint. Env:
  `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_MODEL`
  (set `OPENAI_COMPAT_JSON=0` if a model rejects JSON mode). Works with a local
  server (LM Studio) or a hosted endpoint (Groq/Together/Fireworks/OpenRouter).
  Compared descriptively against the three proprietary models; H3 remains
  descriptive-of-these-systems, not a general architectural inference.

Dev helper: `node manzikert-run.mjs --scenario <name> --print-prompt` dumps sample
round-1 and round-2 prompts for inspection.
