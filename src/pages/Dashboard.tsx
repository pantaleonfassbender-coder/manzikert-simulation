import React, { useState } from 'react';
import { Download, FastForward, Play } from 'lucide-react';
import type { GameState, GameConfig } from '../engine/types';
import { exportToExcel } from '../utils/exportExcel';
import { MODEL_NAMES } from '../engine/models';

const INITIAL_STATE: GameState = {
  gameId: 'game-spectator',
  currentRound: 1,
  factions: {
    emperor: { militaryStrength: 100, internalLoyalty: 50, territoryControl: 100 },
    foes: { militaryStrength: 20, internalLoyalty: 50, territoryControl: 0 },
    seljuks: { militaryStrength: 80, internalLoyalty: 100, territoryControl: 0 },
  },
  history: [],
  winner: null,
};

const TOTAL_GAMES = 300;

// A game counts toward the preregistered N only if all 12 rounds completed and
// a winner was resolved.
const isComplete = (g: any) => g?.finalState?.history?.length === 12 && !!g?.finalState?.winner;

const Dashboard: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(INITIAL_STATE);
  const [isPlaying, setIsPlaying] = useState(false);
  const [backgroundProgress, setBackgroundProgress] = useState(0);
  const [completedGames, setCompletedGames] = useState(0);
  const [downloading, setDownloading] = useState(false);

  // The spectator view is a live demo of a single game and is NOT part of the
  // research dataset. The full N = 300 dataset is produced entirely by the
  // background batch (game-0 ... game-299) so it never depends on manual play.
  const config: GameConfig = {
    gameId: 'game-spectator',
    roles: { emperor: 'openai', foes: 'gemini', seljuks: 'claude' }
  };

  const requestRound = async (): Promise<GameState> => {
    const res = await fetch('/.netlify/functions/play-round', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: gameState, config })
    });

    if (!res.ok) {
      // 502 = an upstream model call failed after the server's internal retries.
      // Surface the server's message so a genuine failure is diagnosable rather
      // than showing an opaque "Error playing round".
      const detail = await res.text().catch(() => '');
      let message = `Round request failed with status ${res.status}`;
      try {
        const parsed = JSON.parse(detail);
        if (parsed?.error) message = parsed.error;
      } catch {
        if (detail) message = detail;
      }
      const err = new Error(message) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    if (!data.nextState) {
      throw new Error('Round response did not include a next game state');
    }
    return data.nextState as GameState;
  };

  const playNextRound = async () => {
    if (gameState.currentRound > 12 || isPlaying) return;
    setIsPlaying(true);

    try {
      let nextState: GameState;
      try {
        nextState = await requestRound();
      } catch (e) {
        // A single automatic retry smooths over a transient model/gateway
        // hiccup (a 502) so the live demo does not fail on a one-off blip. This
        // spectator game is not part of the research dataset, so retrying here
        // has no bearing on preregistration Q6.
        const status = (e as Error & { status?: number }).status;
        if (status === 502) {
          nextState = await requestRound();
        } else {
          throw e;
        }
      }
      setGameState(nextState);
    } catch (e) {
      console.error(e);
      const detail = e instanceof Error ? e.message : String(e);
      alert(`Error playing round: ${detail}`);
    } finally {
      setIsPlaying(false);
    }
  };

  const pollProgress = () => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/.netlify/functions/list-games');
        const data = await res.json();
        const completed = (data.games || []).filter(isComplete).length;
        setCompletedGames(completed);
        setBackgroundProgress(Math.round((completed / TOTAL_GAMES) * 100));
        if (completed >= TOTAL_GAMES) clearInterval(interval);
      } catch (e) {
        console.error(e);
      }
    }, 10000);
  };

  const startBackgroundBatch = async () => {
    const batchSize = 10;
    const numBatches = Math.ceil(TOTAL_GAMES / batchSize);

    // Fire-and-forget chunks to Netlify background functions. Games are indexed
    // 0 ... 299 so the dataset is fully produced by the batch (no reliance on
    // the manual spectator game). Each background function discards and re-runs
    // any game that fails.
    for (let i = 0; i < numBatches; i++) {
      const startIndex = i * batchSize;
      const count = Math.min(batchSize, TOTAL_GAMES - startIndex);

      fetch('/.netlify/functions/batch-games-background', {
        method: 'POST',
        body: JSON.stringify({ batchId: 'main', startIndex, count })
      }).catch(console.error);
    }

    alert(`Started ${TOTAL_GAMES} games in the background. Progress below updates as games complete.`);
    pollProgress();
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch('/.netlify/functions/list-games');
      const data = await res.json();
      const games = data.games || [];
      const complete = games.filter(isComplete);

      if (complete.length !== TOTAL_GAMES) {
        const proceed = window.confirm(
          `Only ${complete.length} of ${TOTAL_GAMES} complete games are available.\n\n` +
          `The preregistration requires exactly ${TOTAL_GAMES} complete games. ` +
          `Re-run "Start ${TOTAL_GAMES}-Game Simulation" to fill any gaps, or export this partial dataset anyway?`
        );
        if (!proceed) {
          setDownloading(false);
          return;
        }
      }

      // Export only complete games — never the in-progress spectator state.
      exportToExcel(complete);
    } catch (e) {
      console.error(e);
      alert('Failed to download excel');
    }
    setDownloading(false);
  };

  return (
    <div>
      <div className="header" style={{ marginBottom: '2rem' }}>
        <h1>Live Simulation Monitor</h1>
        <p>Spectator Game (1 of 300)</p>
      </div>

      <div className="grid grid-cols-3">
        {/* Emperor Panel */}
        <div className="glass-panel faction-card faction-emperor">
          <h3 style={{ color: 'var(--emperor-color)' }}>Byzantine Emperor</h3>
          <p>Model: {MODEL_NAMES[config.roles.emperor]}</p>
          <div style={{ marginTop: '1rem' }}>
            <p>Loyalty: {gameState.factions.emperor.internalLoyalty.toFixed(1)} / 100</p>
            <p>Territory: {gameState.factions.emperor.territoryControl.toFixed(1)} / 100</p>
          </div>
          {gameState.history.length > 0 && (
             <div style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                <em>"{gameState.history[gameState.history.length-1].allocations.emperor.selfAssessment}"</em>
             </div>
          )}
        </div>

        {/* Foes Panel */}
        <div className="glass-panel faction-card faction-foes">
          <h3 style={{ color: 'var(--foes-color)' }}>Internal Foes</h3>
          <p>Model: {MODEL_NAMES[config.roles.foes]}</p>
          <div style={{ marginTop: '1rem' }}>
            <p>Court Influence: {gameState.factions.foes.internalLoyalty.toFixed(1)} / 100</p>
          </div>
          {gameState.history.length > 0 && (
             <div style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                <em>"{gameState.history[gameState.history.length-1].allocations.foes.selfAssessment}"</em>
             </div>
          )}
        </div>

        {/* Seljuks Panel */}
        <div className="glass-panel faction-card faction-seljuks">
          <h3 style={{ color: 'var(--seljuks-color)' }}>Seljuk Empire</h3>
          <p>Model: {MODEL_NAMES[config.roles.seljuks]}</p>
          <div style={{ marginTop: '1rem' }}>
            <p>Territory: {gameState.factions.seljuks.territoryControl.toFixed(1)} / 100</p>
          </div>
          {gameState.history.length > 0 && (
             <div style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                <em>"{gameState.history[gameState.history.length-1].allocations.seljuks.selfAssessment}"</em>
             </div>
          )}
        </div>
      </div>

      <div className="glass-panel" style={{ marginTop: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2>Round {Math.min(gameState.currentRound, 12)} / 12</h2>
            {gameState.winner && <p style={{ color: 'var(--accent-color)', fontWeight: 'bold' }}>Winner: {gameState.winner.toUpperCase()}</p>}
          </div>
          <button 
            className="btn btn-primary"
            onClick={playNextRound}
            disabled={isPlaying || gameState.currentRound > 12}
          >
            {isPlaying ? 'Computing...' : <><Play size={18} style={{ marginRight: '0.5rem' }} /> Play Next Round</>}
          </button>
        </div>

        <div style={{ marginTop: '1.5rem', maxHeight: '200px', overflowY: 'auto', background: 'rgba(0,0,0,0.3)', padding: '1rem', borderRadius: '8px' }}>
          {gameState.history.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>Game has not started yet.</p>}
          {gameState.history.map((record, i) => (
            <div key={i} style={{ marginBottom: '1rem' }}>
              <strong style={{ color: 'var(--accent-color)' }}>Round {record.round} Events:</strong>
              <ul style={{ paddingLeft: '1.5rem', margin: '0.5rem 0', color: 'var(--text-secondary)' }}>
                {record.events.map((evt, j) => <li key={j}>{evt}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="glass-panel" style={{ marginTop: '2rem' }}>
        <h2>Batch Processing</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>Run the full {TOTAL_GAMES}-game simulation in the background and export all data to Excel.</p>

        <div style={{ display: 'flex', gap: '1rem' }}>
          <button className="btn btn-primary" onClick={startBackgroundBatch}>
            <FastForward size={18} style={{ marginRight: '0.5rem' }} />
            Start {TOTAL_GAMES}-Game Simulation
          </button>

          <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={handleDownload} disabled={downloading}>
            <Download size={18} style={{ marginRight: '0.5rem' }} /> 
            {downloading ? 'Preparing Excel...' : 'Download Results'}
          </button>
        </div>

        {backgroundProgress > 0 && (
           <div style={{ marginTop: '1.5rem' }}>
             <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
               {completedGames} / {TOTAL_GAMES} complete games saved ({backgroundProgress}%)
             </p>
             <div className="progress-bar">
               <div className="progress-fill" style={{ width: `${backgroundProgress}%` }}></div>
             </div>
           </div>
        )}
      </div>

    </div>
  );
};

export default Dashboard;
