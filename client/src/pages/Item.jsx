import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useAuth } from '../context/AuthContext';

function fmt$(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1000)      return `$${(n / 1000).toFixed(1)}K`;
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const SOURCE_STYLE = {
  ebay:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  ximilar: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  manual:  'bg-amber-500/10 text-amber-400 border-amber-500/20',
  mock:    'bg-zinc-500/10 text-zinc-500 border-zinc-700',
};
const SOURCE_LABEL = {
  ebay:    'Powered by eBay',
  ximilar: 'Powered by Ximilar',
  manual:  'Owner Estimated',
  mock:    'Mock Data',
};

const CERT_URL = {
  PSA:     n => `https://www.psacard.com/cert/${n}`,
  BGS:     () => 'https://www.beckett.com/grading/verify',
  BECKETT: () => 'https://www.beckett.com/grading/verify',
  CGC:     n => `https://www.cgccomics.com/certlookup/${n}`,
};

const INPUT = 'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500';

export default function Item() {
  const { id }    = useParams();
  const { token } = useAuth();
  const navigate  = useNavigate();

  const [item, setItem]                     = useState(null);
  const [priceHistory, setPriceHistory]     = useState([]);
  const [comparableSales, setComparableSales] = useState([]);
  const [range, setRange]                   = useState('30d');
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState('');
  const [editOpen, setEditOpen]             = useState(false);
  const [editForm, setEditForm]             = useState({});
  const [saving, setSaving]                 = useState(false);
  const [deleteConfirm, setDeleteConfirm]   = useState(false);

  // 1/1 manual value editing
  const [editingManualValue, setEditingManualValue] = useState(false);
  const [manualValueInput, setManualValueInput]     = useState('');
  const [savingManualValue, setSavingManualValue]   = useState(false);

  useEffect(() => {
    const headers = { Authorization: `Bearer ${token}` };
    fetch(`/api/portfolio/${id}`, { headers })
      .then(r => r.json())
      .then(data => {
        if (data.error) { setError(data.error); return; }
        setItem(data);
        setPriceHistory(data.price_history ?? []);
        setComparableSales(data.comparable_sales ?? []);
        setManualValueInput(data.manual_value != null ? String(data.manual_value) : '');
        setEditForm({
          condition:        data.condition        ?? 'raw',
          grading_company:  data.grading_company  ?? '',
          grade:            data.grade            ?? '',
          cert_number:      data.cert_number      ?? '',
          quantity:         String(data.quantity  ?? 1),
          purchase_price:   data.purchase_price   != null ? String(data.purchase_price) : '',
          purchase_date:    data.purchase_date?.slice(0, 10) ?? '',
        });
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [id, token]);

  const chartData = useMemo(() => {
    if (!priceHistory.length) return [];
    const now    = Date.now();
    const cutoff = range === '30d' ? now - 30 * 86400_000 :
                   range === '90d' ? now - 90 * 86400_000 : null;
    return cutoff
      ? priceHistory.filter(r => new Date(r.date).getTime() >= cutoff)
      : priceHistory;
  }, [priceHistory, range]);

  async function handleSave() {
    setSaving(true);
    try {
      const body = {
        condition:       editForm.condition,
        grading_company: editForm.condition === 'graded' ? editForm.grading_company || null : null,
        grade:           editForm.condition === 'graded' ? editForm.grade || null : null,
        cert_number:     editForm.condition === 'graded' ? editForm.cert_number || null : null,
        quantity:        parseInt(editForm.quantity) || 1,
        purchase_price:  editForm.purchase_price !== '' ? parseFloat(editForm.purchase_price) : null,
        purchase_date:   editForm.purchase_date || null,
      };
      const res  = await fetch(`/api/portfolio/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setItem(prev => ({ ...prev, ...data }));
      setEditOpen(false);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveManualValue() {
    const val = parseFloat(manualValueInput);
    if (isNaN(val) || val <= 0) return;
    setSavingManualValue(true);
    try {
      const res = await fetch(`/api/portfolio/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ manual_value: val }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setItem(prev => ({ ...prev, manual_value: data.manual_value, manual_value_set_at: data.manual_value_set_at }));
      // Refresh price history to include new manual row
      setPriceHistory(prev => [...prev, {
        date: new Date().toISOString().slice(0, 10),
        value: String(val.toFixed(2)),
        source: 'manual',
      }]);
      setEditingManualValue(false);
    } catch (err) {
      alert(err.message);
    } finally {
      setSavingManualValue(false);
    }
  }

  async function handleDelete() {
    try {
      await fetch(`/api/portfolio/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      navigate('/dashboard', { replace: true });
    } catch (err) {
      alert(err.message);
    }
  }

  function setField(k) { return e => setEditForm(f => ({ ...f, [k]: e.target.value })); }

  if (loading) return (
    <div className="min-h-screen bg-[#09090b] flex items-center justify-center">
      <div className="w-7 h-7 rounded-full border-2 border-zinc-700 border-t-indigo-500 animate-spin" />
    </div>
  );

  if (error || !item) return (
    <div className="min-h-screen bg-[#09090b] flex flex-col items-center justify-center gap-4">
      <span className="text-red-400 text-sm">{error || 'Item not found'}</span>
      <Link to="/dashboard" className="text-indigo-400 text-sm hover:underline">Back to portfolio</Link>
    </div>
  );

  const isOneOfOne  = item.is_one_of_one === true;
  const displayValue = isOneOfOne
    ? (item.manual_value != null ? parseFloat(item.manual_value) : null)
    : parseFloat(item.current_value ?? item.ph_value ?? 0);
  const cost       = item.purchase_price != null ? parseFloat(item.purchase_price) : null;
  const totalValue = displayValue != null ? displayValue * item.quantity : null;
  const totalCost  = cost != null ? cost * item.quantity : null;
  const gain       = totalValue != null && totalCost != null ? totalValue - totalCost : null;
  const gainPct    = gain != null && totalCost > 0 ? (gain / totalCost) * 100 : null;
  const src        = isOneOfOne ? 'manual' : (item.price_source ?? 'mock');
  const gradeLabel = item.condition === 'graded' && (item.grading_company || item.grade)
    ? [item.grading_company, item.grade].filter(Boolean).join(' ')
    : item.condition === 'raw' ? 'Raw' : null;
  const certLink   = item.cert_number
    ? (CERT_URL[(item.grading_company ?? '').toUpperCase()]?.(item.cert_number) ?? null)
    : null;

  return (
    <div className="min-h-screen bg-[#09090b]">
      {/* Nav */}
      <header className="border-b border-zinc-800 sticky top-0 bg-[#09090b]/95 backdrop-blur z-10">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link to="/dashboard" className="flex items-center gap-2 text-zinc-400 hover:text-white transition text-sm">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Portfolio
          </Link>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditOpen(true)}
              className="text-sm px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white transition"
            >
              Edit
            </button>
            {!deleteConfirm ? (
              <button
                onClick={() => setDeleteConfirm(true)}
                className="text-sm px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-500 hover:border-red-500/50 hover:text-red-400 transition"
              >
                Delete
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-red-400 text-xs">Are you sure?</span>
                <button onClick={handleDelete} className="text-xs px-2.5 py-1.5 rounded-lg bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition">
                  Confirm
                </button>
                <button onClick={() => setDeleteConfirm(false)} className="text-xs px-2.5 py-1.5 rounded-lg border border-zinc-700 text-zinc-500 hover:text-zinc-300 transition">
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

          {/* Left column — identity */}
          <div className="lg:col-span-2 space-y-5">

            {/* Image */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl aspect-[3/4] flex items-center justify-center overflow-hidden relative">
              {isOneOfOne && (
                <div className="absolute top-3 left-3 z-10">
                  <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-gradient-to-r from-amber-500 to-yellow-400 text-black shadow-lg shadow-amber-500/30">
                    1 of 1
                  </span>
                </div>
              )}
              {item.image_url
                ? <img src={item.image_url} alt={item.name} className="w-full h-full object-contain p-6" />
                : <ItemIcon type={item.item_type} />
              }
            </div>

            {/* Identity */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-white font-semibold text-lg leading-tight">{item.name}</p>
                  {item.set_name && <p className="text-zinc-400 text-sm mt-0.5">{item.set_name}</p>}
                </div>
                {gradeLabel && (
                  <span className="shrink-0 bg-indigo-500/20 text-indigo-300 text-xs font-bold px-2.5 py-1 rounded-full">
                    {gradeLabel}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                {item.year        && <Row label="Year"        value={item.year} />}
                {item.card_number && <Row label="Card #"      value={item.card_number} />}
                {item.sport_game  && <Row label="Sport/Game"  value={item.sport_game} />}
                {item.variation   && <Row label="Variation"   value={item.variation} />}
                {item.rarity      && <Row label="Rarity"      value={item.rarity} />}
                {item.brand_publisher && <Row label="Publisher" value={item.brand_publisher} />}
                <Row label="Quantity" value={item.quantity} />
                {item.purchase_date && <Row label="Purchased"  value={fmtDate(item.purchase_date)} />}
              </div>

              {certLink && (
                <a
                  href={certLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 hover:border-indigo-500/50 rounded-lg px-3 py-2 transition w-full justify-center"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  Verify Cert #{item.cert_number}
                </a>
              )}
            </div>
          </div>

          {/* Right column — pricing */}
          <div className="lg:col-span-3 space-y-5">

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3">
              {isOneOfOne ? (
                /* 1/1: Owner Estimated Value instead of Current Value */
                <div className="bg-zinc-900 border border-amber-500/20 rounded-xl px-4 py-3">
                  <p className="text-amber-500/70 text-[10px] font-medium uppercase tracking-wider mb-0.5">Owner Est.</p>
                  {editingManualValue ? (
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="text-amber-400 text-sm">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={manualValueInput}
                        onChange={e => setManualValueInput(e.target.value)}
                        className="w-full bg-zinc-800 border border-amber-500/30 rounded px-1.5 py-0.5 text-white text-sm focus:outline-none focus:border-amber-500"
                        autoFocus
                      />
                      <button
                        onClick={handleSaveManualValue}
                        disabled={savingManualValue}
                        className="shrink-0 text-xs bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded hover:bg-amber-500/30 transition disabled:opacity-50"
                      >
                        {savingManualValue ? '…' : '✓'}
                      </button>
                      <button onClick={() => setEditingManualValue(false)} className="shrink-0 text-zinc-500 hover:text-zinc-300 text-xs">✕</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <p className="text-base font-semibold text-amber-400">
                        {item.manual_value != null ? fmt$(parseFloat(item.manual_value)) : '—'}
                      </p>
                      <button
                        onClick={() => setEditingManualValue(true)}
                        className="text-zinc-600 hover:text-zinc-400 transition"
                        title="Update estimated value"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                    </div>
                  )}
                  {item.manual_value_set_at && (
                    <p className="text-zinc-600 text-[10px] mt-0.5">Updated {fmtDate(item.manual_value_set_at)}</p>
                  )}
                </div>
              ) : (
                <StatCard label="Current Value" value={totalValue != null ? fmt$(totalValue) : '—'} />
              )}
              <StatCard label="Cost Basis" value={totalCost != null ? fmt$(totalCost) : '—'} />
              <StatCard
                label="Gain / Loss"
                value={gain != null ? (gain >= 0 ? '+' : '') + fmt$(gain) : '—'}
                sub={gainPct != null ? `${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%` : null}
                positive={gain != null ? gain >= 0 : null}
              />
            </div>

            {/* Price history chart */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-5">
                <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider">Price History</p>
                <div className="flex items-center bg-zinc-800 rounded-lg p-0.5 gap-0.5">
                  {['30d', '90d', 'All'].map(r => (
                    <button
                      key={r}
                      onClick={() => setRange(r)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                        range === r ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              {chartData.length > 1 ? (
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={chartData} margin={{ top: 2, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#71717a', fontSize: 10 }}
                      tickFormatter={d => { const [, m, day] = d.split('-'); return `${m}/${day}`; }}
                    />
                    <YAxis
                      tick={{ fill: '#71717a', fontSize: 10 }}
                      width={56}
                      tickFormatter={v => v >= 1000 ? `$${(v/1000).toFixed(0)}K` : `$${v}`}
                    />
                    <Tooltip
                      contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8 }}
                      labelStyle={{ color: '#a1a1aa', fontSize: 11 }}
                      formatter={v => [fmt$(parseFloat(v)), 'Value']}
                    />
                    <Line type="monotone" dataKey="value" stroke={isOneOfOne ? '#f59e0b' : '#6366f1'} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[180px] flex items-center justify-center text-zinc-600 text-sm">
                  Not enough price history to chart
                </div>
              )}
            </div>

            {/* Pricing details */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3">
              <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider">Pricing</p>

              {/* Sold Median — hidden for 1/1, replaced with note */}
              {isOneOfOne ? (
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500 text-sm italic">No sold comps — this is a 1 of 1</span>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-zinc-500 text-sm">Sold Median</span>
                    {src === 'ebay' && <p className="text-zinc-600 text-xs">Sold on eBay</p>}
                  </div>
                  <span className="text-zinc-300 text-sm font-medium">
                    {item.ph_value != null ? fmt$(item.ph_value) : '—'}
                  </span>
                </div>
              )}

              {/* Active Listings — always shown */}
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-zinc-500 text-sm">Active Listings</span>
                  {src === 'ebay' && <p className="text-zinc-600 text-xs">Listed on eBay</p>}
                </div>
                <span className="text-zinc-300 text-sm font-medium">
                  {item.active_low != null ? fmt$(item.active_low) : '—'}
                </span>
              </div>

              {/* 30-day Forecast — hidden for 1/1 */}
              {!isOneOfOne && item.forecast_30d != null && (
                <div className="flex items-center justify-between pt-1">
                  <span className="text-zinc-500 text-sm">30-day Forecast</span>
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${parseFloat(item.forecast_30d) >= (displayValue ?? 0) ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmt$(item.forecast_30d)}
                    </span>
                    <span className={`text-xs ${parseFloat(item.forecast_30d) >= (displayValue ?? 0) ? 'text-emerald-500' : 'text-red-500'}`}>
                      {parseFloat(item.forecast_30d) >= (displayValue ?? 0) ? '↑' : '↓'}
                    </span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
                <span className={`text-[10px] border px-2 py-0.5 rounded-full ${SOURCE_STYLE[src] ?? SOURCE_STYLE.mock}`}>
                  {SOURCE_LABEL[src] ?? 'Mock Data'}
                </span>
                {item.price_updated_at && (
                  <span className="text-zinc-600 text-xs">Updated {fmtDate(item.price_updated_at)}</span>
                )}
              </div>
            </div>

            {/* Comparable Parallel Sales — 1/1 only */}
            {isOneOfOne && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
                <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider mb-1">
                  Comparable Parallel Sales
                </p>
                <p className="text-zinc-600 text-xs mb-4">
                  Reference prices from lower-numbered parallels of this card
                </p>

                {comparableSales.length === 0 ? (
                  <p className="text-zinc-600 text-sm text-center py-4">
                    No comparable sales data yet — check back after the next price update
                  </p>
                ) : (
                  <div className="divide-y divide-zinc-800">
                    {comparableSales.map((sale, i) => (
                      <div key={i} className="flex items-center justify-between py-2.5">
                        <div>
                          <span className="text-sm text-zinc-300 font-medium">{sale.parallel_label}</span>
                          {sale.sold_date && (
                            <p className="text-xs text-zinc-600 mt-0.5">
                              Sold {new Date(sale.sold_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-semibold text-emerald-400">{fmt$(sale.sold_price)}</span>
                          {sale.ebay_listing_url && (
                            <a
                              href={sale.ebay_listing_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-zinc-600 hover:text-zinc-400 transition"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      </main>

      {/* Edit modal */}
      {editOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-white font-semibold">Edit Item</h2>
              <button onClick={() => setEditOpen(false)} className="text-zinc-500 hover:text-white transition">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Condition */}
            <div>
              <label className="text-zinc-400 text-xs font-medium uppercase tracking-wider block mb-2">Condition</label>
              <div className="grid grid-cols-2 gap-2">
                {['raw', 'graded'].map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setEditForm(f => ({ ...f, condition: c }))}
                    className={`py-2 rounded-lg text-sm font-medium border transition ${
                      editForm.condition === c
                        ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                        : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'
                    }`}
                  >
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Grading fields */}
            {editForm.condition === 'graded' && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-zinc-500 text-xs block mb-1">Grading Co.</label>
                  <select value={editForm.grading_company} onChange={setField('grading_company')} className={INPUT}>
                    <option value="">—</option>
                    {['PSA','BGS','CGC','SGC'].map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-zinc-500 text-xs block mb-1">Grade</label>
                  <input type="text" value={editForm.grade} onChange={setField('grade')} placeholder="10" className={INPUT} />
                </div>
                <div>
                  <label className="text-zinc-500 text-xs block mb-1">Cert #</label>
                  <input type="text" value={editForm.cert_number} onChange={setField('cert_number')} placeholder="12345678" className={INPUT} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-zinc-500 text-xs block mb-1">Quantity</label>
                <input type="number" min="1" value={editForm.quantity} onChange={setField('quantity')} className={INPUT} />
              </div>
              <div>
                <label className="text-zinc-500 text-xs block mb-1">Purchase Price ($)</label>
                <input type="number" step="0.01" min="0" value={editForm.purchase_price} onChange={setField('purchase_price')} placeholder="0.00" className={INPUT} />
              </div>
            </div>

            <div>
              <label className="text-zinc-500 text-xs block mb-1">Purchase Date</label>
              <input type="date" value={editForm.purchase_date} onChange={setField('purchase_date')} className={INPUT} />
            </div>

            <div className="flex gap-3 pt-1">
              <button onClick={() => setEditOpen(false)} className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:border-zinc-600 transition">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium transition disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div>
      <p className="text-zinc-600 text-xs">{label}</p>
      <p className="text-zinc-300 text-sm font-medium mt-0.5">{value}</p>
    </div>
  );
}

function StatCard({ label, value, sub, positive }) {
  const col  = positive === true ? 'text-emerald-400' : positive === false ? 'text-red-400' : 'text-white';
  const sub2 = positive === false ? 'text-red-400' : 'text-emerald-400';
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
      <p className="text-zinc-500 text-[10px] font-medium uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-base font-semibold ${col}`}>{value}</p>
      {sub && <p className={`text-xs mt-0.5 ${sub2}`}>{sub}</p>}
    </div>
  );
}

function ItemIcon({ type }) {
  const cls = 'w-14 h-14 text-zinc-700';
  if (type === 'sports_card') return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M3 10h18M3 14h18M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z" />
    </svg>
  );
  return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  );
}
