import type { GameState, ActionAllocation, Faction, RoundRecord } from './types';

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export function createInitialState(gameId: string): GameState {
  return {
    gameId,
    currentRound: 1,
    factions: {
      // Emperor: territory + loyalty are his objective KPIs.
      emperor: { militaryStrength: 100, internalLoyalty: 50, territoryControl: 100 },
      // Foes (Doukas): internalLoyalty is repurposed as their "Court Influence"
      // KPI and starts at 50 so it has room to plunge below 20 when they lose.
      foes: { militaryStrength: 20, internalLoyalty: 50, territoryControl: 0 },
      // Seljuks: territoryControl (mirror of the Emperor's) is their objective KPI.
      seljuks: { militaryStrength: 80, internalLoyalty: 100, territoryControl: 0 },
    },
    history: [],
    winner: null,
  };
}

export function resolveRound(state: GameState, allocations: Record<Faction, ActionAllocation>): GameState {
  const events: string[] = [];

  // Clone current state for mutating
  const nextState: GameState = JSON.parse(JSON.stringify(state));

  const emperorInternal = allocations.emperor.internal;
  const foesInternal = allocations.foes.internal;

  // 0. Diplomacy — Foes↔Seljuk coordination vs. Emperor counter-diplomacy.
  // Foes and Seljuks who BOTH invest diplomacy coordinate a combined assault;
  // the weaker of the two investments sets the coalition strength. The Emperor
  // spends diplomacy to fracture that coalition.
  const coord = Math.min(allocations.foes.diplomacy, allocations.seljuks.diplomacy) / 100;
  const netCoord = clamp(coord - 0.5 * (allocations.emperor.diplomacy / 100), 0, 1);

  if (netCoord > 0) {
    events.push(`Foes–Seljuk coordination is at ${(netCoord * 100).toFixed(0)}% effectiveness this round.`);
  }

  // 1. Internal Politics & Loyalty (Emperor)
  // Foes spend internal to drop Emperor's loyalty. Emperor spends internal to raise it.
  const loyaltyChange = (emperorInternal * 0.5) - (foesInternal * 0.8);
  nextState.factions.emperor.internalLoyalty = clamp(nextState.factions.emperor.internalLoyalty + loyaltyChange);

  events.push(`Emperor's loyalty changed by ${loyaltyChange.toFixed(1)} to ${nextState.factions.emperor.internalLoyalty.toFixed(1)}.`);

  // 1b. Foes "Court Influence" (their objective KPI). The Doukas gain influence
  // by investing in court politics and by coordinating successfully, and lose it
  // when the Emperor out-politicks them.
  const foesInfluenceChange = (foesInternal * 0.5) - (emperorInternal * 0.5) + (netCoord * 5);
  nextState.factions.foes.internalLoyalty = clamp(nextState.factions.foes.internalLoyalty + foesInfluenceChange);

  events.push(`Doukas court influence changed by ${foesInfluenceChange.toFixed(1)} to ${nextState.factions.foes.internalLoyalty.toFixed(1)}.`);

  // 2. Military Conflict
  // Emperor's effective military is modified by loyalty.
  const emperorLoyaltyMod = nextState.factions.emperor.internalLoyalty / 100;
  const emperorEffectiveMil = allocations.emperor.military * emperorLoyaltyMod;

  const seljukMil = allocations.seljuks.military;
  const foesMil = allocations.foes.military;

  // Foes military sabotages the Emperor; coordination amplifies the damage.
  const foesSabotage = foesMil * 0.5 * (1 + netCoord);
  const finalEmperorMil = Math.max(0, emperorEffectiveMil - foesSabotage);

  // Seljuk assault is amplified by coordination with the Foes.
  const seljukEffectiveMil = seljukMil * (1 + 0.5 * netCoord);

  const territoryChange = (finalEmperorMil - seljukEffectiveMil) * 0.2;
  nextState.factions.emperor.territoryControl = clamp(nextState.factions.emperor.territoryControl + territoryChange);
  nextState.factions.seljuks.territoryControl = 100 - nextState.factions.emperor.territoryControl;

  events.push(`Emperor's effective military defense was ${finalEmperorMil.toFixed(1)} against a Seljuk assault of ${seljukEffectiveMil.toFixed(1)}. Territory control shifted by ${territoryChange.toFixed(1)}.`);

  if (foesSabotage > 0) {
    events.push(`Foes sabotaged the Emperor's military with ${foesSabotage.toFixed(1)} effective damage.`);
  }

  // Check win condition
  if (nextState.currentRound === 12) {
    if (nextState.factions.emperor.territoryControl > 50 && nextState.factions.emperor.internalLoyalty > 20) {
       nextState.winner = 'emperor';
       events.push("Game Over: Emperor Romanos survives and holds the frontier.");
    } else if (nextState.factions.emperor.territoryControl <= 50) {
       nextState.winner = 'seljuks';
       events.push("Game Over: Seljuks have conquered the frontier (Mantzikert).");
    } else {
       nextState.winner = 'foes';
       events.push("Game Over: Emperor holds territory but is overthrown by internal foes.");
    }
  }

  // Save the round record
  const record: RoundRecord = {
    round: nextState.currentRound,
    allocations,
    events,
    stateAfter: JSON.parse(JSON.stringify(nextState)),
  };

  nextState.history.push(record);
  nextState.currentRound += 1;

  return nextState;
}
