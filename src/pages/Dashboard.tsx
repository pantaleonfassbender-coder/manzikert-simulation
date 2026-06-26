import React, { useEffect, useRef, useState } from 'react';
import { Download, FastForward, Play, Square } from 'lucide-react';
import type { GameState, GameConfig } from '../engine/types';
import { exportToExcel } from '../utils/exportExcel';
import { MODEL_NAMES } from '../engine/models';

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

const TOTAL_BACKGROUND_GAMES = 300;
const BATCH_SIZE = 10;

type RunStatus = 'idle' | 'running' | 'stopped';

// Split a list of game indices into background-function-sized chunks.
const chunk = (arr: number[], size: number): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const Dashboard: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(INITIAL_STATE);
  const [isPlaying, setIsPlaying] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [tracking, setTracking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The spectator game is a standalone live demo. It is never persisted and is
  // never part of the 300-game research batch — the two are fully independent.
  const config: GameConfig = {
    gameId: 'game-spectator',
    roles: { emperor: 'openai', foes: 'gemini', seljuks: 'claude' }
  };

  // Poll the batch-control endpoint for the real status of the 300-game run:
  // how many games are persisted and whether the run is running/stopped/idle.
  const fetchStatus = async () => {
    try {
      const res = await fetch('/.netlify/functions/batch-control');
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.completed === 'number') setCompletedCount(data.completed);
      if (data.status) setRunStatus(data.status as RunStatus);
    } catch (e) {
      console.error('Failed to fetch run status', e);
    }
  };

  const startPolling = () => {
    setTracking(true);
    fetchStatus();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(fetchStatus, 10000);
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // On mount, read the current run status. If a run is already in progress
  // (e.g. after a page reload), resume live polling so the tracker keeps up.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/.netlify/functions/batch-control');
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data.completed === 'number') setCompletedCount(data.completed);
        if (data.status) setRunStatus(data.status as RunStatus);
        if (data.status === 'running' && data.completed < TOTAL_BACKGROUND_GAMES) {
          startPolling();
        }
      } catch (e) {
        console.error('Failed to fetch run status', e);
      }
    })();
    return () => stopPolling();
  }, []);

  const backgroundProgress = Math.min(
    100,
    Math.round((completedCount / TOTAL_BACKGROUND_GAMES) * 100)
  );

  // Fire the background workers for a set of game indices, chunked into batches.
  const fireBatches = (indices: number[]) => {
    chunk(indices, BATCH_SIZE).forEach(group => {
      fetch('/.netlify/functions/batch-games-background', {
        method: 'POST',
        body: JSON.stringify({ indices: group })
      }).catch(console.error);
    });
  };

  const playNextRound = async () => {
    if (gameState.currentRound > 12 || isPlaying) return;
    setIsPlaying(true);

    try {
      const res = await fetch('/.netlify/functions/play-round', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: gameState, config })
      });

      if (!res.ok) {
        throw new Error(`Round request failed with status ${res.status}`);
      }

      const data = await res.json();
      if (data.nextState) {
        setGameState(data.nextState);
      } else {
        throw new Error('Round response did not include a next game state');
      }
    } catch (e) {
      console.error(e);
      alert('Error playing round');
    } finally {
      setIsPlaying(false);
    }
  };

  // Start a fresh run of all 300 games. The control flag is set to running and
  // every index is fired; the worker skips any game that already exists, so a
  // re-start safely tops up an interrupted run rather than duplicating work.
  const startBackgroundBatch = async () => {
    await fetch('/.netlify/functions/batch-control', {
      method: 'POST',
      body: JSON.stringify({ action: 'start' })
    }).catch(console.error);

    const all = Array.from({ length: TOTAL_BACKGROUND_GAMES }, (_, i) => i + 1);
    fireBatches(all);
    setRunStatus('running');
    startPolling();
    alert('Started the 300-game run in the background. It is independent of the spectator demo — you can stop, resume, or download partial results at any time.');
  };

  // Stop the run. In-flight workers finish their current game and then exit
  // when they next see the stopped flag.
  const stopBackgroundBatch = async () => {
    await fetch('/.netlify/functions/batch-control', {
      method: 'POST',
      body: JSON.stringify({ action: 'stop' })
    }).catch(console.error);
    setRunStatus('stopped');
    stopPolling();
    fetchStatus();
  };

  // Resume by re-firing only the games that are not yet persisted.
  const resumeBackgroundBatch = async () => {
    let missing: number[] = [];
    try {
      const res = await fetch('/.netlify/functions/batch-control');
      const data = await res.json();
      const done = new Set<number>(data.completedIndices || []);
      missing = Array.from({ length: TOTAL_BACKGROUND_GAMES }, (_, i) => i + 1)
        .filter(n => !done.has(n));
    } catch (e) {
      console.error('Failed to compute remaining games', e);
      return;
    }

    if (missing.length === 0) {
      alert('All 300 games are already complete.');
      return;
    }

    await fetch('/.netlify/functions/batch-control', {
      method: 'POST',
      body: JSON.stringify({ action: 'resume' })
    }).catch(console.error);

    fireBatches(missing);
    setRunStatus('running');
    startPolling();
    alert(`Resumed the run — filling in the ${missing.length} remaining games.`);
  };

  // Stop polling once every game has been persisted.
  useEffect(() => {
    if (completedCount >= TOTAL_BACKGROUND_GAMES) {
      stopPolling();
    }
  }, [completedCount]);

  // Download the current Excel status at any point. This exports only the
  // persisted 300-game batch (whatever is finished so far) — the spectator
  // demo is never mixed in.
  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch('/.netlify/functions/list-games');
      const data = await res.json();

      const completedGames = (data.games || []).filter(
        (g: any) => (g.finalState?.history?.length ?? 0) > 0
      );

      // Keep the tracker in sync with the authoritative count from storage.
      setCompletedCount(completedGames.length);

      if (completedGames.length === 0) {
        alert('No completed games to export yet. Start the 300-game run first.');
        return;
      }

      exportToExcel(completedGames);
    } catch (e) {
      console.error(e);
      alert('Failed to download excel');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div>
      <div className="header" style={{ marginBottom: '2rem' }}>
        <h1>Live Simulation Monitor</h1>
        <p>Spectator Demo — a standalone live game, independent of the 300-game batch</p>
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
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>Run the full, independent 300-game simulation in the background. You can stop and resume it at any time, and download the current Excel results whenever you like.</p>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={startBackgroundBatch} disabled={runStatus === 'running'}>
            <FastForward size={18} style={{ marginRight: '0.5rem' }} />
            Start 300 Background Games
          </button>

          <button
            className="btn"
            style={{ background: 'rgba(255,255,255,0.1)' }}
            onClick={stopBackgroundBatch}
            disabled={runStatus !== 'running'}
          >
            <Square size={18} style={{ marginRight: '0.5rem' }} />
            Stop Run
          </button>

          <button
            className="btn"
            style={{ background: 'rgba(255,255,255,0.1)' }}
            onClick={resumeBackgroundBatch}
            disabled={runStatus === 'running' || completedCount >= TOTAL_BACKGROUND_GAMES}
          >
            <Play size={18} style={{ marginRight: '0.5rem' }} />
            Resume Run
          </button>

          <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={handleDownload} disabled={downloading}>
            <Download size={18} style={{ marginRight: '0.5rem' }} />
            {downloading ? 'Preparing Excel...' : 'Download Current Results'}
          </button>
        </div>

        {(tracking || completedCount > 0) && (
           <div style={{ marginTop: '1.5rem' }}>
             <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
               {completedCount} / {TOTAL_BACKGROUND_GAMES} games completed and saved
               {runStatus === 'running' && ' · running'}
               {runStatus === 'stopped' && ' · stopped'}
               .
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
