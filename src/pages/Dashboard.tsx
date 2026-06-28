import React, { useEffect, useRef, useState } from 'react';
import { Download, FastForward, Pause, Play } from 'lucide-react';
import type { GameState, GameConfig } from '../engine/types';
import { exportToExcel } from '../utils/exportExcel';
import { MODEL_NAMES } from '../engine/models';
import {
  BATCH_ID,
  MODEL_TAU,
  SAVED_BATCH_SIZE,
  SAVED_GAME_COUNT,
  type BatchStatus,
  createBatchStatus,
} from '../engine/batch';

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
  const [batchStatus, setBatchStatus] = useState<BatchStatus>(() => createBatchStatus());
  const [batchBusy, setBatchBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const batchLaunchInFlight = useRef(false);

  const config: GameConfig = {
    gameId: 'game-spectator',
    roles: { emperor: 'openai', foes: 'gemini', seljuks: 'claude' }
  };

  const refreshBatchStatus = async () => {
    const res = await fetch('/.netlify/functions/batch-control');
    if (!res.ok) {
      throw new Error(`Status request failed with status ${res.status}`);
    }
    const status = await res.json();
    setBatchStatus(status);
    return status as BatchStatus;
  };

  const runNextBatch = async (status: BatchStatus) => {
    if (
      batchLaunchInFlight.current ||
      status.state !== 'running' ||
      status.activeBatchStart !== null ||
      status.nextIndex >= status.totalGames
    ) {
      return;
    }

    batchLaunchInFlight.current = true;
    try {
      await fetch('/.netlify/functions/batch-games-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchId: BATCH_ID,
          startIndex: status.nextIndex,
          count: Math.min(status.batchSize, status.totalGames - status.nextIndex),
        }),
      });
      await refreshBatchStatus();
    } catch (error) {
      console.error(error);
    } finally {
      batchLaunchInFlight.current = false;
    }
  };

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await refreshBatchStatus();
        if (!cancelled) {
          await runNextBatch(status);
        }
      } catch (error) {
        console.error(error);
      }
    };

    poll();
    const interval = window.setInterval(poll, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
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

  const controlBatch = async (action: 'start' | 'pause' | 'resume') => {
    setBatchBusy(true);
    try {
      const res = await fetch('/.netlify/functions/batch-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        throw new Error(`Batch control failed with status ${res.status}`);
      }
      const status = await res.json();
      setBatchStatus(status);
      await runNextBatch(status);
    } catch (e) {
      console.error(e);
      alert('Batch control failed');
    } finally {
      setBatchBusy(false);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch('/.netlify/functions/list-games');
      const data = await res.json();
      
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
        <p>Independent spectator game. Saved 300-game run is monitored below.</p>
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
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          Saved games are independent from the displayed game, run in batches of {SAVED_BATCH_SIZE}, and use tau {MODEL_TAU} for every model call.
        </p>
        
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            onClick={() => controlBatch(batchStatus.state === 'paused' || batchStatus.state === 'error' ? 'resume' : 'start')}
            disabled={batchBusy || batchStatus.state === 'running'}
          >
            <FastForward size={18} style={{ marginRight: '0.5rem' }} /> 
            {batchStatus.state === 'paused' || batchStatus.state === 'error' ? 'Resume 300 Saved Games' : 'Start 300 Saved Games'}
          </button>

          <button
            className="btn"
            style={{ background: 'rgba(255,255,255,0.1)' }}
            onClick={() => controlBatch(batchStatus.state === 'paused' ? 'resume' : 'pause')}
            disabled={batchBusy || batchStatus.state === 'idle' || batchStatus.state === 'completed'}
          >
            {batchStatus.state === 'paused' ? <Play size={18} style={{ marginRight: '0.5rem' }} /> : <Pause size={18} style={{ marginRight: '0.5rem' }} />}
            {batchStatus.state === 'paused' ? 'Resume' : 'Stop'}
          </button>

          <button className="btn" style={{ background: 'rgba(255,255,255,0.1)' }} onClick={handleDownload} disabled={downloading}>
            <Download size={18} style={{ marginRight: '0.5rem' }} /> 
            {downloading ? 'Preparing Excel...' : 'Download Results'}
          </button>
        </div>

        <div style={{ marginTop: '1.5rem' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Status: {batchStatus.state}. Saved games completed: {batchStatus.completedGames} / {SAVED_GAME_COUNT}.
          </p>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${(batchStatus.completedGames / SAVED_GAME_COUNT) * 100}%` }}></div>
          </div>

          <div className="grid grid-cols-3" style={{ marginTop: '1rem' }}>
            {(['openai', 'gemini', 'claude'] as const).map((provider) => (
              <div key={provider} style={{ background: 'rgba(0,0,0,0.18)', borderRadius: '8px', padding: '1rem' }}>
                <strong>{MODEL_NAMES[provider]}</strong>
                <p style={{ margin: '0.5rem 0 0', color: 'var(--text-secondary)' }}>
                  Games played: {batchStatus.modelProgress[provider].total}
                </p>
                <p style={{ margin: '0.25rem 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  Emperor {batchStatus.modelProgress[provider].emperor} | Foes {batchStatus.modelProgress[provider].foes} | Seljuks {batchStatus.modelProgress[provider].seljuks}
                </p>
              </div>
            ))}
          </div>

          {batchStatus.lastError && (
            <p style={{ color: 'var(--foes-color)', marginTop: '1rem' }}>{batchStatus.lastError}</p>
          )}
        </div>
      </div>

      <div className="glass-panel" style={{ marginTop: '2rem' }}>
        <h2>Preregistration Check</h2>
        <p style={{ color: 'var(--text-secondary)' }}>
          The registered design is sampled from code constants: {SAVED_GAME_COUNT} saved games, {SAVED_BATCH_SIZE} games per batch,
          12 rounds per game, three role rotations of 100 games each, and tau {MODEL_TAU} for OpenAI, Gemini, and Claude.
          Runtime outcomes, allocations, messages, and winners are not preregistered facts; they are sampled only from completed model calls and saved game states.
        </p>
      </div>

      <div className="glass-panel" style={{ marginTop: '2rem' }}>
        <h2>Simulation Description</h2>
        <p style={{ color: 'var(--text-secondary)' }}>
          Each game starts with Emperor Romanos controlling the Mantzikert region, internal foes holding sabotage capability,
          and the Seljuks pressing the frontier. Every round asks the assigned model for each faction to allocate exactly 100
          action points across military, diplomacy, and internal politics, plus optional messages and a self-assessment.
        </p>
        <p style={{ color: 'var(--text-secondary)' }}>
          Resolution first adjusts imperial loyalty from emperor and foe internal spending, then computes military defense from
          imperial military spending reduced by loyalty and foe sabotage. Seljuk military spending shifts territory against that
          final defense. After round 12, the emperor wins by holding more than half the region with loyalty above 20; otherwise
          the Seljuks win on territorial collapse or the foes win on political overthrow.
        </p>
      </div>

    </div>
  );
};

export default Dashboard;
