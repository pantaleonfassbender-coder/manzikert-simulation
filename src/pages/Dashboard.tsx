import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FastForward, Pause, Play, RotateCcw, Square } from 'lucide-react';
import type { GameState, GameConfig } from '../engine/types';
import { createInitialState } from '../engine/engine';
import { exportToExcel } from '../utils/exportExcel';
import { MODEL_NAMES } from '../engine/models';

const SPECTATOR_ID = 'game-spectator';

interface BatchControl {
  status: 'idle' | 'running' | 'paused' | 'done';
  total: number;
  nextIndex: number;
  runId: number;
  lastError: string | null;
  heartbeat: number | null;
}

// The run is processed by a background function. If its heartbeat is older than
// this while the run is still "running", the worker has finished its time
// budget, crashed, or never started — so the dashboard kicks off a fresh one.
const WORKER_STALE_MS = 30_000;
// Don't re-trigger more than once per this window, so a burst of polls can't
// spawn a pile of workers.
const RETRIGGER_COOLDOWN_MS = 15_000;

const Dashboard: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(() => createInitialState(SPECTATOR_ID));
  const [isPlaying, setIsPlaying] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [batch, setBatch] = useState<BatchControl | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Lets the auto-play loop be interrupted by the Stop button.
  const autoRef = useRef(false);

  const config: GameConfig = {
    gameId: SPECTATOR_ID,
    roles: { emperor: 'openai', foes: 'gemini', seljuks: 'claude' }
  };

  // ---- Spectator / demo game ------------------------------------------------

  // Plays a single round against the supplied state and returns the next state
  // so the auto-play loop can chain rounds without waiting on React state.
  const requestRound = async (state: GameState): Promise<GameState> => {
    const res = await fetch('/.netlify/functions/play-round', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, config })
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
    if (gameState.currentRound > 12 || gameState.winner || isPlaying || autoRunning) return;
    setIsPlaying(true);
    try {
      const next = await requestRound(gameState);
      setGameState(next);
    } catch (e) {
      console.error(e);
      alert('Error playing round');
    } finally {
      setIsPlaying(false);
    }
  };

  // Runs a full 12-round demo game on its own so a viewer can watch the
  // simulation mechanics end to end without clicking through every round.
  const playFullDemo = async () => {
    if (autoRunning || isPlaying) return;
    autoRef.current = true;
    setAutoRunning(true);

    let state = gameState.winner || gameState.currentRound > 12
      ? createInitialState(SPECTATOR_ID)
      : gameState;
    setGameState(state);

    try {
      while (autoRef.current && state.currentRound <= 12 && !state.winner) {
        state = await requestRound(state);
        setGameState(state);
        // Brief pause so the viewer can follow each round.
        await new Promise((r) => setTimeout(r, 700));
      }
    } catch (e) {
      console.error(e);
      alert('Demo game stopped due to an error');
    } finally {
      autoRef.current = false;
      setAutoRunning(false);
    }
  };

  const stopDemo = () => {
    autoRef.current = false;
  };

  const resetDemo = () => {
    if (autoRunning) return;
    setGameState(createInitialState(SPECTATOR_ID));
  };

  // ---- Batch run ------------------------------------------------------------

  // Last time this tab asked the background worker to (re)start, so polling
  // can't spawn a stack of workers.
  const lastTriggerRef = useRef<number>(0);

  const refreshBatchStatus = useCallback(async () => {
    try {
      const res = await fetch('/.netlify/functions/batch-control?action=status');
      const data = await res.json();
      if (data.control) setBatch(data.control);
      return data.control as BatchControl | undefined;
    } catch (e) {
      console.error('Failed to read batch status', e);
      return undefined;
    }
  }, []);

  // Kicks off the background worker that actually plays the games. The browser is
  // already past the site's password screen, so unlike a server-to-server call
  // this request reaches the function. The worker returns 202 immediately and
  // keeps running on its own; we just need to fire it.
  const triggerWorker = useCallback(() => {
    lastTriggerRef.current = Date.now();
    fetch('/.netlify/functions/batch-run-background', { method: 'POST' }).catch((e) => {
      console.error('Failed to trigger batch worker', e);
    });
  }, []);

  const sendBatchAction = useCallback(async (action: 'start' | 'pause' | 'resume' | 'reset') => {
    try {
      const res = await fetch('/.netlify/functions/batch-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      if (data.control) {
        setBatch(data.control);
        // Start/Resume flip the run to "running"; launch the worker to drive it.
        if ((action === 'start' || action === 'resume') && data.control.status === 'running') {
          triggerWorker();
        }
      }
    } catch (e) {
      console.error(e);
      alert(`Failed to ${action} the batch run`);
    }
  }, [triggerWorker]);

  // Poll while a run is active so progress and pause/resume stay in sync. If the
  // run says "running" but the worker's heartbeat has gone stale (it hit its time
  // budget, crashed, or the page was just reopened), start a fresh worker to
  // carry on from wherever it last saved.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const control = await refreshBatchStatus();
      if (cancelled || !control) return;
      if (control.status === 'running') {
        const stale = !control.heartbeat || Date.now() - control.heartbeat > WORKER_STALE_MS;
        const cooledDown = Date.now() - lastTriggerRef.current > RETRIGGER_COOLDOWN_MS;
        if (stale && cooledDown) triggerWorker();
      }
    };
    tick();
    const interval = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshBatchStatus, triggerWorker]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch('/.netlify/functions/list-games');
      const data = await res.json();

      const batchGames = data.games || [];
      // Include the live spectator/demo game if it has been played at all.
      const allGames =
        gameState.history.length > 0
          ? [{ gameId: SPECTATOR_ID, roles: config.roles, finalState: gameState }, ...batchGames]
          : batchGames;

      if (allGames.length === 0) {
        alert('No completed games to export yet. Start the batch run or play the demo first.');
        return;
      }
      exportToExcel(allGames);
    } catch (e) {
      console.error(e);
      alert('Failed to download excel');
    } finally {
      setDownloading(false);
    }
  };

  const batchStatus = batch?.status ?? 'idle';
  const completed = batch?.nextIndex ?? 0;
  const total = batch?.total ?? 300;
  const progressPct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const isRunning = batchStatus === 'running';
  const isPaused = batchStatus === 'paused';
  const isDone = batchStatus === 'done';

  const lastRecord = gameState.history.length > 0 ? gameState.history[gameState.history.length - 1] : null;

  return (
    <div>
      <div className="header" style={{ marginBottom: '2rem' }}>
        <h1>Live Simulation Monitor</h1>
        <p>Spectator Demo Game &amp; 300-Game Sampling Run</p>
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
          {lastRecord && (
             <div style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                <em>"{lastRecord.allocations.emperor.selfAssessment}"</em>
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
          {lastRecord && (
             <div style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                <em>"{lastRecord.allocations.foes.selfAssessment}"</em>
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
          {lastRecord && (
             <div style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                <em>"{lastRecord.allocations.seljuks.selfAssessment}"</em>
             </div>
          )}
        </div>
      </div>

      <div className="glass-panel" style={{ marginTop: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h2>Demo Game — Round {Math.min(gameState.currentRound, 12)} / 12</h2>
            {gameState.winner && <p style={{ color: 'var(--accent-color)', fontWeight: 'bold' }}>Winner: {gameState.winner.toUpperCase()}</p>}
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              onClick={playFullDemo}
              disabled={autoRunning || isPlaying}
            >
              <FastForward size={18} style={{ marginRight: '0.5rem' }} />
              {autoRunning ? 'Running Demo…' : 'Run Full Demo Game'}
            </button>

            {autoRunning ? (
              <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={stopDemo}>
                <Square size={18} style={{ marginRight: '0.5rem' }} /> Stop
              </button>
            ) : (
              <button
                className="btn"
                style={{ background: 'rgba(255,255,255,0.1)' }}
                onClick={playNextRound}
                disabled={isPlaying || gameState.currentRound > 12 || !!gameState.winner}
              >
                {isPlaying ? 'Computing…' : <><Play size={18} style={{ marginRight: '0.5rem' }} /> Play Next Round</>}
              </button>
            )}

            <button
              className="btn"
              style={{ background: 'rgba(255,255,255,0.1)' }}
              onClick={resetDemo}
              disabled={autoRunning || isPlaying}
            >
              <RotateCcw size={18} style={{ marginRight: '0.5rem' }} /> Reset
            </button>
          </div>
        </div>

        <div style={{ marginTop: '1.5rem', maxHeight: '220px', overflowY: 'auto', background: 'rgba(0,0,0,0.3)', padding: '1rem', borderRadius: '8px' }}>
          {gameState.history.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>Demo game has not started yet.</p>}
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
        <h2>300-Game Sampling Run</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          Runs all {total} games in the background, one block at a time so the model calls never overwhelm the
          gateway. The run can be paused and resumed at any point, and results can be exported to Excel in between.
        </p>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {!isRunning ? (
            <button className="btn btn-primary" onClick={() => sendBatchAction(isPaused ? 'resume' : 'start')}>
              <Play size={18} style={{ marginRight: '0.5rem' }} />
              {isPaused ? 'Resume Run' : isDone ? 'Restart Run' : `Start ${total} Games`}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => sendBatchAction('pause')}>
              <Pause size={18} style={{ marginRight: '0.5rem' }} /> Pause Run
            </button>
          )}

          {(isPaused || isDone) && (
            <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={() => sendBatchAction('reset')}>
              <RotateCcw size={18} style={{ marginRight: '0.5rem' }} /> Reset
            </button>
          )}

          <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={handleDownload} disabled={downloading}>
            <Download size={18} style={{ marginRight: '0.5rem' }} />
            {downloading ? 'Preparing Excel…' : 'Download Results'}
          </button>
        </div>

        <div style={{ marginTop: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <span>
              Status: <strong style={{ color: 'var(--text-primary)', textTransform: 'capitalize' }}>{batchStatus}</strong>
            </span>
            <span>{completed} / {total} games ({progressPct}%)</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPct}%` }}></div>
          </div>
          {batch?.lastError && (
            <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--foes-color)' }}>
              Last error: {batch.lastError}
            </p>
          )}
        </div>
      </div>

    </div>
  );
};

export default Dashboard;
