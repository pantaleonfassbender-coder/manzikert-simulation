import * as XLSX from 'xlsx';
import type { ModelProvider, RoundRecord } from '../engine/types';
import { MODEL_NAMES } from '../engine/models';

const getModelName = (provider?: ModelProvider) => provider ? MODEL_NAMES[provider] : 'unknown';

export function exportToExcel(games: any[]) {
  // Drop anything that hasn't produced a usable final state yet so a mid-run
  // download (before every game has finished) still exports cleanly.
  const usable = (games || []).filter((g) => g && g.finalState && g.finalState.factions);

  // Sheet 1: Game Summaries
  const summaries = usable.map(g => ({
    GameID: g.gameId,
    EmperorModel: getModelName(g.roles?.emperor),
    FoesModel: getModelName(g.roles?.foes),
    SeljuksModel: getModelName(g.roles?.seljuks),
    Winner: g.finalState.winner || 'none',
    Rounds: g.finalState.history?.length ?? 0,
    FinalEmperorLoyalty: g.finalState.factions.emperor.internalLoyalty,
    FinalEmperorTerritory: g.finalState.factions.emperor.territoryControl
  }));

  // Sheet 2: Round Data (flat)
  const roundData: any[] = [];
  const selfAssessments: any[] = [];

  usable.forEach(g => {
    const history = g.finalState?.history || [];
    history.forEach((r: RoundRecord) => {
      roundData.push({
        GameID: g.gameId,
        Round: r.round,
        Emperor_Mil: r.allocations.emperor.military,
        Emperor_Dip: r.allocations.emperor.diplomacy,
        Emperor_Int: r.allocations.emperor.internal,
        Foes_Mil: r.allocations.foes.military,
        Foes_Dip: r.allocations.foes.diplomacy,
        Foes_Int: r.allocations.foes.internal,
        Seljuks_Mil: r.allocations.seljuks.military,
        Seljuks_Dip: r.allocations.seljuks.diplomacy,
        Seljuks_Int: r.allocations.seljuks.internal,
      });

      selfAssessments.push({
        GameID: g.gameId,
        Round: r.round,
        Faction: 'emperor',
        Assessment: r.allocations.emperor.selfAssessment
      });
      selfAssessments.push({
        GameID: g.gameId,
        Round: r.round,
        Faction: 'foes',
        Assessment: r.allocations.foes.selfAssessment
      });
      selfAssessments.push({
        GameID: g.gameId,
        Round: r.round,
        Faction: 'seljuks',
        Assessment: r.allocations.seljuks.selfAssessment
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

  XLSX.writeFile(wb, "Manzikert_Simulation_Results.xlsx");
}
