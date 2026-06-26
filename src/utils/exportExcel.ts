import * as XLSX from 'xlsx';
import type { ModelProvider, RoundRecord, Faction } from '../engine/types';
import { MODEL_NAMES } from '../engine/models';

const getModelName = (provider?: ModelProvider) => provider ? MODEL_NAMES[provider] : 'unknown';

const FACTIONS: Faction[] = ['emperor', 'foes', 'seljuks'];

export function exportToExcel(games: any[]) {
  // Sheet 1: Game Summaries
  const summaries = games.map(g => ({
    GameID: g.gameId,
    EmperorModel: getModelName(g.roles?.emperor),
    FoesModel: getModelName(g.roles?.foes),
    SeljuksModel: getModelName(g.roles?.seljuks),
    Winner: g.finalState.winner || 'none',
    FinalEmperorLoyalty: g.finalState.factions.emperor.internalLoyalty,
    FinalEmperorTerritory: g.finalState.factions.emperor.territoryControl
  }));

  // Sheet 2: Round Data (flat) — AP splits AND the resulting per-round KPI state.
  // The KPI state after each round is read directly from the deterministic
  // engine's recorded `stateAfter`, so H1 has the full per-round trajectory
  // (military strength, loyalty, territory) alongside the action allocations.
  const roundData: any[] = [];
  const selfAssessments: any[] = [];
  const messages: any[] = [];

  games.forEach(g => {
    const history = g.finalState?.history || [];
    history.forEach((r: RoundRecord) => {
      const after = r.stateAfter?.factions;

      roundData.push({
        GameID: g.gameId,
        Round: r.round,
        // Action point splits
        Emperor_Mil: r.allocations.emperor.military,
        Emperor_Dip: r.allocations.emperor.diplomacy,
        Emperor_Int: r.allocations.emperor.internal,
        Foes_Mil: r.allocations.foes.military,
        Foes_Dip: r.allocations.foes.diplomacy,
        Foes_Int: r.allocations.foes.internal,
        Seljuks_Mil: r.allocations.seljuks.military,
        Seljuks_Dip: r.allocations.seljuks.diplomacy,
        Seljuks_Int: r.allocations.seljuks.internal,
        // Per-round KPI state (after this round resolved)
        Emperor_MilitaryStrength: after?.emperor.militaryStrength,
        Emperor_Loyalty: after?.emperor.internalLoyalty,
        Emperor_Territory: after?.emperor.territoryControl,
        Foes_MilitaryStrength: after?.foes.militaryStrength,
        Foes_Loyalty: after?.foes.internalLoyalty,
        Foes_Territory: after?.foes.territoryControl,
        Seljuks_MilitaryStrength: after?.seljuks.militaryStrength,
        Seljuks_Loyalty: after?.seljuks.internalLoyalty,
        Seljuks_Territory: after?.seljuks.territoryControl,
      });

      FACTIONS.forEach(faction => {
        selfAssessments.push({
          GameID: g.gameId,
          Round: r.round,
          Faction: faction,
          Assessment: r.allocations[faction].selfAssessment
        });

        // Diplomatic messages: one row per (sender -> recipient) message.
        // These power H2's deception index (stated intent vs. actual allocation).
        const outbound = r.allocations[faction].messages || {};
        (Object.keys(outbound) as Faction[]).forEach(recipient => {
          const text = outbound[recipient];
          if (text) {
            messages.push({
              GameID: g.gameId,
              Round: r.round,
              From: faction,
              To: recipient,
              Message: text
            });
          }
        });
      });
    });
  });

  const wb = XLSX.utils.book_new();

  const ws1 = XLSX.utils.json_to_sheet(summaries);
  XLSX.utils.book_append_sheet(wb, ws1, "Game Summaries");

  const ws2 = XLSX.utils.json_to_sheet(roundData);
  XLSX.utils.book_append_sheet(wb, ws2, "Allocations");

  const ws3 = XLSX.utils.json_to_sheet(selfAssessments);
  XLSX.utils.book_append_sheet(wb, ws3, "Self Assessments");

  const ws4 = XLSX.utils.json_to_sheet(messages);
  XLSX.utils.book_append_sheet(wb, ws4, "Messages");

  XLSX.writeFile(wb, "Mantzikert_Simulation_Results.xlsx");
}
