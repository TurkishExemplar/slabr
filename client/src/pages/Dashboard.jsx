import React, { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import {
  LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useAuth } from '../context/AuthContext';
import { API } from '../lib/api';

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORY_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'sports_card', label: 'Sports' },
  { key: 'tcg', label: 'TCG' },
  { key: 'comic', label: 'Comics' },
  { key: 'sealed', label: 'Sealed' },
];

const CATEGORY_COLORS = {
  sports_card: '#3b82f6',
  tcg: '#a855f7',
  comic: '#f59e0b',
  sealed: '#22c55e',
};

const CATEGORY_LABELS = {
  sports_card: 'Sports',
  tcg: 'TCG',
  comic: 'Comics',
  sealed: 'Sealed',
};

const TYPE_BADGE = {
  sports_card: 'bg-blue-500/20 text-blue-400',
  tcg: 'bg-purple-500/20 text-purple-400',
  comic: 'bg-amber-500/20 text-amber-400',
  sealed: 'bg-emerald-500/20 text-emerald-400',
};

const PRICE_SOURCE_STYLE = {
  ebay:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  ximilar: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  manual:  'bg-amber-500/10 text-amber-400 border-amber-500/20',
  mock:    'bg-zinc-500/10 text-zinc-500 border-zinc-700',
};

