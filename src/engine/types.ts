export type Faction = 'emperor' | 'foes' | 'seljuks';
export type ModelProvider = 'openai' | 'gemini' | 'claude';

export interface FactionState {
  militaryStrength: number;
  internalLoyalty: number;
  territoryControl: number;
}

export interface ActionAllocation {
  military: number;
  diplomacy: number;
  internal: number;
  messages: Partial<Record<Faction, string>>;
  selfAssessment: string;
}

export interface RoundRecord {
  round: number;
  allocations: Record<Faction, ActionAllocation>;
  events: string[];
}

export interface GameState {
  gameId: string;
  currentRound: number;
  factions: Record<Faction, FactionState>;
  history: RoundRecord[];
  winner: Faction | null;
}

export interface GameConfig {
  gameId: string;
  roles: Record<Faction, ModelProvider>;
}
