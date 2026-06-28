import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Play } from 'lucide-react';
import { MODEL_NAMES } from '../engine/models';
import { MODEL_TAU, SAVED_BATCH_SIZE, SAVED_GAME_COUNT } from '../engine/batch';

const Config: React.FC = () => {
  const navigate = useNavigate();

  const handleStart = () => {
    navigate('/dashboard');
  };

  return (
    <div style={{ maxWidth: '600px', margin: '4rem auto' }}>
      <div className="header">
        <h1>Mantzikert Simulation</h1>
        <p>1071 Agentic Strategy Test Case</p>
      </div>

      <div className="glass-panel">
        <h2 style={{ marginBottom: '1.5rem', color: 'var(--text-primary)' }}>Configuration</h2>
        <p style={{ marginBottom: '2rem', color: 'var(--text-secondary)' }}>
          Inference runs through Netlify AI Gateway, so no API keys are required. OpenAI, Gemini and
          Anthropic each take a turn playing every faction across the saved {SAVED_GAME_COUNT}-game simulation.
          The dashboard game is a separate spectator game and is not included in the saved data. Saved games run
          in batches of {SAVED_BATCH_SIZE}; every model call uses tau {MODEL_TAU}. This setup uses {MODEL_NAMES.openai},
          {MODEL_NAMES.gemini} and {MODEL_NAMES.claude}.
        </p>

        <button
          className="btn btn-primary"
          style={{ width: '100%', marginTop: '1rem' }}
          onClick={handleStart}
        >
          <Play size={20} style={{ marginRight: '0.5rem' }} />
          Start Simulation
        </button>
      </div>
    </div>
  );
};

export default Config;
