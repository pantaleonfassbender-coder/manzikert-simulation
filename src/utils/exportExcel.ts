import * as XLSX from 'xlsx';
import type { Faction, ModelProvider, RoundRecord } from '../engine/types';
import { MODEL_NAMES } from '../engine/models';

const FACTIONS: Faction[] = ['emperor', 'foes', 'seljuks'];
const getModelName = (provider?: ModelProvider) => (provider ? MODEL_NAMES[provider] : 'unknown');

export function exportToExcel(games: any[]) {
  // Sheet 1: one row per game (final outcome + which model played which role).
  const summaries: any[] = [];

  // Sheet 2 ("Round Data"): analysis-ready long format — one row per
  // (game, round, faction). Combines the action-point allocation, the faction's
  // objective KPI state *after* the round, and the mandatory self-assessment, so
  // the H1 mixed-effects regression (KPI drop vs. LIWC-22 markers) can be run
  // directly without re-joining separate sheets.
  const roundData: any[] = [];

  // Sheet 3 ("Messages"): one row per diplomatic message — the "cheap talk"
  // needed for the H2 Deception Index, paired with the sender's action points
  // (the hostility signal) for the same round.
  const messages: any[] = [];

  games.forEach((g) => {
    const roles = g.roles || {};

    summaries.push({
      GameID: g.gameId,
      EmperorModel: getModelName(roles.emperor),
      FoesModel: getModelName(roles.foes),
      SeljuksModel: getModelName(roles.seljuks),
      Winner: g.finalState?.winner || 'none',
      FinalEmperorLoyalty: g.finalState?.factions?.emperor?.internalLoyalty,
      FinalEmperorTerritory: g.finalState?.factions?.emperor?.territoryControl,
      FinalFoesLoyalty: g.finalState?.factions?.foes?.internalLoyalty,
      FinalSeljukTerritory: g.finalState?.factions?.seljuks?.territoryControl,
    });

    const history: RoundRecord[] = g.finalState?.history || [];
    history.forEach((r) => {
      FACTIONS.forEach((faction) => {
        const alloc = r.allocations[faction];
        const stateAfter = r.stateAfter?.factions?.[faction];

        roundData.push({
          GameID: g.gameId,
          Round: r.round,
          Faction: faction,
          Model: getModelName(roles[faction]),
          AP_Military: alloc.military,
          AP_Diplomacy: alloc.diplomacy,
          AP_Internal: alloc.internal,
          MilitaryStrength: stateAfter?.militaryStrength,
          InternalLoyalty: stateAfter?.internalLoyalty,
          TerritoryControl: stateAfter?.territoryControl,
          SelfAssessment: alloc.selfAssessment,
        });

        const msgs = alloc.messages || {};
        FACTIONS.forEach((to) => {
          if (msgs[to]) {
            messages.push({
              GameID: g.gameId,
              Round: r.round,
              FromFaction: faction,
              FromModel: getModelName(roles[faction]),
              ToFaction: to,
              Message: msgs[to],
              Sender_AP_Military: alloc.military,
              Sender_AP_Diplomacy: alloc.diplomacy,
              Sender_AP_Internal: alloc.internal,
            });
          }
        });
      });
    });
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaries), 'Game Summaries');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(roundData), 'Round Data');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(messages), 'Messages');

  XLSX.writeFile(wb, 'Mantzikert_Simulation_Results.xlsx');
}
