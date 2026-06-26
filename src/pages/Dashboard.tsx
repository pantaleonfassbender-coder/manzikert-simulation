import React, { useEffect, useRef, useState } from 'react';
import { Download, FastForward, Play, RotateCcw, Zap } from 'lucide-react';
import type { GameState, GameConfig } from '../engine/types';
import { exportToExcel } from '../utils/exportExcel';
import { MODEL_NAMES } from '../engine/models';

const TOTAL_BACKGROUND_GAMES = 300;
const BACKGROUND_CHUNK_SIZE = 10;

const INITIAL_STATE: GameState = {
  gameId: 'game-spectator',
  currentRound: 1,
  factions: {
    emperor: { militaryStrength: 100, internalLoyalty: 50, territoryControl: 100 },
    foes: { militaryStrength: 20, internalLoyalty: 80, territoryControl: 0 },
    seljuks: { militaryStrength: 80, internalLoyalty: 100, territoryControl: 0 },
  },
  history: [],
  winner: null,
};

const Dashboard: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(INITIAL_STATE);
  const [isPlaying, setIsPlaying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [batchStarted, setBatchStarted] = useState(false);
  const [storedCount, setStoredCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The spectator demo is a standalone showcase. It uses a fixed role line-up
  // and never touches the background run or the stored results.
  const config: GameConfig = {
    gameId: 'game-spectator',
    roles: { emperor: 'openai', foes: 'gemini', seljuks: 'claude' }
  };

  // Play a single round against the server and return the resulting state.
  const runRound = async (current: GameState): Promise<GameState | null> => {
    const res = await fetch('/.netlify/functions/play-round', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: current, config })
    });

    if (!res.ok) {
      throw new Error(`Round request failed with status ${res.status}`);
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
      const next = await runRound(gameState);
      if (next) setGameState(next);
    } catch (e) {
      console.error(e);
      alert('Error playing round');
    } finally {
      setIsPlaying(false);
    }
  };

  // Run the spectator game to completion, refreshing the view after each round.
  const playFullDemo = async () => {
    if (gameState.currentRound > 12 || isPlaying) return;
    setIsPlaying(true);
    try {
      let current = gameState;
      while (current.currentRound <= 12) {
        const next = await runRound(current);
        if (!next) break;
        current = next;
        setGameState(next);
      }
    } catch (e) {
      console.error(e);
      alert('Error playing full demo game');
    } finally {
      setIsPlaying(false);
    }
  };

  const resetDemo = () => {
    if (isPlaying) return;
    setGameState(INITIAL_STATE);
  };

  const refreshStoredCount = async () => {
    try {
      const res = await fetch('/.netlify/functions/list-games');
      const data = await res.json();
      const count = (data.games || []).filter((g: any) => g && g.finalState).length;
      setStoredCount(count);
      if (count >= TOTAL_BACKGROUND_GAMES && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (e) {
      console.error('Failed to read stored games', e);
    }
  };

  const startBackgroundBatch = async () => {
    // Fire a single chained run. The background function plays games in
    // consecutive batches of BACKGROUND_CHUNK_SIZE and queues the next batch
    // itself, so batches never run all at once.
    try {
      await fetch('/.netlify/functions/batch-games-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startIndex: 0, chunkSize: BACKGROUND_CHUNK_SIZE, total: TOTAL_BACKGROUND_GAMES })
      });
    } catch (e) {
      console.error(e);
    }

    setBatchStarted(true);
    alert(`Started ${TOTAL_BACKGROUND_GAMES} games in consecutive batches of ${BACKGROUND_CHUNK_SIZE}. Results accumulate in storage — download any time to get whatever has finished.`);

    refreshStoredCount();
    if (!pollRef.current) {
      pollRef.current = setInterval(refreshStoredCount, 15000);
    }
  };

  // Stop polling when leaving the page.
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch('/.netlify/functions/list-games');
      const data = await res.json();
      // Export only the stored background games — the spectator demo is separate.
      exportToExcel(data.games || []);
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
        <p>Spectator Demo — a standalone showcase game, separate from the background run</p>
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
            <p>Loyalty: {gameState.factions.foes.internalLoyalty.toFixed(1)} / 100</p>
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
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              className="btn btn-primary"
              onClick={playNextRound}
              disabled={isPlaying || gameState.currentRound > 12}
            >
              {isPlaying ? 'Computing...' : <><Play size={18} style={{ marginRight: '0.5rem' }} /> Play Next Round</>}
            </button>
            <button
              className="btn"
              style={{ background: 'rgba(255,255,255,0.1)' }}
              onClick={playFullDemo}
              disabled={isPlaying || gameState.currentRound > 12}
            >
              <Zap size={18} style={{ marginRight: '0.5rem' }} /> Auto-Play Full Game
            </button>
            <button
              className="btn"
              style={{ background: 'rgba(255,255,255,0.1)' }}
              onClick={resetDemo}
              disabled={isPlaying}
            >
              <RotateCcw size={18} style={{ marginRight: '0.5rem' }} /> Reset
            </button>
          </div>
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
        <h2>Background Run</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          Runs {TOTAL_BACKGROUND_GAMES} games in consecutive batches of {BACKGROUND_CHUNK_SIZE}. Each finished game is
          saved immediately, so the Excel file grows over time — download whenever you like to capture whatever has
          completed so far. This run is independent of the spectator demo above.
        </p>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={startBackgroundBatch}>
            <FastForward size={18} style={{ marginRight: '0.5rem' }} />
            Start {TOTAL_BACKGROUND_GAMES} Background Games
          </button>

          <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={refreshStoredCount}>
            <RotateCcw size={18} style={{ marginRight: '0.5rem' }} />
            Refresh Status
          </button>

          <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={handleDownload} disabled={downloading}>
            <Download size={18} style={{ marginRight: '0.5rem' }} />
            {downloading ? 'Preparing Excel...' : 'Download Results'}
          </button>
        </div>

        {(batchStarted || storedCount > 0) && (
           <div style={{ marginTop: '1.5rem' }}>
             <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
               {storedCount} / {TOTAL_BACKGROUND_GAMES} games stored
             </p>
             <div className="progress-bar">
               <div className="progress-fill" style={{ width: `${Math.min(100, (storedCount / TOTAL_BACKGROUND_GAMES) * 100)}%` }}></div>
             </div>
           </div>
        )}
      </div>

    </div>
  );
};

export default Dashboard;
