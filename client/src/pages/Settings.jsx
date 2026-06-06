import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { API } from '../lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusMsg({ msg }) {
  if (!msg) return null;
  return (
    <p
      className={`text-sm mt-3 ${
        msg.type === 'success' ? 'text-emerald-400' : 'text-red-400'
      }`}
    >
      {msg.text}
    </p>
  );
}

function SectionTitle({ children }) {
  return (
    <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest mb-4">
      {children}
    </h2>
  );
}

function InputField({ label, type = 'text', value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-xs text-zinc-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition"
      />
    </div>
  );
}

// ── Settings page ─────────────────────────────────────────────────────────────

export default function Settings() {
  const { user, token, login, logout } = useAuth();
  const navigate = useNavigate();

  // Profile form
  const [username, setUsername]   = useState('');
  const [email, setEmail]         = useState('');
  const [isPublic, setIsPublic]   = useState(true);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg]       = useState(null);

  // Password form
  const [currentPw, setCurrentPw]   = useState('');
  const [newPw, setNewPw]           = useState('');
  const [confirmPw, setConfirmPw]   = useState('');
  const [pwSaving, setPwSaving]     = useState(false);
  const [pwMsg, setPwMsg]           = useState(null);

  // Account stats
  const [stats, setStats]   = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);

  // ── Load current data ────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };

    fetch(`${API}/api/users/me/stats`, { headers })
      .then(r => r.json())
      .then(data => {
        setUsername(data.username ?? '');
        setEmail(data.email ?? '');
        setIsPublic(data.is_public ?? true);
        setStats(data);
        setStatsLoading(false);
      })
      .catch(() => setStatsLoading(false));
  }, [token]);

  // ── Save profile ─────────────────────────────────────────────────────────
  async function handleSaveProfile(e) {
    e.preventDefault();
    setProfileSaving(true);
    setProfileMsg(null);
    try {
      const res = await fetch(`${API}/api/users/me`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username, email, is_public: isPublic }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      // Update auth context so @username in the nav updates immediately
      login(token, { ...user, ...data });
      setProfileMsg({ type: 'success', text: 'Profile updated.' });
    } catch (err) {
      setProfileMsg({ type: 'error', text: err.message });
    } finally {
      setProfileSaving(false);
    }
  }

  // ── Save password ────────────────────────────────────────────────────────
  async function handleSavePassword(e) {
    e.preventDefault();
    if (newPw !== confirmPw) {
      setPwMsg({ type: 'error', text: 'New passwords do not match.' });
      return;
    }
    setPwSaving(true);
    setPwMsg(null);
    try {
      const res = await fetch(`${API}/api/users/me/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ current_password: currentPw, new_password: newPw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update password');
      setPwMsg({ type: 'success', text: 'Password updated.' });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (err) {
      setPwMsg({ type: 'error', text: err.message });
    } finally {
      setPwSaving(false);
    }
  }

  // ── Sign out ─────────────────────────────────────────────────────────────
  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  const joinDate = stats?.created_at
    ? new Date(stats.created_at).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : '—';

  return (
    <div className="min-h-screen bg-[#09090b] text-white">
      {/* Header */}
      <header className="border-b border-zinc-800 sticky top-0 bg-[#09090b]/95 backdrop-blur z-10">
        <div className="max-w-xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link
            to="/dashboard"
            className="flex items-center gap-1.5 text-zinc-400 hover:text-white transition text-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Dashboard
          </Link>

          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-indigo-500 flex items-center justify-center shrink-0">
              <span className="text-white text-xs font-bold">S</span>
            </div>
            <span className="text-white font-semibold tracking-tight text-sm">Settings</span>
          </div>

          <button
            onClick={handleLogout}
            className="text-sm text-zinc-500 hover:text-white transition"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="max-w-xl mx-auto px-4 py-8 space-y-10">

        {/* ── Profile section ─────────────────────────────────────────────── */}
        <section>
          <SectionTitle>Profile</SectionTitle>

          <form onSubmit={handleSaveProfile} className="space-y-4">
            <InputField
              label="Username"
              value={username}
              onChange={setUsername}
              placeholder="your_username"
            />
            <InputField
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
            />

            {/* Public/private toggle */}
            <div className="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
              <div>
                <p className="text-sm text-white font-medium">Public profile</p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {isPublic
                    ? 'Anyone can view your collection at /profile/' + (username || '…')
                    : 'Your collection is hidden from public view'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsPublic(v => !v)}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  isPublic ? 'bg-indigo-500' : 'bg-zinc-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    isPublic ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Profile link */}
            {isPublic && username && (
              <Link
                to={`/profile/${username}`}
                className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                View public profile
              </Link>
            )}

            <button
              type="submit"
              disabled={profileSaving}
              className="w-full bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition"
            >
              {profileSaving ? 'Saving…' : 'Save Profile'}
            </button>
            <StatusMsg msg={profileMsg} />
          </form>
        </section>

        {/* Divider */}
        <div className="border-t border-zinc-800" />

        {/* ── Password section ─────────────────────────────────────────────── */}
        <section>
          <SectionTitle>Change Password</SectionTitle>

          <form onSubmit={handleSavePassword} className="space-y-4">
            <InputField
              label="Current password"
              type="password"
              value={currentPw}
              onChange={setCurrentPw}
              placeholder="••••••••"
            />
            <InputField
              label="New password"
              type="password"
              value={newPw}
              onChange={setNewPw}
              placeholder="Min 8 characters"
            />
            <InputField
              label="Confirm new password"
              type="password"
              value={confirmPw}
              onChange={setConfirmPw}
              placeholder="••••••••"
            />

            <button
              type="submit"
              disabled={pwSaving || !currentPw || !newPw || !confirmPw}
              className="w-full bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition"
            >
              {pwSaving ? 'Updating…' : 'Update Password'}
            </button>
            <StatusMsg msg={pwMsg} />
          </form>
        </section>

        {/* Divider */}
        <div className="border-t border-zinc-800" />

        {/* ── Account stats section ────────────────────────────────────────── */}
        <section>
          <SectionTitle>Account</SectionTitle>

          {statsLoading ? (
            <div className="h-24 flex items-center justify-center">
              <div className="w-5 h-5 rounded-full border-2 border-zinc-700 border-t-indigo-500 animate-spin" />
            </div>
          ) : (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
              {[
                { label: 'Member since', value: joinDate },
                { label: 'Total items',  value: stats?.total_items ?? '—' },
                { label: 'Total scans',  value: stats?.total_scans ?? '—' },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-zinc-400">{label}</span>
                  <span className="text-sm text-white font-medium">{value}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Divider */}
        <div className="border-t border-zinc-800" />

        {/* ── Danger zone ──────────────────────────────────────────────────── */}
        <section className="pb-8">
          <SectionTitle>Session</SectionTitle>
          <button
            onClick={handleLogout}
            className="w-full border border-zinc-700 hover:border-red-500/50 hover:text-red-400 text-zinc-400 text-sm font-medium py-2 rounded-lg transition"
          >
            Sign out
          </button>
        </section>

      </div>
    </div>
  );
}
