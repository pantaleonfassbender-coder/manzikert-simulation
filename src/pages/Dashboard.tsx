import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, FastForward, Play, RotateCcw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { GameState, GameConfig } from '../engine/types';
import { createInitialState } from '../engine/engine';
import { exportToExcel } from '../utils/exportExcel';
import { MODEL_NAMES } from '../engine/models';

const SAVED_GAME_KEY = 'mantzikert-spectator-state';
const SAVED_PROGRESS_KEY = 'mantzikert-background-progress';

function loadSavedGame(): GameState {
  if (typeof window === 'undefined') return createInitialState('game-spectator');

  try {
    const raw = window.localStorage.getItem(SAVED_GAME_KEY);
    if (!raw) return createInitialState('game-spectator');
    const parsed = JSON.parse(raw) as GameState;
    return parsed?.gameId === 'game-spectator' ? parsed : createInitialState('game-spectator');
  } catch {
    return createInitialState('game-spectator');
  }
}

function loadSavedProgress(): number {
  if (typeof window === 'undefined') return 0;
  const parsed = Number(window.localStorage.getItem(SAVED_PROGRESS_KEY) ?? '0');
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
}

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [gameState, setGameState] = useState<GameState>(() => loadSavedGame());
  const [isPlaying, setIsPlaying] = useState(false);
  const [backgroundProgress, setBackgroundProgress] = useState(() => loadSavedProgress());
  const [batchStarted, setBatchStarted] = useState(() => loadSavedProgress() > 0);
  const [downloading, setDownloading] = useState(false);

  const config: GameConfig = useMemo(() => ({
    gameId: 'game-spectator',
    roles: { emperor: 'openai', foes: 'gemini', seljuks: 'claude' }
  }), []);

  useEffect(() => {
    window.localStorage.setItem(SAVED_GAME_KEY, JSON.stringify(gameState));
  }, [gameState]);

  useEffect(() => {
    window.localStorage.setItem(SAVED_PROGRESS_KEY, String(backgroundProgress));
  }, [backgroundProgress]);

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
    if (batchStarted) return;
    setBatchStarted(true);
    const totalGames = 299;
    const batchSize = 10;
    const numBatches = Math.ceil(totalGames / batchSize);
    
    // We fire and forget them in chunks to Netlify background functions
    // Note: Netlify free tier might rate limit concurrent background functions,
    // so we will just fire them off. In a real production system we'd use a queue.
    for (let i = 0; i < numBatches; i++) {
      const startIndex = 1 + (i * batchSize); // start at index 1 since 0 is spectator
      const count = Math.min(batchSize, totalGames - (startIndex - 1));
      
      fetch('/.netlify/functions/batch-games-background', {
        method: 'POST',
        body: JSON.stringify({ batchId: 'main', startIndex, count })
      }).catch(console.error);
    }
    
    alert('Started 299 games in the background. Check back in a few minutes to download results.');
    
    // Mock progress bar
    let prog = 0;
    const interval = setInterval(() => {
      prog += 5;
      setBackgroundProgress(Math.min(prog, 100));
      if (prog >= 100) clearInterval(interval);
    }, 10000);
  };

  const resetSpectatorRun = () => {
    const nextState = createInitialState('game-spectator');
    setGameState(nextState);
    window.localStorage.setItem(SAVED_GAME_KEY, JSON.stringify(nextState));
  };

  const latestRecord = gameState.history[gameState.history.length - 1];
  const roundLabel = gameState.currentRound > 12 ? 12 : gameState.currentRound;
  const completed = Boolean(gameState.winner || gameState.currentRound > 12);

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
    <div className="dashboard-page">
      <div className="dashboard-topbar">
        <button className="icon-button" type="button" onClick={() => navigate('/')}>
          <ArrowLeft size={18} />
          <span>Config</span>
        </button>
        <button className="icon-button" type="button" onClick={resetSpectatorRun}>
          <RotateCcw size={18} />
          <span>Reset Run</span>
        </button>
      </div>

      <div className="header dashboard-header">
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
             <div className="assessment">
                <em>"{latestRecord.allocations.emperor.selfAssessment}"</em>
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
             <div className="assessment">
                <em>"{latestRecord.allocations.foes.selfAssessment}"</em>
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
             <div className="assessment">
                <em>"{latestRecord.allocations.seljuks.selfAssessment}"</em>
             </div>
          )}
        </div>
      </div>

      <div className="glass-panel" style={{ marginTop: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2>Round {roundLabel} / 12</h2>
            {gameState.winner && <p style={{ color: 'var(--accent-color)', fontWeight: 'bold' }}>Winner: {gameState.winner.toUpperCase()}</p>}
          </div>
          <button 
            className="btn btn-primary"
            onClick={playNextRound}
            disabled={isPlaying || completed}
          >
            {isPlaying ? 'Computing...' : <><Play size={18} /> {gameState.history.length === 0 ? 'Start Spectator Round' : 'Resume Next Round'}</>}
          </button>
        </div>

        <div className="event-log">
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
          <button className="btn btn-primary" onClick={startBackgroundBatch} disabled={batchStarted}>
            <FastForward size={18} /> 
            {batchStarted ? 'Background Games Started' : 'Start 299 Background Games'}
          </button>

          <button className="btn btn-secondary" onClick={handleDownload} disabled={downloading}>
            <Download size={18} /> 
            {downloading ? 'Preparing Excel...' : 'Download Results'}
          </button>
        </div>

        {backgroundProgress > 0 && (
           <div style={{ marginTop: '1.5rem' }}>
             <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Background jobs initiated...</p>
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
