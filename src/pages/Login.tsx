import React, { useState } from 'react';
import { Lock } from 'lucide-react';

interface LoginProps {
  onSuccess: () => void;
}

const Login: React.FC<LoginProps> = ({ onSuccess }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/.netlify/functions/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        sessionStorage.setItem('mz_authed', '1');
        onSuccess();
        return;
      }

      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Sign in failed.');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: '420px', margin: '6rem auto' }}>
      <div className="header">
        <h1>Mantzikert Simulation</h1>
        <p>Protected access</p>
      </div>

      <form className="glass-panel" onSubmit={handleSubmit}>
        <div className="input-group">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter the site password"
          />
        </div>

        {error && (
          <p style={{ color: '#ff8585', fontSize: '0.85rem', marginTop: '0.75rem' }}>{error}</p>
        )}

        <button
          className="btn btn-primary"
          type="submit"
          style={{ width: '100%', marginTop: '1.5rem' }}
          disabled={submitting || password.length === 0}
        >
          <Lock size={18} style={{ marginRight: '0.5rem' }} />
          {submitting ? 'Checking…' : 'Sign In'}
        </button>
      </form>
    </div>
  );
};

export default Login;
