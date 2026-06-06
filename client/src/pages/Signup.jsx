import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { API } from '../lib/api';

export default function Signup() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handleChange(e) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const url = `${API}/api/auth/signup`;
      console.log('[slabr] Signup fetch →', url);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Signup failed');
        return;
      }
      login(data.token, data.user);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      console.error('[slabr] Signup fetch error:', err.name, err.message);
      setError('Network error — is the server running?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#09090b] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-9 h-9 rounded-xl bg-indigo-500 flex items-center justify-center">
            <span className="text-white font-bold">S</span>
          </div>
          <span className="text-white text-xl font-bold tracking-tight">Slabr</span>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
          <h1 className="text-white text-xl font-semibold mb-1">Create your account</h1>
          <p className="text-zinc-500 text-sm mb-6">Start tracking your collection</p>

          {error && (
            <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-zinc-400 text-xs font-medium mb-1.5 uppercase tracking-wider">
                Email
              </label>
              <input
                type="email"
                name="email"
                value={form.email}
                onChange={handleChange}
                required
                autoFocus
                placeholder="you@example.com"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-white text-sm placeholder-zinc-600
                           focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
              />
            </div>

            <div>
              <label className="block text-zinc-400 text-xs font-medium mb-1.5 uppercase tracking-wider">
                Username
              </label>
              <input
                type="text"
                name="username"
                value={form.username}
                onChange={handleChange}
                required
                placeholder="collector42"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-white text-sm placeholder-zinc-600
                           focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
              />
              <p className="mt-1.5 text-zinc-600 text-xs">3–30 characters, letters / numbers / _ -</p>
            </div>

            <div>
              <label className="block text-zinc-400 text-xs font-medium mb-1.5 uppercase tracking-wider">
                Password
              </label>
              <input
                type="password"
                name="password"
                value={form.password}
                onChange={handleChange}
                required
                placeholder="Min. 8 characters"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-white text-sm placeholder-zinc-600
                           focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed
                         text-white font-medium py-2.5 rounded-lg text-sm transition mt-2"
            >
              {loading ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="text-center text-zinc-600 text-sm mt-5">
          Already have an account?{' '}
          <Link to="/login" className="text-indigo-400 hover:text-indigo-300 transition">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
