import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { API } from '../lib/api';

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORY_META = {
  sports_card: { label: 'Sports',  color: 'bg-blue-500/20 text-blue-400' },
  tcg:         { label: 'TCG',     color: 'bg-purple-500/20 text-purple-400' },
  comic:       { label: 'Comics',  color: 'bg-amber-500/20 text-amber-400' },
  sealed:      { label: 'Sealed',  color: 'bg-emerald-500/20 text-emerald-400' },
};

const TYPE_FILTER_MAP = {
  sports: 'sports_card',
  tcg:    'tcg',
  comics: 'comic',
  sealed: 'sealed',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  const num = parseFloat(n);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1000)      return `$${(num / 1000).toFixed(1)}K`;
  return `$${Number(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Read-only item card ───────────────────────────────────────────────────────

function ProfileItemCard({ item }) {
  const gradeBadge =
    item.condition === 'graded' && item.grade
      ? `${item.grading_company || ''} ${item.grade}`.trim()
      : item.condition === 'raw'
      ? 'Raw'
      : null;

  const meta = CATEGORY_META[item.item_type];

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
      {/* Image area */}
      <div className="aspect-[3/4] bg-zinc-800 flex items-center justify-center">
        {item.image_url ? (
          <img
            src={item.image_url}
            alt={item.name}
            className="w-full h-full object-contain"
          />
        ) : (
          <svg
            className="w-12 h-12 text-zinc-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        )}
      </div>

      <div className="p-3">
        <div className="flex items-start justify-between gap-2 mb-1">
          <p className="text-sm font-medium text-white leading-tight line-clamp-2">
            {item.name}
          </p>
          {gradeBadge && (
            <span className="shrink-0 text-xs font-bold bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">
              {gradeBadge}
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-500 mb-2">
          {item.set_name}
          {item.year ? ` · ${item.year}` : ''}
        </p>
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-white">
            {fmt(item.current_value ?? item.ph_value)}
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              meta?.color ?? 'bg-zinc-700 text-zinc-400'
            }`}
          >
            {meta?.label ?? item.item_type}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Profile page ──────────────────────────────────────────────────────────────

export default function Profile() {
  const { username } = useParams();
  const { user } = useAuth();

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');

  useEffect(() => {
    setLoading(true);
    setFetchError(null);
    fetch(`${API}/api/users/${encodeURIComponent(username)}`)
      .then(r => r.json())
      .then(data => {
        setProfile(data);
        setLoading(false);
      })
      .catch(() => {
        setFetchError('Failed to load profile');
        setLoading(false);
      });
  }, [username]);

  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-zinc-700 border-t-indigo-500 animate-spin" />
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (fetchError) {
    return (
      <div className="min-h-screen bg-[#09090b] flex flex-col items-center justify-center gap-4">
        <p className="text-zinc-400">{fetchError}</p>
        <Link to="/dashboard" className="text-indigo-400 hover:text-indigo-300 text-sm">
          ← Dashboard
        </Link>
      </div>
    );
  }

  // ── Not found ──────────────────────────────────────────────────────────────
  if (!profile || profile.error === 'User not found') {
    return (
      <div className="min-h-screen bg-[#09090b] flex flex-col items-center justify-center gap-4">
        <p className="text-zinc-400 text-lg">User not found</p>
        <Link to="/dashboard" className="text-indigo-400 hover:text-indigo-300 text-sm">
          ← Dashboard
        </Link>
      </div>
    );
  }

  // ── Private ────────────────────────────────────────────────────────────────
  if (!profile.is_public) {
    return (
      <div className="min-h-screen bg-[#09090b] flex flex-col items-center justify-center gap-4 px-6">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-8 h-8 text-zinc-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-white mb-2">This collection is private</h2>
          <p className="text-zinc-500 text-sm">
            @{profile.username} has set their profile to private.
          </p>
        </div>
        <Link to="/dashboard" className="text-indigo-400 hover:text-indigo-300 text-sm mt-2">
          ← Dashboard
        </Link>
      </div>
    );
  }

  // ── Public profile ─────────────────────────────────────────────────────────
  const isOwnProfile = user?.username?.toLowerCase() === username.toLowerCase();
  const { stats, items } = profile;

  const filtered =
    activeFilter === 'all'
      ? items
      : items.filter(i => i.item_type === TYPE_FILTER_MAP[activeFilter]);

  const joinDate = new Date(profile.created_at).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="min-h-screen bg-[#09090b] text-white">
      {/* Header */}
      <header className="border-b border-zinc-800 sticky top-0 bg-[#09090b]/95 backdrop-blur z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
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
            <span className="text-white font-semibold tracking-tight text-sm">Slabr</span>
          </div>

          {isOwnProfile ? (
            <Link
              to="/settings"
              className="text-sm text-indigo-400 hover:text-indigo-300 transition"
            >
              Settings
            </Link>
          ) : (
            <div className="w-16" />
          )}
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* Profile header */}
        <div className="flex items-center gap-4 mb-8">
          <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center text-2xl font-bold text-zinc-400 shrink-0">
            {username[0].toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold truncate">@{profile.username}</h1>
              {isOwnProfile && (
                <Link
                  to="/settings"
                  className="text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-700 rounded-full px-2 py-0.5 transition"
                >
                  Edit Profile
                </Link>
              )}
            </div>
            <p className="text-zinc-500 text-sm mt-0.5">Member since {joinDate}</p>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Items',   value: stats.total_items },
            { label: 'Value',   value: fmt(stats.total_value) },
            { label: 'Graded',  value: stats.graded_count },
            { label: 'Raw',     value: stats.raw_count },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-center"
            >
              <p className="text-base font-bold text-white">{value}</p>
              <p className="text-xs text-zinc-500 mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {/* Category breakdown badges */}
        {Object.entries(stats.categories).length > 0 && (
          <div className="flex flex-wrap gap-2 mb-6">
            {Object.entries(stats.categories).map(([type, count]) => {
              const meta = CATEGORY_META[type];
              return (
                <span
                  key={type}
                  className={`text-xs px-3 py-1 rounded-full ${
                    meta?.color ?? 'bg-zinc-700 text-zinc-400'
                  }`}
                >
                  {meta?.label ?? type} · {count}
                </span>
              );
            })}
          </div>
        )}

        {/* Filter bar */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-1 no-scrollbar">
          {['all', 'sports', 'tcg', 'comics', 'sealed'].map(f => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition ${
                activeFilter === f
                  ? 'bg-indigo-600 text-white'
                  : 'bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {/* Collection grid */}
        {items.length === 0 ? (
          <div className="text-center py-20 text-zinc-500">
            No items in this collection yet.
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-zinc-500">
            No {activeFilter} items in this collection.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {filtered.map(item => (
              <ProfileItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
