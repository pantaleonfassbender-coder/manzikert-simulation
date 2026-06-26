import type { GameState, ActionAllocation, Faction, RoundRecord } from './types';

export function createInitialState(gameId: string): GameState {
  return {
    gameId,
    currentRound: 1,
    factions: {
      emperor: { militaryStrength: 100, internalLoyalty: 50, territoryControl: 100 },
      foes: { militaryStrength: 20, internalLoyalty: 80, territoryControl: 0 },
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
  
  // 1. Internal Politics & Loyalty
  // Foes spend internal to drop Emperor's loyalty. Emperor spends internal to raise it.
  const emperorInternal = allocations.emperor.internal;
  const foesInternal = allocations.foes.internal;
  
  const loyaltyChange = (emperorInternal * 0.5) - (foesInternal * 0.8);
  nextState.factions.emperor.internalLoyalty = Math.max(0, Math.min(100, nextState.factions.emperor.internalLoyalty + loyaltyChange));
  
  events.push(`Emperor's loyalty changed by ${loyaltyChange.toFixed(1)} to ${nextState.factions.emperor.internalLoyalty.toFixed(1)}.`);

  // 2. Military Conflict
  // Emperor's effective military is modified by loyalty.
  const emperorLoyaltyMod = nextState.factions.emperor.internalLoyalty / 100;
  const emperorEffectiveMil = allocations.emperor.military * emperorLoyaltyMod;
  
  const seljukMil = allocations.seljuks.military;
  const foesMil = allocations.foes.military; 

  // Foes military sabotages the Emperor's military effective output
  const foesSabotage = foesMil * 0.5;
  const finalEmperorMil = Math.max(0, emperorEffectiveMil - foesSabotage);

  const territoryChange = (finalEmperorMil - seljukMil) * 0.2; 
  nextState.factions.emperor.territoryControl = Math.max(0, Math.min(100, nextState.factions.emperor.territoryControl + territoryChange));
  nextState.factions.seljuks.territoryControl = 100 - nextState.factions.emperor.territoryControl;

  events.push(`Emperor's effective military defense was ${finalEmperorMil.toFixed(1)} against Seljuk attack of ${seljukMil}. Territory control shifted by ${territoryChange.toFixed(1)}.`);

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

  // Save the round record. Note: we intentionally do not snapshot the full
  // state here — doing so nested every prior round's snapshot and grew the
  // payload exponentially (~9MB by round 12), blowing past the function
  // request/response size limit and breaking later rounds.
  const record: RoundRecord = {
    round: nextState.currentRound,
    allocations,
    events,
  };
  
  nextState.history.push(record);
  nextState.currentRound += 1;
  
  return nextState;
}