const PRICE_SOURCE_LABEL = { ebay: 'eBay', ximilar: 'Ximilar', manual: 'Owner Est.', mock: 'Mock Data' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function effectiveValue(item) {
  if (item.is_one_of_one && item.manual_value != null) {
    return parseFloat(item.manual_value);
  }
  return parseFloat(item.current_value ?? item.ph_value ?? 0);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { user, token, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [items, setItems] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [categoryFilter, setCategoryFilter] = useState('all');
  const [conditionFilter, setConditionFilter] = useState('all');
  const [sortKey, setSortKey] = useState('date');

  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState(null); // { type: 'ok'|'warn'|'error', text }

  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Online/offline detection
  useEffect(() => {
    const goOn  = () => setIsOnline(true);
    const goOff = () => setIsOnline(false);
    window.addEventListener('online',  goOn);
    window.addEventListener('offline', goOff);
    return () => {
      window.removeEventListener('online',  goOn);
      window.removeEventListener('offline', goOff);
    };
  }, []);

  // Success toast when navigating back from Add page
  useEffect(() => {
    if (location.state?.added) {
      setRefreshMsg({ type: 'ok', text: 'Item added to portfolio' });
      setTimeout(() => setRefreshMsg(null), 3000);
      window.history.replaceState({}, '');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch(`${API}/api/portfolio`, { headers }).then(r => r.json()),
      fetch(`${API}/api/portfolio/history`, { headers }).then(r => r.json()),
    ])
      .then(([itemsData, historyData]) => {
        setItems(Array.isArray(itemsData) ? itemsData : []);
        setHistory(Array.isArray(historyData) ? historyData : []);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function loadPortfolio() {
    const headers = { Authorization: `Bearer ${token}` };
    const [itemsData, historyData] = await Promise.all([
      fetch(`${API}/api/portfolio`, { headers }).then(r => r.json()),
      fetch(`${API}/api/portfolio/history`, { headers }).then(r => r.json()),
    ]);
    setItems(Array.isArray(itemsData) ? itemsData : []);
    setHistory(Array.isArray(historyData) ? historyData : []);
  }

  async function handleRefreshPrices() {
    setRefreshing(true);
    setRefreshMsg(null);

    // 45s abort — eBay job can be slow for large collections
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);

    try {
      const res = await fetch(`${API}/api/admin/ebay-job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await res.json();

      if (data.skipped) {
        setRefreshMsg({ type: 'warn', text: 'eBay credentials not configured on Railway' });
        return;
      }

      await loadPortfolio();
      const n = data.updated ?? 0;
      setRefreshMsg({ type: 'ok', text: `Updated ${n} item${n !== 1 ? 's' : ''}` });
      setTimeout(() => setRefreshMsg(null), 4000);
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        // Job is still running server-side — reload data anyway
        try { await loadPortfolio(); } catch {}
        setRefreshMsg({ type: 'ok', text: 'Prices updating in the background…' });
        setTimeout(() => setRefreshMsg(null), 5000);
      } else {
        setRefreshMsg({ type: 'error', text: 'Refresh failed — check Railway logs' });
        setTimeout(() => setRefreshMsg(null), 5000);
      }
    } finally {
      setRefreshing(false);
    }
  }

  const stats = useMemo(() => {
    const totalValue = items.reduce((s, i) => s + effectiveValue(i) * i.quantity, 0);
    const hasCost = items.some(i => i.purchase_price != null);
    const totalCost = hasCost
      ? items.reduce((s, i) => s + (i.purchase_price != null ? parseFloat(i.purchase_price) * i.quantity : 0), 0)
      : null;
    const pl = totalCost != null ? totalValue - totalCost : null;
    const plPct = pl != null && totalCost > 0 ? (pl / totalCost) * 100 : null;
    return { totalValue, totalCost, pl, plPct };
  }, [items]);

  const pieData = useMemo(() => {
    const map = {};
    for (const item of items) {
      const v = effectiveValue(item) * item.quantity;
      map[item.item_type] = (map[item.item_type] || 0) + v;
    }
    return Object.entries(map)
      .filter(([, v]) => v > 0)
      .map(([type, value]) => ({ name: CATEGORY_LABELS[type] ?? type, value, type }));
  }, [items]);

  const filteredItems = useMemo(() => {
    const list = items.filter(item => {
      if (categoryFilter !== 'all' && item.item_type !== categoryFilter) return false;
      if (conditionFilter !== 'all' && item.condition !== conditionFilter) return false;
      return true;
    });

    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'value_desc':
          return effectiveValue(b) * b.quantity - effectiveValue(a) * a.quantity;
        case 'value_asc':
          return effectiveValue(a) * a.quantity - effectiveValue(b) * b.quantity;
        case 'name':
          return (a.name ?? '').localeCompare(b.name ?? '');
        case 'gain': {
          const gA = a.purchase_price != null
            ? (effectiveValue(a) - parseFloat(a.purchase_price)) * a.quantity : -Infinity;
          const gB = b.purchase_price != null
            ? (effectiveValue(b) - parseFloat(b.purchase_price)) * b.quantity : -Infinity;
          return gB - gA;
        }
        default: // 'date' — API already returns newest first
          return 0;
      }
    });
  }, [items, categoryFilter, conditionFilter, sortKey]);

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#09090b]">
        <header className="border-b border-zinc-800 h-14" />
        <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
          <div>
            <div className="h-7 w-28 bg-zinc-800 rounded-lg animate-pulse" />
            <div className="h-3.5 w-14 bg-zinc-800 rounded mt-2.5 animate-pulse" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-2xl px-5 py-4 space-y-3">
                <div className="h-3 w-20 bg-zinc-800 rounded animate-pulse" />
                <div className="h-6 w-24 bg-zinc-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
                <div className="aspect-[4/3] bg-zinc-800 animate-pulse" />
                <div className="p-4 space-y-3">
                  <div className="h-3 w-14 bg-zinc-800 rounded animate-pulse" />
                  <div className="h-4 w-full bg-zinc-800 rounded animate-pulse" />
                  <div className="h-3 w-2/3 bg-zinc-800 rounded animate-pulse" />
                  <div className="pt-2 border-t border-zinc-800">
                    <div className="h-5 w-20 bg-zinc-800 rounded animate-pulse" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center">
        <span className="text-red-400 text-sm">{error}</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#09090b]">
      {/* Offline banner */}
      {!isOnline && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 py-2 px-4 text-center text-amber-400 text-xs">
          You're offline — prices and search won't update until you reconnect
        </div>
      )}

      {/* Nav */}
      <header className="border-b border-zinc-800 sticky top-0 bg-[#09090b]/95 backdrop-blur z-10">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-indigo-500 flex items-center justify-center shrink-0">
              <span className="text-white text-xs font-bold">S</span>
            </div>
            <span className="text-white font-semibold tracking-tight">Slabr</span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to={`/profile/${user?.username}`}
              className="text-zinc-500 hover:text-white text-sm transition hidden sm:block"
            >
              @{user?.username}
            </Link>
            <Link
              to="/settings"
              className="text-zinc-500 hover:text-white transition hidden sm:block"
              title="Settings"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </Link>

            {/* Refresh Prices */}
            <button
              onClick={handleRefreshPrices}
              disabled={refreshing}
              title="Refresh prices from eBay"
              className="flex items-center gap-1.5 text-zinc-500 hover:text-white disabled:opacity-40 transition"
            >
              {refreshing
                ? <div className="w-4 h-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
                : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )
              }
              <span className="hidden sm:inline text-sm">
                {refreshing ? 'Refreshing…' : 'Refresh Prices'}
              </span>
            </button>

            <Link
              to="/add"
              className="bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium px-3 py-1.5 rounded-lg transition"
            >
              + Add Item
            </Link>
            <button onClick={handleLogout} className="text-zinc-500 hover:text-white text-sm transition">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">

        {/* Title */}
        <div>
          <h1 className="text-white text-2xl font-semibold">Portfolio</h1>
          <p className="text-zinc-500 text-sm mt-0.5">
            {items.length} item{items.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Total Value" value={fmt$(stats.totalValue)} />
          <StatCard label="Cost Basis"  value={stats.totalCost != null ? fmt$(stats.totalCost) : '—'} />
          <StatCard
            label="Gain / Loss"
            value={stats.pl != null ? (stats.pl >= 0 ? '+' : '') + fmt$(stats.pl) : '—'}
            sub={stats.plPct != null ? `${stats.plPct >= 0 ? '+' : ''}${stats.plPct.toFixed(1)}%` : null}
            positive={stats.pl != null ? stats.pl >= 0 : null}
          />
          <StatCard label="Items" value={String(items.length)} />
        </div>

        {/* Charts — only when portfolio has items */}
        {items.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Line chart */}
            <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
              <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider mb-5">
                Portfolio Value
              </p>
              {history.length > 1 ? (
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={history} margin={{ top: 2, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#71717a', fontSize: 10 }}
                      tickFormatter={d => { const [, m, day] = d.split('-'); return `${m}/${day}`; }}
                    />
                    <YAxis
                      tick={{ fill: '#71717a', fontSize: 10 }}
                      width={60}
                      tickFormatter={v => {
                        if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
                        if (v >= 1000) return `$${(v / 1000).toFixed(0)}K`;
                        return `$${v}`;
                      }}
                    />
                    <Tooltip
                      contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8 }}
                      labelStyle={{ color: '#a1a1aa', fontSize: 11 }}
                      formatter={v => [fmt$(parseFloat(v)), 'Value']}
                    />
                    <Line
                      type="monotone"
                      dataKey="total_value"
                      stroke="#6366f1"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: '#6366f1' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[180px] flex flex-col items-center justify-center gap-1.5">
                  <p className="text-zinc-600 text-sm">No price history yet</p>
                  <p className="text-zinc-700 text-xs">Prices update daily · use Refresh Prices to fetch now</p>
                </div>
              )}
            </div>

            {/* Pie chart */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
              <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider mb-5">
                By Category
              </p>
              {pieData.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={140}>
                    <PieChart>
                      <Pie
                        data={pieData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%" cy="50%"
                        innerRadius={40} outerRadius={62}
                        strokeWidth={0}
                      >
                        {pieData.map(entry => (
                          <Cell key={entry.type} fill={CATEGORY_COLORS[entry.type] ?? '#6366f1'} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8 }}
                        formatter={v => [fmt$(parseFloat(v)), '']}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="mt-3 space-y-2">
                    {pieData.map(entry => (
                      <div key={entry.type} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: CATEGORY_COLORS[entry.type] }} />
                          <span className="text-zinc-400">{entry.name}</span>
                        </div>
                        <span className="text-zinc-500">{fmt$(entry.value)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="h-[140px] flex items-center justify-center text-zinc-600 text-sm">No data</div>
              )}
            </div>
          </div>
        )}

        {/* Filters */}
        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            {/* Category */}
            <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-xl p-1 gap-0.5">
              {CATEGORY_FILTERS.map(f => (
                <button
                  key={f.key}
                  onClick={() => setCategoryFilter(f.key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    categoryFilter === f.key
                      ? 'bg-zinc-700 text-white'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Condition */}
            <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-xl p-1 gap-0.5">
              {['all', 'graded', 'raw'].map(c => (
                <button
                  key={c}
                  onClick={() => setConditionFilter(c)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    conditionFilter === c
                      ? 'bg-zinc-700 text-white'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {c === 'all' ? 'All' : c.charAt(0).toUpperCase() + c.slice(1)}
                </button>
              ))}
            </div>

            {filteredItems.length !== items.length && (
              <span className="text-zinc-600 text-xs">
                {filteredItems.length} of {items.length}
              </span>
            )}

            {/* Sort */}
            <select
              value={sortKey}
              onChange={e => setSortKey(e.target.value)}
              className="ml-auto bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-400
                         focus:outline-none focus:border-indigo-500 transition appearance-none cursor-pointer"
            >
              <option value="date">Date Added</option>
              <option value="value_desc">Value ↓</option>
              <option value="value_asc">Value ↑</option>
              <option value="name">Name A–Z</option>
              <option value="gain">Gain ↓</option>
            </select>
          </div>
        )}

        {/* Collection */}
        {items.length === 0 ? (
          <EmptyState />
        ) : filteredItems.length === 0 ? (
          <div className="text-center py-16 text-zinc-600 text-sm">
            No items match the selected filters
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredItems.map(item => <ItemCard key={item.id} item={item} />)}
          </div>
        )}

      </main>

      {/* Refresh-prices toast */}
      {refreshMsg && (
        <div className={`fixed bottom-5 right-5 z-50 flex items-center gap-2 px-4 py-3 rounded-xl border text-sm shadow-2xl transition-all ${
          refreshMsg.type === 'ok'    ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300' :
          refreshMsg.type === 'warn'  ? 'bg-amber-500/20  border-amber-500/30  text-amber-300'    :
                                        'bg-red-500/20     border-red-500/30     text-red-300'
        }`}>
          {refreshMsg.text}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, positive }) {
  const valueColor =
    positive === true  ? 'text-emerald-400' :
    positive === false ? 'text-red-400'     : 'text-white';
  const subColor = positive === false ? 'text-red-400' : 'text-emerald-400';

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl px-5 py-4">
      <p className="text-zinc-500 text-xs font-medium uppercase tracking-wider mb-2">{label}</p>
      <p className={`text-xl font-semibold ${valueColor}`}>{value}</p>
      {sub && <p className={`text-xs mt-0.5 ${subColor}`}>{sub}</p>}
    </div>
  );
}

function ItemCard({ item }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const value = effectiveValue(item);
  const cost  = item.purchase_price != null ? parseFloat(item.purchase_price) : null;
  const totalValue = value * item.quantity;
  const totalCost  = cost != null ? cost * item.quantity : null;
  const gain       = totalCost != null ? totalValue - totalCost : null;
  const gainPct    = gain != null && totalCost > 0 ? (gain / totalCost) * 100 : null;
  const src        = item.is_one_of_one ? 'manual' : (item.price_source ?? 'mock');

  return (
    <Link to={`/item/${item.id}`} className="block bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden hover:border-zinc-700 transition">
      {/* Thumbnail */}
      <div className="aspect-[4/3] bg-zinc-800 flex items-center justify-center relative overflow-hidden">
        {item.image_url ? (
          <>
            {!imgLoaded && (
              <div className="absolute inset-0 bg-zinc-800 animate-pulse" />
            )}
            <img
              src={item.image_url}
              alt={item.name}
              loading="lazy"
              onLoad={() => setImgLoaded(true)}
              className={`w-full h-full object-contain p-4 transition-opacity duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
            />
          </>
        ) : (
          <ItemIcon type={item.item_type} />
        )}
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        {/* Type badge + year + 1/1 badge */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider ${TYPE_BADGE[item.item_type] ?? 'bg-zinc-700 text-zinc-400'}`}>
            {CATEGORY_LABELS[item.item_type] ?? item.item_type}
          </span>
          {item.year && <span className="text-zinc-600 text-xs">{item.year}</span>}
          {item.is_one_of_one && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
              1 of 1
            </span>
          )}
        </div>

        {/* Name + set */}
        <div>
          <p className="text-white text-sm font-medium leading-tight line-clamp-2">{item.name}</p>
          {item.set_name && <p className="text-zinc-500 text-xs mt-0.5">{item.set_name}</p>}
        </div>

        {/* Grade badge */}
        {item.condition === 'graded' && (item.grading_company || item.grade) && (
          <span className="inline-block bg-indigo-500/20 text-indigo-400 text-[10px] font-bold px-2 py-0.5 rounded-full">
            {[item.grading_company, item.grade].filter(Boolean).join(' ')}
          </span>
        )}

        {/* Pricing */}
        <div className="pt-1 border-t border-zinc-800 space-y-1.5">
          <div className="flex items-end justify-between">
            <span className="text-white text-base font-semibold">{fmt$(totalValue)}</span>
            {item.quantity > 1 && <span className="text-zinc-600 text-xs">× {item.quantity}</span>}
          </div>

          {totalCost != null && (
            <div className="flex items-center justify-between">
              <span className="text-zinc-600 text-xs">Basis {fmt$(totalCost)}</span>
              {gainPct != null && (
                <span className={`text-xs font-medium ${gain >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {gain >= 0 ? '+' : ''}{gainPct.toFixed(1)}%
                </span>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-0.5">
          <span className={`text-[10px] border px-1.5 py-0.5 rounded-full ${PRICE_SOURCE_STYLE[src] ?? PRICE_SOURCE_STYLE.mock}`}>
            {PRICE_SOURCE_LABEL[src] ?? 'Mock Data'}
          </span>
          <span className="text-zinc-600 text-[10px]">{fmtDate(item.price_updated_at)}</span>
        </div>
      </div>
    </Link>
  );
}

function ItemIcon({ type }) {
  const cls = 'w-10 h-10 text-zinc-700';
  if (type === 'sports_card') return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M3 10h18M3 14h18M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z" />
    </svg>
  );
  if (type === 'tcg') return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
    </svg>
  );
  if (type === 'comic') return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  );
  return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="border border-dashed border-zinc-800 rounded-2xl flex flex-col items-center justify-center py-20 gap-4">
      <div className="w-12 h-12 rounded-2xl bg-zinc-800/80 flex items-center justify-center">
        <svg className="w-6 h-6 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-zinc-400 text-sm font-medium">Your collection is empty</p>
        <p className="text-zinc-600 text-xs mt-1">Add your first item to start tracking</p>
      </div>
      <Link
        to="/add"
        className="bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition"
      >
        + Add your first item
      </Link>
    </div>
  );
}
