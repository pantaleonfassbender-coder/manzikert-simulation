# Preregistration Addendum — Robustness & Generalization Arms

**Study:** Synthetic Delusion in Agentic Deadlock (AsPredicted #298725)
**Addendum filed:** [DATE — before any data collection]
**Status:** Exploratory arms, additional to (not replacing) the registered confirmatory design.

This addendum adds two preregistered **exploratory** arms, run **outside** the confirmatory
N = 300 dataset and analyzed separately. The registered confirmatory design (three foundation
models, 12 rounds, 3 factions, 100 AP, rotation every 100 games, N = 300) is unchanged.

## 1. Motivation
Two threats to generality: (a) that any effect is an artifact of the specific 1071 Manzikert
vignette or its proper nouns, including the models' possible *memorization of the real
historical outcome*; and (b) that effects are specific to the three proprietary foundation models.

## 2. Arm A — Scenario invariance
The identical deterministic engine (all mechanics, KPI dynamics, AP categories, and response
schema unchanged) is re-skinned into two alternative narrative frames:
- **Name-swap** (`byzantine_swap`): same medieval domain, all proper nouns altered.
- **Fictional re-skin** (`galactic`): an interstellar succession crisis with no known real-world
  outcome (controls for historical memorization).

**Plan:** ~40–50 complete games per variant (each game = 36 agent turns), using the same three
foundation models under the registered rotation.

## 3. Arm B — Open-weight model
One open-weight model (queried via an OpenAI-compatible endpoint) is substituted into all three
faction roles under the base scenario, to test whether effects are specific to the proprietary
models. **Plan:** ~40–50 complete games.

## 4. Analyses (exploratory)
- **Scenario invariance:** add *scenario variant* as a factor to the H1 mixed-effects model and
  test the **scenario × KPI interaction**. A non-significant interaction indicates the
  KPI→language coupling is invariant to the narrative frame.
- **Open-weight comparison:** compare the open-weight model **descriptively** against the three
  proprietary models on the same KPI–language mismatch metric.
- Because only three foundation models enter the confirmatory design, all cross-model (H3)
  claims are treated as descriptive of these systems, not as inferences about architectures
  in general.

## 5. Exclusions / integrity
Identical to the main study (discard-and-re-run on API failure or malformed generation;
80–120 word self-assessment with a 60-word rejection floor; ≥1 diplomatic message per turn).

## 6. Reproducibility
Implemented in the open-source runner as `--scenario {byzantine_swap|galactic}` and
`--mode compat-only`. Engine and confirmatory prompts are unchanged; the byzantine default is
byte-for-byte identical to the registered design.
