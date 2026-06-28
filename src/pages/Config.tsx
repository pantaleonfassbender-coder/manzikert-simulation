import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, RotateCcw } from 'lucide-react';
import { MODEL_NAMES } from '../engine/models';
import type { GameState } from '../engine/types';

const SAVED_GAME_KEY = 'mantzikert-spectator-state';

function getSavedGame(): GameState | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(SAVED_GAME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GameState;
    return parsed?.gameId === 'game-spectator' ? parsed : null;
  } catch {
    return null;
  }
}

const Config: React.FC = () => {
  const navigate = useNavigate();
  const savedGame = getSavedGame();
  const hasSavedRun = Boolean(savedGame && savedGame.history.length > 0);

  const handleStart = (mode: 'new' | 'resume') => {
    if (mode === 'new') {
      window.localStorage.removeItem(SAVED_GAME_KEY);
    }
    navigate('/dashboard');
  };

  return (
    <div className="config-page">
      <div className="header">
        <h1>Mantzikert Simulation</h1>
        <p>1071 Agentic Strategy Test Case</p>
      </div>

      <div className="glass-panel config-panel">
        <div>
          <p className="eyebrow">Configuration</p>
          <h2>AI Gateway Battle Run</h2>
        </div>
        <p className="lede">
          Inference runs through Netlify AI Gateway, so no API keys are required. OpenAI, Gemini and
          Anthropic each take a turn playing every faction across the 300-game simulation. This setup
          uses {MODEL_NAMES.openai}, {MODEL_NAMES.gemini} and {MODEL_NAMES.claude}.
        </p>

        {hasSavedRun && (
          <div className="resume-strip">
            <div>
              <strong>Saved spectator run found</strong>
              <span>
                Round {Math.min(savedGame?.currentRound ?? 1, 12)} of 12
                {savedGame?.winner ? `, winner: ${savedGame.winner}` : ''}
              </span>
            </div>
          </div>
        )}

        <div className="config-actions">
          <button className="btn btn-primary" onClick={() => handleStart('resume')}>
            {hasSavedRun ? <RotateCcw size={20} /> : <Play size={20} />}
            {hasSavedRun ? 'Resume Simulation' : 'Start Simulation'}
          </button>

          {hasSavedRun && (
            <button className="btn btn-secondary" onClick={() => handleStart('new')}>
              <Play size={20} />
              Start New Run
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Config;
