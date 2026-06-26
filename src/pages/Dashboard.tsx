import React, { useEffect, useState } from 'react';
import { Download, FastForward, Play, RefreshCw } from 'lucide-react';
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

interface BatchProgress {
  totalGames: number;
  completedGames: number;
  completedBatches: number;
  percent: number;
  status: 'not-started' | 'starting' | 'running' | 'complete' | string;
  startedAt: string | null;
  updatedAt: string | null;
  lastCompletedGameId: string | null;
}

const Dashboard: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(INITIAL_STATE);
  const [isPlaying, setIsPlaying] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [isStartingBatch, setIsStartingBatch] = useState(false);
  const [isCheckingProgress, setIsCheckingProgress] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const config: GameConfig = {
    gameId: 'game-spectator',
    roles: { emperor: 'openai', foes: 'gemini', seljuks: 'claude' }
  };

  const refreshBatchProgress = async () => {
    setIsCheckingProgress(true);
    try {
      const res = await fetch('/.netlify/functions/batch-progress');
      if (!res.ok) {
        throw new Error(`Progress request failed with status ${res.status}`);
      }
      setBatchProgress(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setIsCheckingProgress(false);
    }
  };

  useEffect(() => {
    refreshBatchProgress();
  }, []);

  useEffect(() => {
    if (!batchProgress || batchProgress.status === 'complete' || batchProgress.status === 'not-started') {
      return;
    }

    const interval = window.setInterval(refreshBatchProgress, 10000);
    return () => window.clearInterval(interval);
  }, [batchProgress?.status]);

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

  const startBackgroundBatch = async () => {
    setIsStartingBatch(true);
    const totalGames = 299;
    const batchSize = 10;
    const numBatches = Math.ceil(totalGames / batchSize);

    try {
      const progressRes = await fetch('/.netlify/functions/batch-progress', { method: 'POST' });
      if (!progressRes.ok) {
        throw new Error(`Progress initialization failed with status ${progressRes.status}`);
      }
      setBatchProgress(await progressRes.json());

      // Fire and forget chunks to Netlify background functions.
      for (let i = 0; i < numBatches; i++) {
        const startIndex = 1 + (i * batchSize);
        const count = Math.min(batchSize, totalGames - (startIndex - 1));

        fetch('/.netlify/functions/batch-games-background', {
          method: 'POST',
          body: JSON.stringify({ batchId: 'main', startIndex, count })
        }).catch(console.error);
      }

      window.setTimeout(refreshBatchProgress, 2500);
    } catch (e) {
      console.error(e);
      alert('Failed to start background games');
    } finally {
      setIsStartingBatch(false);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch('/.netlify/functions/list-games');
      const data = await res.json();
      
      // Merge spectator game with background games
      const allGames = [{ gameId: 'game-0', roles: config.roles, finalState: gameState }, ...(data.games || [])];
      exportToExcel(allGames);
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
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>Run the remaining 299 games in the background and export all data to Excel.</p>
        
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={startBackgroundBatch} disabled={isStartingBatch}>
            <FastForward size={18} style={{ marginRight: '0.5rem' }} /> 
            {isStartingBatch ? 'Starting...' : 'Start 299 Background Games'}
          </button>

          <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={refreshBatchProgress} disabled={isCheckingProgress}>
            <RefreshCw size={18} style={{ marginRight: '0.5rem' }} />
            {isCheckingProgress ? 'Checking...' : 'Refresh Progress'}
          </button>

          <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={handleDownload} disabled={downloading}>
            <Download size={18} style={{ marginRight: '0.5rem' }} /> 
            {downloading ? 'Preparing Excel...' : 'Download Results'}
          </button>
        </div>

        {batchProgress && batchProgress.status !== 'not-started' && (
           <div style={{ marginTop: '1.5rem' }}>
             <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
               <span>Status: <strong style={{ color: 'var(--text-primary)' }}>{batchProgress.status}</strong></span>
               <span>{batchProgress.completedGames} / {batchProgress.totalGames} games complete</span>
               {batchProgress.lastCompletedGameId && <span>Last saved: {batchProgress.lastCompletedGameId}</span>}
             </div>
             <div className="progress-bar">
               <div className="progress-fill" style={{ width: `${batchProgress.percent}%` }}></div>
             </div>
             <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.75rem' }}>
               Started: {batchProgress.startedAt ? new Date(batchProgress.startedAt).toLocaleString() : 'pending'}
               {batchProgress.updatedAt ? ` | Last update: ${new Date(batchProgress.updatedAt).toLocaleString()}` : ''}
             </p>
           </div>
        )}
      </div>

    </div>
  );
};

export default Dashboard;
