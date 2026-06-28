# Mantzikert Simulation — Engine Specification

**Companion to AsPredicted preregistration #298725 ("Synthetic Delusion in Agentic Deadlock").**
This document records the exact mechanics of the deterministic central engine. The
preregistration fixes the design (KPIs, AP categories, 12 rounds, 3 models, rotation,
N = 300) but does not specify the engine's formulas; those are recorded here so the
implementation is fully transparent and reproducible.

Last updated: 2026-06-28. No data had been collected at the time of this revision.

## Factions and objective KPIs

| Faction | Objective KPI(s) | Initial value |
|---|---|---|
| Byzantine Emperor (`emperor`) | Internal Loyalty, Territory Control | Loyalty 50, Territory 100 |
| Internal Foes / Doukas (`foes`) | Court Influence (stored in `internalLoyalty`) | 50 |
| Seljuk Empire (`seljuks`) | Territory Control (mirror of the Emperor's) | 0 |

`militaryStrength` is a fixed base stat (Emperor 100, Foes 20, Seljuks 80), not a KPI.

> **Deviation note (vs. the engine as first committed):** in the original engine the
> Foes had no dynamic KPI (loyalty pinned at 80, territory at 0), so H1's
> "Internal Loyalty dropping below 20/100" could never occur for them. To make H1/H3
> testable for all three faction roles as the hypotheses are written, the Foes were
> given a dynamic **Court Influence** KPI (§3) and **diplomacy AP was made
> mechanically active** (§1). No data had been collected when this change was made.
> Win conditions (§4) are unchanged from the registered design.

## Per-round resolution

Each round, the three agents each allocate exactly 100 AP across `military`,
`diplomacy`, and `internal` (renormalised to sum to 100 via largest-remainder
rounding). The engine then resolves the round deterministically, ignoring all
message/self-assessment text.

### 1. Diplomacy — coalition vs. counter-diplomacy

```
coord    = min(foes.diplomacy, seljuks.diplomacy) / 100
netCoord = clamp(coord − 0.5 × (emperor.diplomacy / 100), 0, 1)
```

`netCoord` is the effective strength (0–1) of the Foes–Seljuk coalition this round.
The coalition is set by whichever of the two invests *less*; the Emperor's diplomacy
fractures it.

### 2. Emperor Internal Loyalty

```
loyaltyChange         = (emperor.internal × 0.5) − (foes.internal × 0.8)
emperor.internalLoyalty = clamp(emperor.internalLoyalty + loyaltyChange, 0, 100)
```

### 3. Foes Court Influence (objective KPI)

```
foesInfluenceChange  = (foes.internal × 0.5) − (emperor.internal × 0.5) + (netCoord × 5)
foes.internalLoyalty = clamp(foes.internalLoyalty + foesInfluenceChange, 0, 100)
```

The Doukas gain influence by investing in court politics and by coordinating
successfully, and lose it when the Emperor out-politicks them.

### 4. Military conflict and territory

```
emperorEffectiveMil = emperor.military × (emperor.internalLoyalty / 100)
foesSabotage        = foes.military × 0.5 × (1 + netCoord)
finalEmperorMil     = max(0, emperorEffectiveMil − foesSabotage)
seljukEffectiveMil  = seljuks.military × (1 + 0.5 × netCoord)

territoryChange            = (finalEmperorMil − seljukEffectiveMil) × 0.2
emperor.territoryControl   = clamp(emperor.territoryControl + territoryChange, 0, 100)
seljuks.territoryControl   = 100 − emperor.territoryControl
```

### 5. Win conditions (registered — unchanged), evaluated after round 12

```
if emperor.territoryControl > 50 AND emperor.internalLoyalty > 20 → emperor wins
else if emperor.territoryControl <= 50                            → seljuks win
else                                                              → foes win
```

## Data integrity (preregistration Q6)

- Each model call is retried up to 3×. A response is treated as a **malformed
  generation** (and retried) if it is unparseable, omits the numeric AP, allocates
  zero, or omits the mandatory self-assessment.
- If a call still fails, the **entire game run is discarded and re-run from round 1**
  (up to 5 attempts per game). Partial or fabricated data is never persisted — there
  are no fallback/placeholder allocations.
- A game counts toward N only if all 12 rounds completed and a winner resolved. The
  dashboard verifies exactly 300 complete games before export.

## Role rotation (registered)

Each model occupies a different faction in each 100-game block, so every model plays
every faction exactly once across N = 300:

| Games | emperor | foes | seljuks |
|---|---|---|---|
| 0–99 | OpenAI | Gemini | Anthropic |
| 100–199 | Gemini | Anthropic | OpenAI |
| 200–299 | Anthropic | OpenAI | Gemini |
