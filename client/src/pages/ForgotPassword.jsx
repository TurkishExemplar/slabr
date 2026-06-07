import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../lib/api';

const INPUT =
  'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-white text-sm ' +
  'placeholder-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition';

export default function ForgotPassword() {
  const [email,   setEmail]   = useState('');
  const [loading, setLoading] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [error,   setError]   = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Something went wrong');
        return;
      }
      setSent(true);
    } catch {
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
          {sent ? (
            /* Success state */
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-4">
                <svg className="w-6 h-6 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-white text-xl font-semibold mb-2">Check your email</h1>
              <p className="text-zinc-400 text-sm leading-relaxed">
                If <span className="text-zinc-200">{email}</span> has an account, you'll
                receive a reset link shortly. It expires in 1 hour.
              </p>
              <p className="text-zinc-600 text-xs mt-4">
                Didn't get it? Check your spam folder, or{' '}
                <button
                  onClick={() => { setSent(false); setEmail(''); }}
                  className="text-indigo-400 hover:text-indigo-300 transition"
                >
                  try again
                </button>
                .
              </p>
            </div>
          ) : (
            /* Form state */
            <>
              <h1 className="text-white text-xl font-semibold mb-1">Forgot password?</h1>
              <p className="text-zinc-500 text-sm mb-6">
                Enter your email and we'll send a reset link.
              </p>

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
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoFocus
                    placeholder="you@example.com"
                    className={INPUT}
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed
                             text-white font-medium py-2.5 rounded-lg text-sm transition mt-2"
                >
                  {loading ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-zinc-600 text-sm mt-5">
          <Link to="/login" className="text-indigo-400 hover:text-indigo-300 transition">
            ← Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
