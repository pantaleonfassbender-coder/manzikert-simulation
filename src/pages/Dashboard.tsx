import React, { useEffect, useRef, useState } from 'react';
import { Download, FastForward, Pause, Play, RotateCcw, Zap } from 'lucide-react';
import type { GameState, GameConfig } from '../engine/types';
import { exportToExcel } from '../utils/exportExcel';
import { MODEL_NAMES } from '../engine/models';

const TOTAL_BACKGROUND_GAMES = 300;
const BACKGROUND_CHUNK_SIZE = 10;
const TOTAL_BATCHES = Math.ceil(TOTAL_BACKGROUND_GAMES / BACKGROUND_CHUNK_SIZE);

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
  const [paused, setPaused] = useState(false);
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
      setPaused(!!data.paused);
      // Stop polling once everything is stored or the run is paused and idle.
      if (count >= TOTAL_BACKGROUND_GAMES && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (e) {
      console.error('Failed to read stored games', e);
    }
  };

  const ensurePolling = () => {
    if (!pollRef.current) {
      pollRef.current = setInterval(refreshStoredCount, 15000);
    }
  };

  // Set the server-side pause flag. The background run honours it at the next
  // batch boundary.
  const setPauseFlag = async (value: boolean) => {
    await fetch('/.netlify/functions/set-run-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: value })
    });
  };

  // Fire one chained run starting at the given (chunk-aligned) game index. The
  // background function plays games in consecutive batches of
  // BACKGROUND_CHUNK_SIZE and queues the next batch itself, skipping any game
  // already stored — so this is safe to call to start, resume, or restart.
  const launchRun = async (startIndex: number) => {
    await setPauseFlag(false);
    setPaused(false);
    try {
      await fetch('/.netlify/functions/batch-games-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startIndex, chunkSize: BACKGROUND_CHUNK_SIZE, total: TOTAL_BACKGROUND_GAMES })
      });
    } catch (e) {
      console.error(e);
    }
    setBatchStarted(true);
    refreshStoredCount();
    ensurePolling();
  };

  const startBackgroundRun = async () => {
    await launchRun(0);
    alert(`Started ${TOTAL_BACKGROUND_GAMES} games in ${TOTAL_BATCHES} consecutive batches of ${BACKGROUND_CHUNK_SIZE}. You can pause after the current batch, resume later, and download intermediate results any time.`);
  };

  // Resume from the next unfinished batch boundary. Games already stored are
  // skipped server-side, so aligning to the chunk boundary is safe.
  const resumeBackgroundRun = async () => {
    const alignedStart = Math.floor(storedCount / BACKGROUND_CHUNK_SIZE) * BACKGROUND_CHUNK_SIZE;
    await launchRun(alignedStart);
  };

  // Ask the run to stop after the current batch finishes.
  const pauseBackgroundRun = async () => {
    try {
      await setPauseFlag(true);
      setPaused(true);
    } catch (e) {
      console.error(e);
    }
  };

  // On mount, read current progress/pause state once, and resume live polling
  // if a run is already underway. Stop polling when leaving the page.
  useEffect(() => {
    refreshStoredCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Derived run status for the indicator and button states.
  const runComplete = storedCount >= TOTAL_BACKGROUND_GAMES;
  const running = batchStarted && !paused && !runComplete;

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
              className="btn btn-secondary"
              onClick={playFullDemo}
              disabled={isPlaying || gameState.currentRound > 12}
            >
              <Zap size={18} style={{ marginRight: '0.5rem' }} /> Auto-Play Full Game
            </button>
            <button
              className="btn btn-secondary"
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
          <h2 style={{ margin: 0 }}>Background Run</h2>
          <span className={`status-badge ${
            runComplete ? 'is-complete' : paused ? 'is-paused' : running ? 'is-running' : 'is-idle'
          }`}>
            {runComplete ? 'Complete' : paused ? 'Paused' : running ? 'Running' : 'Idle'}
          </span>
        </div>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          Runs {TOTAL_BACKGROUND_GAMES} games in {TOTAL_BATCHES} consecutive batches of {BACKGROUND_CHUNK_SIZE}. Each
          finished game is saved immediately, so you can pause after the current batch, resume later, and download the
          intermediate results at any point. This run is independent of the spectator demo above.
        </p>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            onClick={startBackgroundRun}
            disabled={running || (storedCount > 0 && !runComplete && paused)}
            title="Begin the full 300-game run from the start"
          >
            <FastForward size={18} style={{ marginRight: '0.5rem' }} />
            {storedCount > 0 ? `Restart ${TOTAL_BACKGROUND_GAMES} Games` : `Start ${TOTAL_BACKGROUND_GAMES} Background Games`}
          </button>

          {paused && !runComplete && storedCount > 0 && (
            <button className="btn btn-primary" onClick={resumeBackgroundRun} title="Continue from the next batch">
              <Play size={18} style={{ marginRight: '0.5rem' }} />
              Resume Run
            </button>
          )}

          <button
            className="btn btn-warning"
            onClick={pauseBackgroundRun}
            disabled={!running || paused || runComplete}
            title="Stop the run after the current batch finishes"
          >
            <Pause size={18} style={{ marginRight: '0.5rem' }} />
            Pause After Current Batch
          </button>

          <button className="btn btn-secondary" onClick={refreshStoredCount}>
            <RotateCcw size={18} style={{ marginRight: '0.5rem' }} />
            Refresh Status
          </button>

          <button className="btn btn-secondary" onClick={handleDownload} disabled={downloading}>
            <Download size={18} style={{ marginRight: '0.5rem' }} />
            {downloading ? 'Preparing Excel...' : 'Download Intermediate Results'}
          </button>
        </div>

        {paused && !runComplete && (
          <p style={{ marginTop: '1rem', fontSize: '0.85rem', color: '#fde68a' }}>
            The run pauses once the in-flight batch finishes. Press <strong>Resume Run</strong> to continue from the next batch.
          </p>
        )}

        {(batchStarted || storedCount > 0) && (
           <div style={{ marginTop: '1.5rem' }}>
             <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.9rem' }}>
               <span style={{ fontWeight: 600 }}>
                 Batch {Math.min(Math.floor(storedCount / BACKGROUND_CHUNK_SIZE) + (runComplete ? 0 : 1), TOTAL_BATCHES)} of {TOTAL_BATCHES}
               </span>
               <span style={{ color: 'var(--text-secondary)' }}>
                 Game {storedCount} / {TOTAL_BACKGROUND_GAMES} stored
               </span>
             </div>
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
