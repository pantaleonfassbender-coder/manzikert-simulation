import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FastForward, Pause, Play } from 'lucide-react';
import type { GameState, GameConfig } from '../engine/types';
import { exportToExcel } from '../utils/exportExcel';
import { MODEL_NAMES } from '../engine/models';

const TOTAL_GAMES = 300;
const WORKER_CHUNK = 10;

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

type RunStatus = 'idle' | 'running' | 'paused' | 'completed';
interface RunState {
  status: RunStatus;
  completed: number;
  total: number;
}

const Dashboard: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(INITIAL_STATE);
  const [isPlaying, setIsPlaying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [run, setRun] = useState<RunState>({ status: 'idle', completed: 0, total: TOTAL_GAMES });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The spectator game is a standalone live preview. It uses a fixed role
  // assignment and is never written into the 300-game batch dataset.
  const config: GameConfig = {
    gameId: 'game-spectator',
    roles: { emperor: 'openai', foes: 'gemini', seljuks: 'claude' },
  };

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/.netlify/functions/batch-control', { credentials: 'include' });
      if (!res.ok) return;
      const data: RunState = await res.json();
      setRun(data);
      if ((data.status === 'completed' || data.status === 'paused') && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    refreshStatus();
    pollRef.current = setInterval(refreshStatus, 4000);
  }, [refreshStatus]);

  // Reflect any run already in progress when the dashboard loads.
  useEffect(() => {
    refreshStatus();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshStatus]);

  const playNextRound = async () => {
    if (gameState.currentRound > 12 || isPlaying) return;
    setIsPlaying(true);

    try {
      const res = await fetch('/.netlify/functions/play-round', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ state: gameState, config }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Round request failed with status ${res.status}`);
      }

      const data = await res.json();
      if (data.nextState) {
        setGameState(data.nextState);
      } else {
        throw new Error('Round response did not include a next game state');
      }
    } catch (e: any) {
      console.error(e);
      alert(`Error playing round: ${e.message}`);
    } finally {
      setIsPlaying(false);
    }
  };

  // Fan out background workers covering every game index (0..299). Workers skip
  // games that are already stored, so the same fan-out is used for start and resume.
  const fanOutWorkers = () => {
    for (let startIndex = 0; startIndex < TOTAL_GAMES; startIndex += WORKER_CHUNK) {
      const count = Math.min(WORKER_CHUNK, TOTAL_GAMES - startIndex);
      fetch('/.netlify/functions/batch-games-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ startIndex, count }),
      }).catch(console.error);
    }
  };

  const controlRun = async (action: 'start' | 'stop' | 'resume') => {
    const res = await fetch('/.netlify/functions/batch-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Control request failed with status ${res.status}`);
    }
    return res.json();
  };

  const handleStart = async () => {
    if (!confirm('Start a fresh 300-game run? This clears any previously stored batch results.')) return;
    try {
      await controlRun('start');
      fanOutWorkers();
      startPolling();
    } catch (e: any) {
      alert(`Could not start run: ${e.message}`);
    }
  };

  const handleStop = async () => {
    try {
      await controlRun('stop');
      await refreshStatus();
    } catch (e: any) {
      alert(`Could not stop run: ${e.message}`);
    }
  };

  const handleResume = async () => {
    try {
      await controlRun('resume');
      fanOutWorkers();
      startPolling();
    } catch (e: any) {
      alert(`Could not resume run: ${e.message}`);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch('/.netlify/functions/list-games', { credentials: 'include' });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = await res.json();
      const games = (data.games || []).filter(Boolean);
      if (games.length === 0) {
        alert('No batch games are stored yet. Run the 300-game batch first.');
        return;
      }
      exportToExcel(games);
    } catch (e: any) {
      console.error(e);
      alert(`Failed to download Excel: ${e.message}`);
    } finally {
      setDownloading(false);
    }
  };

  const progressPct = Math.round((run.completed / run.total) * 100);
  const isRunning = run.status === 'running';
  const isPaused = run.status === 'paused';
  const isComplete = run.status === 'completed';

  return (
    <div>
      <div className="header" style={{ marginBottom: '2rem' }}>
        <h1>Live Simulation Monitor</h1>
        <p>Spectator preview — standalone, not part of the 300-game batch</p>
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
              <em>"{gameState.history[gameState.history.length - 1].allocations.emperor.selfAssessment}"</em>
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
              <em>"{gameState.history[gameState.history.length - 1].allocations.foes.selfAssessment}"</em>
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
              <em>"{gameState.history[gameState.history.length - 1].allocations.seljuks.selfAssessment}"</em>
            </div>
          )}
        </div>
      </div>

      <div className="glass-panel" style={{ marginTop: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2>Round {Math.min(gameState.currentRound, 12)} / 12</h2>
            {gameState.winner && (
              <p style={{ color: 'var(--accent-color)', fontWeight: 'bold' }}>
                Winner: {gameState.winner.toUpperCase()}
              </p>
            )}
          </div>
          <button
            className="btn btn-primary"
            onClick={playNextRound}
            disabled={isPlaying || gameState.currentRound > 12}
          >
            {isPlaying ? (
              'Computing...'
            ) : (
              <>
                <Play size={18} style={{ marginRight: '0.5rem' }} /> Play Next Round
              </>
            )}
          </button>
        </div>

        <div
          style={{
            marginTop: '1.5rem',
            maxHeight: '200px',
            overflowY: 'auto',
            background: 'rgba(0,0,0,0.3)',
            padding: '1rem',
            borderRadius: '8px',
          }}
        >
          {gameState.history.length === 0 && (
            <p style={{ color: 'var(--text-secondary)' }}>Game has not started yet.</p>
          )}
          {gameState.history.map((record, i) => (
            <div key={i} style={{ marginBottom: '1rem' }}>
              <strong style={{ color: 'var(--accent-color)' }}>Round {record.round} Events:</strong>
              <ul style={{ paddingLeft: '1.5rem', margin: '0.5rem 0', color: 'var(--text-secondary)' }}>
                {record.events.map((evt, j) => (
                  <li key={j}>{evt}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="glass-panel" style={{ marginTop: '2rem' }}>
        <h2>Batch Run — 300 Games</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          A self-contained run of 300 games (indices 0–299) in the background, independent of the spectator
          preview above. Pause it at any time and resume where it left off, then export everything to Excel.
        </p>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {!isRunning && !isPaused && (
            <button className="btn btn-primary" onClick={handleStart}>
              <FastForward size={18} style={{ marginRight: '0.5rem' }} />
              {isComplete ? 'Restart 300-Game Run' : 'Start 300-Game Run'}
            </button>
          )}

          {isRunning && (
            <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={handleStop}>
              <Pause size={18} style={{ marginRight: '0.5rem' }} />
              Stop
            </button>
          )}

          {isPaused && (
            <button className="btn btn-primary" onClick={handleResume}>
              <Play size={18} style={{ marginRight: '0.5rem' }} />
              Resume
            </button>
          )}

          <button
            className="btn"
            style={{ background: 'rgba(255,255,255,0.1)' }}
            onClick={handleDownload}
            disabled={downloading}
          >
            <Download size={18} style={{ marginRight: '0.5rem' }} />
            {downloading ? 'Preparing Excel...' : 'Download Results'}
          </button>
        </div>

        <div style={{ marginTop: '1.5rem' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Status: <strong style={{ textTransform: 'capitalize' }}>{run.status}</strong> · {run.completed} /{' '}
            {run.total} games completed
          </p>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPct}%` }}></div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
