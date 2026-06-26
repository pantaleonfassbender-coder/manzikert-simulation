import React, { useEffect, useRef, useState } from 'react';
import { Download, FastForward, Play } from 'lucide-react';
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

const Dashboard: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(INITIAL_STATE);
  const [isPlaying, setIsPlaying] = useState(false);
  const [backgroundProgress, setBackgroundProgress] = useState(0);
  const [completedBackgroundGames, setCompletedBackgroundGames] = useState(0);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState('Ready to launch background games.');
  const [downloading, setDownloading] = useState(false);
  const progressPollRef = useRef<number | null>(null);

  const config: GameConfig = {
    gameId: 'game-spectator',
    roles: { emperor: 'openai', foes: 'gemini', seljuks: 'claude' }
  };

  const refreshBackgroundProgress = async () => {
    const res = await fetch('/.netlify/functions/list-games');
    if (!res.ok) {
      throw new Error(`Progress request failed with status ${res.status}`);
    }

    const data = await res.json();
    const completed = Array.isArray(data.games) ? data.games.length : 0;

    setCompletedBackgroundGames(completed);
    setBackgroundProgress(Math.min(Math.round((completed / 299) * 100), 100));

    if (completed >= 299) {
      setBatchStatus('All 299 background games completed.');
      setIsBatchRunning(false);
      if (progressPollRef.current) {
        window.clearInterval(progressPollRef.current);
        progressPollRef.current = null;
      }
    } else {
      setBatchStatus(`Running background games: ${completed} of 299 completed.`);
    }
  };

  useEffect(() => {
    return () => {
      if (progressPollRef.current) {
        window.clearInterval(progressPollRef.current);
      }
    };
  }, []);

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
    if (isBatchRunning) return;

    const totalGames = 299;
    const batchSize = 10;
    const numBatches = Math.ceil(totalGames / batchSize);

    setIsBatchRunning(true);
    setBatchStatus('Launching background game batches...');
    setCompletedBackgroundGames(0);
    setBackgroundProgress(0);

    try {
      const launches = [];

      for (let i = 0; i < numBatches; i++) {
        const startIndex = 1 + (i * batchSize); // start at index 1 since 0 is spectator
        const count = Math.min(batchSize, totalGames - (startIndex - 1));

        launches.push(fetch('/.netlify/functions/batch-games-background', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchId: 'main', startIndex, count })
        }));
      }

      const responses = await Promise.allSettled(launches);
      const failedLaunches = responses.filter((result) => result.status === 'rejected' || !result.value.ok).length;

      setBatchStatus(
        failedLaunches > 0
          ? `${numBatches - failedLaunches} of ${numBatches} batches launched. Tracking completed games.`
          : 'All batches launched. Tracking completed games.'
      );

      await refreshBackgroundProgress();

      if (progressPollRef.current) {
        window.clearInterval(progressPollRef.current);
      }

      progressPollRef.current = window.setInterval(() => {
        refreshBackgroundProgress().catch((error) => {
          console.error(error);
          setBatchStatus('Progress check failed. Download may still become available after background jobs finish.');
        });
      }, 5000);
    } catch (e) {
      console.error(e);
      setBatchStatus('Failed to launch background games.');
      setIsBatchRunning(false);
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
        
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button className="btn btn-primary" onClick={startBackgroundBatch} disabled={isBatchRunning}>
            <FastForward size={18} style={{ marginRight: '0.5rem' }} /> 
            {isBatchRunning ? 'Launching Games...' : 'Start 299 Background Games'}
          </button>

          <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={handleDownload} disabled={downloading}>
            <Download size={18} style={{ marginRight: '0.5rem' }} /> 
            {downloading ? 'Preparing Excel...' : 'Download Results'}
          </button>
        </div>

        {(backgroundProgress > 0 || isBatchRunning) && (
           <div style={{ marginTop: '1.5rem' }}>
             <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
               {batchStatus} {completedBackgroundGames} / 299 games stored.
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
