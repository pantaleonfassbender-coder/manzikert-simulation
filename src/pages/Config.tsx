import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Play } from 'lucide-react';
import { MODEL_NAMES } from '../engine/models';

const Config: React.FC = () => {
  const navigate = useNavigate();

  const handleStart = () => {
    navigate('/dashboard');
  };

  return (
    <div style={{ maxWidth: '600px', margin: '4rem auto' }}>
      <div className="header">
        <h1>Manzikert Simulation</h1>
        <p>1071 Agentic Strategy Test Case</p>
      </div>

      <div className="glass-panel">
        <h2 style={{ marginBottom: '1.5rem', color: 'var(--text-primary)' }}>Configuration</h2>
        <p style={{ marginBottom: '2rem', color: 'var(--text-secondary)' }}>
          Inference runs through Netlify AI Gateway, so no API keys are required. OpenAI, Gemini and
          Anthropic each take a turn playing every faction across the 300-game simulation. This setup
          uses {MODEL_NAMES.openai}, {MODEL_NAMES.gemini} and {MODEL_NAMES.claude}.
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
