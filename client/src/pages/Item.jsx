import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useAuth } from '../context/AuthContext';
import { API } from '../lib/api';
import { blendIfLightBackground } from '../lib/imageBlend';

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

// Market-value attribution — eBay never appears here: it is an
// active-listing source only, attributed inside the Active Listings section.
const SOURCE_STYLE = {
  pricecharting: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  manual:        'bg-amber-500/10 text-amber-400 border-amber-500/20',
  custom:        'bg-amber-500/10 text-amber-400 border-amber-500/20',
  mock:          'bg-zinc-500/10 text-zinc-500 border-zinc-700',
  none:          'bg-zinc-500/10 text-zinc-600 border-zinc-800',
};
const SOURCE_LABEL = {
  pricecharting: 'Market value via PriceCharting',
  manual:        'Owner Estimated',
  custom:        'Custom Value',
  mock:          'Mock Data',
  none:          'Not yet priced',
};

// Grade ladders for the edit form (mirrors the add form) — highest first.
const GENERIC_GRADES = ['10', '9.5', '9', '8.5', '8', '7.5', '7', '6.5', '6', '5.5', '5', '4.5', '4', '3.5', '3', '2.5', '2', '1.5', '1'];
const CGC_SCALE = ['10', '9.9', '9.8', '9.6', '9.4', '9.2', '9.0', '8.5', '8.0', '7.5', '7.0', '6.5', '6.0', '5.5', '5.0', '4.5', '4.0', '3.5', '3.0', '2.5', '2.0', '1.8', '1.5', '1.0', '0.5'];
const GRADE_OPTIONS = {
  PSA:  ['10', '9', '8', '7', '6', '5', '4', '3', '2', '1'],
  BGS:  ['10 Black Label', ...GENERIC_GRADES],
  SGC:  ['10', '9.5', '9', '8', '7', '6', '5', '4', '3', '2', '1'],
  CGC:  CGC_SCALE,
  CBCS: CGC_SCALE,
  PGX:  CGC_SCALE,
  TAG:  ['10', '9', '8', '7', '6', '5', '4', '3', '2', '1'],
};
const gradesFor = company => GRADE_OPTIONS[company] ?? GENERIC_GRADES;

const EBAY_ATTRIBUTION_STYLE = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';

// Multi-grade chart line colors — one per PriceCharting tier; unmapped
// (user-specific) grades fall back to emerald.  Grades 1–6 are derived from
// sold-listing medians (no native PC chart series).
const GRADE_COLORS = {
  'Ungraded':  '#71717a',
  'Grade 1':   '#fca5a5',
  'Grade 2':   '#f87171',
  'Grade 3':   '#fb923c',
  'Grade 4':   '#fbbf24',
  'Grade 5':   '#a3e635',
  'Grade 6':   '#4ade80',
  'Grade 7':   '#0ea5e9',
  'Grade 8':   '#14b8a6',
  'Grade 9':   '#6366f1',
  'Grade 9.5': '#8b5cf6',
  'PSA 10':    '#f59e0b',
};

// Canonical row order for the grade price table — works for "Grade 8.5",
// "PSA 10", and comic-format labels like "CGC 9.8" alike.
function gradeOrderKey(label) {
  if (label === 'Ungraded') return -1;
  const n = parseFloat(String(label).replace(/^[^0-9.]*/, ''));
  return isNaN(n) ? 50 : n;
}

// Line/dot color for any grade label — exact tier names first, then by the
// numeric grade (covers comic-format labels like "CGC 9.8").
function colorFor(label) {
  if (GRADE_COLORS[label]) return GRADE_COLORS[label];
  const n = parseFloat(String(label).replace(/^[^0-9.]*/, ''));
  if (isNaN(n))  return '#10b981';
  if (n >= 10)   return '#f59e0b';
  if (n >= 9.5)  return '#8b5cf6';
  if (n >= 9)    return '#6366f1';
  if (n >= 8)    return '#14b8a6';
  if (n >= 7)    return '#0ea5e9';
  if (n >= 6)    return '#4ade80';
  if (n >= 5)    return '#a3e635';
  if (n >= 4)    return '#fbbf24';
  if (n >= 3)    return '#fb923c';
  return '#f87171';
}

function truncateTitle(t, max = 60) {
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

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
  const [range, setRange]                   = useState('1Y');
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

  // Live eBay listings — fetched lazily after the main item data so the
  // page renders fast even when eBay is slow.
  const [listings, setListings]               = useState([]);
  const [listingsMeta, setListingsMeta]       = useState(null);
  const [listingsLoading, setListingsLoading] = useState(true);

  // Multi-grade market data: per-tier history series, grade price table,
  // recent sold listings for this item's grade
  const [market, setMarket] = useState(null);

  // Which grade line(s) the chart shows — null resolves to the user's grade
  // bucket once market data loads ('All' shows every line)
  const [gradeView, setGradeView] = useState(null);

  // Active Listings: collapsed shows 3, expanded shows all
  const [showAllListings, setShowAllListings] = useState(false);

  // Per-user custom image upload
  const [uploadingImg, setUploadingImg] = useState(false);
  const [imgMsg, setImgMsg]             = useState(null);
  const fileInputRef = useRef(null);

  // Custom valuation panel
  const [customValOpen, setCustomValOpen]     = useState(false);
  const [customValInput, setCustomValInput]   = useState('');
  const [customValSaving, setCustomValSaving] = useState(false);
  const [customValError, setCustomValError]   = useState('');

  // Inline name editing
  const [editingName, setEditingName]               = useState(false);
  const [nameInput, setNameInput]                   = useState('');
  const [savingName, setSavingName]                 = useState(false);
  const [nameToast, setNameToast]                   = useState(null);

  // DOM refs
  const nameInputRef  = useRef(null);

  useEffect(() => {
    const headers = { Authorization: `Bearer ${token}` };
    fetch(`${API}/api/portfolio/${id}`, { headers })
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

  // Auto-focus the name input whenever the inline editor opens
  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  // Fetch live eBay listings after the main item data has loaded
  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setListingsLoading(true);
    fetch(`${API}/api/portfolio/${id}/listings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        setListings(Array.isArray(data.listings) ? data.listings : []);
        setListingsMeta(data);
      })
      .catch(() => { if (!cancelled) setListings([]); })
      .finally(() => { if (!cancelled) setListingsLoading(false); });
    return () => { cancelled = true; };
    // item?.id (not item) — re-running on every item edit would refetch eBay needlessly
  }, [item?.id, id, token]);

  // Fetch the multi-grade market view (chart series, grade prices, sales)
  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    fetch(`${API}/api/portfolio/${id}/market`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => { if (!cancelled && !data.error) setMarket(data); })
      .catch(() => { /* chart falls back to the item's own history */ });
    return () => { cancelled = true; };
  }, [item?.id, id, token]);

  // Merge the per-grade series into recharts rows ({date, 'Grade 9': v, …}).
  // Falls back to the item's own price_history as a single series while
  // market data hasn't loaded (or doesn't exist yet).
  const { chartRows, chartSeries } = useMemo(() => {
    const byGrade = market?.history_by_grade && Object.keys(market.history_by_grade).length
      ? market.history_by_grade
      : (priceHistory.length
          ? { 'This item': priceHistory.filter(r => r.value != null && parseFloat(r.value) > 0)
                                       .map(r => ({ date: r.date, value: parseFloat(r.value) })) }
          : {});

    const now = Date.now();
    const cutoff = range === '7D'  ? now - 7    * 86400_000 :
                   range === '30D' ? now - 30   * 86400_000 :
                   range === '90D' ? now - 90   * 86400_000 :
                   range === '1Y'  ? now - 365  * 86400_000 :
                                     now - 1825 * 86400_000; // 5Y

    const rowsByDate = new Map();
    const series = [];
    for (const [label, pts] of Object.entries(byGrade)) {
      let used = 0;
      for (const p of pts) {
        const v = parseFloat(p.value);
        if (!(v > 0)) continue;
        if (cutoff && new Date(p.date).getTime() < cutoff) continue;
        if (!rowsByDate.has(p.date)) rowsByDate.set(p.date, { date: p.date });
        rowsByDate.get(p.date)[label] = v;
        used++;
      }
      if (used) series.push(label);
    }
    // Best grades first — PSA 10 down to Ungraded
    series.sort((a, b) => gradeOrderKey(b) - gradeOrderKey(a));
    const rows = [...rowsByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    return { chartRows: rows, chartSeries: series };
  }, [market, priceHistory, range]);

  // Per-range x-axis label format — and a deduplicated tick list so the same
  // label never repeats (daily points within one month all format to the
  // same "Jun 2026" in the 1Y view).
  const fmtTick = (d) => {
    const dt = new Date(`${d}T12:00:00`);
    if (range === '7D')  return dt.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });  // Mon 26
    if (range === '30D' || range === '90D') {
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });                       // Jun 26
    }
    if (range === '1Y')  return dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });   // Jun 2025
    return String(dt.getFullYear());                                                                   // 2022
  };
  const xTicks = useMemo(() => {
    const seen = new Set();
    const ticks = [];
    for (const row of chartRows) {
      const label = fmtTick(row.date);
      if (!seen.has(label)) {
        seen.add(label);
        ticks.push(row.date);
      }
    }
    return ticks;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartRows, range]);

  // Default the dropdown to the user's grade bucket (the most relevant
  // well-populated line); 'All' overlays every grade.
  const resolvedGradeView =
    gradeView ?? (market?.user_bucket && chartSeries.includes(market.user_bucket) ? market.user_bucket : 'All');
  const visibleSeries = resolvedGradeView === 'All'
    ? chartSeries
    : chartSeries.filter(l => l === resolvedGradeView);

  // Recent Sales follows the dropdown: a specific non-user grade shows that
  // grade's sales; the user's own bucket (and 'All') keeps the half-grade
  // filtered set from the server.
  const showingUserSales = resolvedGradeView === 'All' || resolvedGradeView === market?.user_bucket;
  const shownSales = showingUserSales
    ? (market?.sales ?? [])
    : (market?.sales_by_grade?.[resolvedGradeView] ?? []);

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
      const res  = await fetch(`${API}/api/portfolio/${id}`, {
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

  // ── Per-user custom image ─────────────────────────────────────────────────
  function handleImageUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!ALLOWED.includes(file.type)) {
      setImgMsg('Only JPEG, PNG, and WebP images are accepted');
      setTimeout(() => setImgMsg(null), 4000);
      e.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setImgMsg('Image too large — maximum 5MB');
      setTimeout(() => setImgMsg(null), 4000);
      e.target.value = '';
      return;
    }

    setUploadingImg(true);
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const res = await fetch(`${API}/api/portfolio/${id}/image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ image_base64: event.target.result }),
        });
        const data = await res.json();
        if (data.ok) {
          setItem(prev => ({ ...prev, image_url: data.image_url, has_custom_image: true }));
          setImgMsg('Custom image saved ✓');
        } else {
          setImgMsg(data.error ?? 'Image update failed — please try again');
        }
      } catch {
        setImgMsg('Image update failed — please try again');
      } finally {
        setUploadingImg(false);
        setTimeout(() => setImgMsg(null), 4000);
        e.target.value = '';
      }
    };
    reader.onerror = () => {
      setImgMsg('Image update failed — please try again');
      setUploadingImg(false);
      setTimeout(() => setImgMsg(null), 4000);
      e.target.value = '';
    };
    reader.readAsDataURL(file);
  }

  async function handleRemoveCustomImage() {
    setUploadingImg(true);
    try {
      const res = await fetch(`${API}/api/portfolio/${id}/image`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.ok) {
        setItem(prev => ({ ...prev, image_url: data.image_url, has_custom_image: false }));
        setImgMsg('Reverted to the default image');
      } else {
        setImgMsg(data.error ?? 'Could not remove the custom image');
      }
    } catch {
      setImgMsg('Could not remove the custom image');
    } finally {
      setUploadingImg(false);
      setTimeout(() => setImgMsg(null), 4000);
    }
  }

  // ── Per-item custom valuation ─────────────────────────────────────────────
  async function applyCustomValue(mode, value) {
    setCustomValSaving(true);
    setCustomValError('');
    try {
      const res = await fetch(`${API}/api/portfolio/${id}/custom-value`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode, value }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCustomValError(data.error ?? 'Could not set the custom value');
        return;
      }
      setItem(prev => ({ ...prev, custom_value: data.custom_value }));
      setCustomValOpen(false);
      setCustomValInput('');
    } catch {
      setCustomValError('Network error — please try again');
    } finally {
      setCustomValSaving(false);
    }
  }

  async function handleSaveManualValue() {
    const val = parseFloat(manualValueInput);
    if (isNaN(val) || val <= 0) return;
    setSavingManualValue(true);
    try {
      const res = await fetch(`${API}/api/portfolio/${id}`, {
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

  async function handleSaveName() {
    const trimmed = nameInput.trim();
    if (trimmed.length < 3 || trimmed.length > 200) {
      setNameToast({ type: 'error', text: 'Name must be 3–200 characters' });
      setTimeout(() => setNameToast(null), 3000);
      return;
    }
    setSavingName(true);
    try {
      const res = await fetch(`${API}/api/portfolio/${id}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      if (data.ok) {
        setItem(prev => ({ ...prev, name: data.name }));
        setEditingName(false);
        setNameToast({ type: 'ok', text: 'Card name updated' });
        setTimeout(() => setNameToast(null), 3000);
      } else {
        setNameToast({ type: 'error', text: data.error ?? 'Name update failed — please try again' });
        setTimeout(() => setNameToast(null), 3000);
      }
    } catch {
      setNameToast({ type: 'error', text: 'Name update failed — please try again' });
      setTimeout(() => setNameToast(null), 3000);
    } finally {
      setSavingName(false);
    }
  }

  async function handleDelete() {
    try {
      await fetch(`${API}/api/portfolio/${id}`, {
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
  // Return null (not 0) when no real price data — lets downstream gain/loss
  // display "—" instead of a misleading negative number.
  const displayValue = (() => {
    if (isOneOfOne) return item.manual_value != null ? parseFloat(item.manual_value) : null;
    // Per-user custom valuation overrides the market value for this item only
    const raw = item.custom_value ?? item.current_value ?? item.ph_value;
    if (raw == null) return null;
    const v = parseFloat(raw);
    return !isNaN(v) && v > 0 ? v : null;
  })();
  // Treat purchase_price of 0 as unknown — gain/loss can't be computed without a real cost basis.
  const cost       = item.purchase_price != null && parseFloat(item.purchase_price) > 0
    ? parseFloat(item.purchase_price) : null;
  const totalValue = displayValue != null ? displayValue * item.quantity : null;
  const totalCost  = cost != null ? cost * item.quantity : null;
  // Only compute gain/loss when BOTH current value AND purchase price are real non-zero numbers.
  const gain       = totalValue != null && totalCost != null && totalCost > 0
    ? totalValue - totalCost : null;
  const gainPct    = gain != null && totalCost > 0 ? (gain / totalCost) * 100 : null;
  // 'none' = no price history at all (new scan, not yet priced or no eBay results)
  // 'mock' = has a seeded mock price_history row
  // 'custom' = the user set their own valuation for this item
  const src        = isOneOfOne ? 'manual'
                   : item.custom_value != null ? 'custom'
                   : (item.price_source ?? 'none');
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
                ? <img
                    src={item.image_url}
                    alt={item.name}
                    className="w-full h-full object-contain p-6"
                    // Unverified CDN guesses (saved at add-time) can 404 —
                    // hide the broken image; pricing replaces it with a
                    // verified URL on the next refresh.
                    onError={e => { e.currentTarget.style.display = 'none'; }}
                    // White-background SLAB shots blend into a light tile —
                    // sealed boxes, raw cards, and comic covers render as-is
                    onLoad={e => {
                      if (item.condition === 'graded' && item.grading_company) {
                        blendIfLightBackground(e.currentTarget);
                      }
                    }}
                  />
                : <ItemIcon type={item.item_type} />
              }
            </div>

            {/* Custom image controls — per-user, never touches the catalog */}
            <div className="flex flex-col items-center gap-1">
              <div className="flex gap-2 w-full">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingImg}
                  className="flex-1 py-1.5 px-3 text-xs rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {uploadingImg ? 'Working…' : '↑ Update Image'}
                </button>
                {item.has_custom_image && (
                  <button
                    onClick={handleRemoveCustomImage}
                    disabled={uploadingImg}
                    className="flex-1 py-1.5 px-3 text-xs rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-500 hover:text-red-400 hover:border-red-500/40 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Remove custom image
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/jpg,image/png,image/webp"
                  className="hidden"
                  onChange={handleImageUpload}
                />
              </div>
              {imgMsg && <p className="text-xs text-zinc-500">{imgMsg}</p>}
            </div>

            {/* Identity */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {editingName ? (
                    <div>
                      <input
                        ref={nameInputRef}
                        value={nameInput}
                        onChange={e => setNameInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveName();
                          if (e.key === 'Escape') setEditingName(false);
                        }}
                        maxLength={200}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-white text-base font-semibold focus:outline-none focus:border-indigo-500"
                      />
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={handleSaveName}
                          disabled={savingName}
                          className="text-xs bg-indigo-500 hover:bg-indigo-600 text-white px-3 py-1 rounded-lg transition disabled:opacity-50"
                        >
                          {savingName ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingName(false)}
                          className="text-xs border border-zinc-700 text-zinc-400 hover:text-zinc-200 px-3 py-1 rounded-lg transition"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1.5">
                      <p className="text-white font-semibold text-lg leading-tight flex-1 min-w-0">{item.name}</p>
                      <button
                        onClick={() => { setNameInput(item.name); setEditingName(true); }}
                        className="shrink-0 text-zinc-600 hover:text-zinc-400 transition mt-0.5"
                        title="Rename card"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                    </div>
                  )}
                  {item.set_name && <p className="text-zinc-400 text-sm mt-0.5">{item.set_name}</p>}
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  {gradeLabel && (
                    <span className="bg-indigo-500/20 text-indigo-300 text-xs font-bold px-2.5 py-1 rounded-full">
                      {gradeLabel}
                    </span>
                  )}
                  {item.serial_number && (
                    <span className="bg-emerald-500/15 text-emerald-300 text-xs font-bold px-2.5 py-1 rounded-full">
                      #{String(item.serial_number).replace(/^#/, '')}
                    </span>
                  )}
                </div>
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
              <div className="flex items-center justify-between gap-2 mb-5 flex-wrap">
                <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider">Price History</p>
                <div className="flex items-center gap-2">
                  {chartSeries.length > 1 && (
                    <select
                      value={resolvedGradeView}
                      onChange={e => setGradeView(e.target.value)}
                      className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="All">All grades</option>
                      {chartSeries.map(l => (
                        <option key={l} value={l}>
                          {l}{market?.user_tier === l ? ' (yours)' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="flex items-center bg-zinc-800 rounded-lg p-0.5 gap-0.5">
                    {['7D', '30D', '90D', '1Y', '5Y'].map(r => (
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
              </div>
              {chartRows.length >= 1 ? (
                <>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={chartRows} margin={{ top: 2, right: 4, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: '#71717a', fontSize: 10 }}
                        ticks={xTicks}
                        tickFormatter={fmtTick}
                      />
                      <YAxis
                        tick={{ fill: '#71717a', fontSize: 10 }}
                        width={56}
                        domain={['auto', 'auto']}
                        tickFormatter={v => v >= 10000 ? `$${(v/1000).toFixed(0)}K` : v >= 1000 ? `$${(v/1000).toFixed(1)}K` : `$${v}`}
                      />
                      <Tooltip
                        contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8 }}
                        labelStyle={{ color: '#a1a1aa', fontSize: 11 }}
                        formatter={(v, name) => [fmt$(parseFloat(v)), name]}
                      />
                      {visibleSeries.map(label => {
                        const isUser  = label === 'This item' || market?.user_tier === label;
                        const isSolo  = visibleSeries.length === 1;
                        return (
                          <Line
                            key={label}
                            type="monotone"
                            dataKey={label}
                            stroke={colorFor(label)}
                            strokeWidth={isUser || isSolo ? 2.5 : 1.2}
                            strokeOpacity={isUser || isSolo ? 1 : 0.55}
                            dot={chartRows.length === 1 ? { r: 4, strokeWidth: 0, fill: colorFor(label) } : false}
                            activeDot={{ r: 4 }}
                            connectNulls
                          />
                        );
                      })}
                    </LineChart>
                  </ResponsiveContainer>

                  {/* Legend — only in the all-grades overlay view */}
                  {resolvedGradeView === 'All' && chartSeries.length > 1 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {chartSeries.map(label => (
                        <span
                          key={label}
                          className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border ${
                            market?.user_tier === label
                              ? 'border-zinc-500 text-white font-semibold'
                              : 'border-zinc-800 text-zinc-500'
                          }`}
                        >
                          <span className="w-2 h-2 rounded-full mr-1.5" style={{ background: colorFor(label) }} />
                          {label}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Grade price table — follows the dropdown selection */}
                  {market?.grade_prices?.length > 0 && (
                    <div className="mt-4 border-t border-zinc-800 pt-3">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-zinc-600 text-[10px] uppercase tracking-wider">
                            <th className="text-left font-medium pb-1.5">Grade</th>
                            <th className="text-right font-medium pb-1.5">Price</th>
                            <th className="text-right font-medium pb-1.5">30d Change</th>
                            <th className="text-right font-medium pb-1.5">Vol 90d</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...market.grade_prices]
                            .filter(g => resolvedGradeView === 'All' || g.grade === resolvedGradeView)
                            // Lowest grade first, reading down to PSA 10
                            .sort((a, b) => gradeOrderKey(a.grade) - gradeOrderKey(b.grade))
                            .map(g => (
                              <tr key={g.grade} className={g.is_user_grade ? 'text-white font-semibold' : 'text-zinc-400'}>
                                <td className="py-1">
                                  <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: colorFor(g.grade) }} />
                                  {g.grade}
                                </td>
                                <td className="text-right py-1">{fmt$(g.current)}</td>
                                <td className={`text-right py-1 ${g.change > 0 ? 'text-emerald-400' : g.change < 0 ? 'text-red-400' : 'text-zinc-600'}`}>
                                  {g.change !== 0 ? `${g.change > 0 ? '+' : '−'}${fmt$(Math.abs(g.change))}` : '—'}
                                </td>
                                <td className="text-right py-1 text-zinc-500">{g.volume_90d || '—'}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ) : (
                <div className="h-[180px] flex flex-col items-center justify-center gap-2">
                  <svg className="w-8 h-8 text-zinc-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                  <p className="text-zinc-600 text-sm">No price history yet</p>
                  <p className="text-zinc-700 text-xs">Prices update daily · check back tomorrow</p>
                </div>
              )}
            </div>

            {/* Pricing details */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-3">
              <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider">Pricing</p>

              {/* Market Value — hidden for 1/1, replaced with note */}
              {isOneOfOne ? (
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500 text-sm italic">No sold comps — this is a 1 of 1</span>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-zinc-500 text-sm">Market Value</span>
                    <p className="text-zinc-600 text-xs">
                      {src === 'pricecharting' ? 'Sold median' : 'Updates daily'}
                    </p>
                  </div>
                  <span className="text-zinc-300 text-sm font-medium">
                    {item.ph_value != null ? fmt$(item.ph_value) : '—'}
                  </span>
                </div>
              )}

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

              {/* Custom valuation — affects only this user's item */}
              {!isOneOfOne && (
                <div className="pt-1">
                  {!customValOpen ? (
                    <div className="flex items-center gap-4">
                      <button
                        onClick={() => { setCustomValOpen(true); setCustomValInput(item.custom_value != null ? String(item.custom_value) : ''); setCustomValError(''); }}
                        className="text-xs text-indigo-400 hover:text-indigo-300 transition"
                      >
                        {item.custom_value != null ? 'Edit custom value' : 'Set Custom Value'}
                      </button>
                      {item.custom_value != null && (
                        <button
                          onClick={() => applyCustomValue('clear')}
                          disabled={customValSaving}
                          className="text-xs text-zinc-600 hover:text-red-400 transition disabled:opacity-50"
                        >
                          Clear custom value
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <button
                        onClick={() => applyCustomValue('recent_sale')}
                        disabled={customValSaving}
                        className="w-full text-left text-xs px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-indigo-500/50 transition disabled:opacity-50"
                      >
                        Use most recent sale{gradeLabel ? ` for ${gradeLabel}` : ''}
                      </button>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={customValInput}
                          onChange={e => setCustomValInput(e.target.value)}
                          placeholder="Enter my own value ($)"
                          className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
                        />
                        <button
                          onClick={() => applyCustomValue('manual', parseFloat(customValInput))}
                          disabled={customValSaving || !customValInput}
                          className="text-xs px-3 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition disabled:opacity-50"
                        >
                          {customValSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={() => { setCustomValOpen(false); setCustomValError(''); }}
                          className="text-xs px-3 py-2 rounded-lg border border-zinc-700 text-zinc-500 hover:text-zinc-300 transition"
                        >
                          Cancel
                        </button>
                      </div>
                      {customValError && <p className="text-red-400 text-xs">{customValError}</p>}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Recent Sales — follows the chart's grade selector */}
            {(shownSales.length > 0 || market?.sales?.length > 0) && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider">Recent Sales</p>
                  <span className={`text-[10px] border px-2 py-0.5 rounded-full ${SOURCE_STYLE.pricecharting}`}>
                    Sold listings via PriceCharting
                  </span>
                </div>
                <p className="text-zinc-600 text-xs mb-3">
                  {!showingUserSales
                    ? `Last ${shownSales.length} sales · ${resolvedGradeView}`
                    : market.comps_note
                      ? market.comps_note
                      : `Last ${shownSales.length} sales` + (market.sales_filtered
                          ? ` · ${[item.grading_company, item.grade].filter(Boolean).join(' ')}`
                          : ` · ${market.user_tier}`)}
                </p>
                {/* Subgrade pills — half-grade scales (BGS/SGC/CGC) can jump
                    straight to any subgrade that has sales data */}
                {['BGS', 'BECKETT', 'SGC', 'CGC', 'CBCS', 'PGX'].includes((item.grading_company ?? '').toUpperCase()) &&
                  Object.keys(market?.sales_by_grade ?? {}).length > 1 && (
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {Object.keys(market.sales_by_grade)
                      .sort((a, b) => gradeOrderKey(a) - gradeOrderKey(b))
                      .map(label => (
                        <button
                          key={label}
                          onClick={() => setGradeView(label)}
                          className={`text-[10px] px-2 py-0.5 rounded-full border transition ${
                            resolvedGradeView === label
                              ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300'
                              : 'border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                  </div>
                )}

                {shownSales.length === 0 && (
                  <p className="text-zinc-600 text-sm py-3 text-center">No recorded sales for {resolvedGradeView}</p>
                )}
                <div className="divide-y divide-zinc-800 max-h-80 overflow-y-auto">
                  {shownSales.map((s, i) => (
                    <div key={i} className="flex items-center gap-3 py-2">
                      <span className="text-zinc-600 text-xs w-20 shrink-0">{s.date}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700 shrink-0">
                        {s.grade_label}
                      </span>
                      <p className="flex-1 text-zinc-500 text-xs truncate">{s.title ?? '—'}</p>
                      <span className="text-zinc-200 text-sm font-medium shrink-0">{fmt$(s.price)}</span>
                      {s.url && (
                        <a
                          href={s.url.replace(/&amp;/g, '&')}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-400 hover:text-indigo-300 text-xs transition shrink-0"
                        >
                          ↗
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Active eBay Listings */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider">Active Listings</p>
                <span className={`text-[10px] border px-2 py-0.5 rounded-full ${EBAY_ATTRIBUTION_STYLE}`}>
                  Active listings via eBay
                </span>
              </div>

              {listingsLoading ? (
                <div className="space-y-3">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="flex items-center gap-3 animate-pulse">
                      <div className="w-12 h-12 rounded-lg bg-zinc-800 shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 bg-zinc-800 rounded w-3/4" />
                        <div className="h-3 bg-zinc-800 rounded w-1/3" />
                      </div>
                      <div className="h-5 w-16 bg-zinc-800 rounded" />
                    </div>
                  ))}
                </div>
              ) : listings.length === 0 ? (
                <div className="text-center py-6">
                  <p className="text-zinc-600 text-sm">No active listings found on eBay</p>
                  {listingsMeta?.ebay_search_url && (
                    <a
                      href={listingsMeta.ebay_search_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-3 text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 hover:border-indigo-500/50 px-3 py-1.5 rounded-lg transition"
                    >
                      Search eBay ↗
                    </a>
                  )}
                </div>
              ) : (
                <>
                  <div className="space-y-2.5">
                    {(showAllListings ? listings : listings.slice(0, 3)).map((l, i) => (
                      <div key={i} className="flex items-center gap-3 bg-zinc-950/60 border border-zinc-800 rounded-xl p-3">
                        <div className="w-12 h-12 rounded-lg bg-zinc-800 overflow-hidden shrink-0 flex items-center justify-center">
                          {l.image ? (
                            <img src={l.image} alt="" className="w-full h-full object-cover" loading="lazy" />
                          ) : (
                            <svg className="w-5 h-5 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-zinc-300 text-xs leading-snug">{truncateTitle(l.title)}</p>
                          <div className="flex items-center gap-2 mt-1">
                            {l.condition && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                                {l.condition}
                              </span>
                            )}
                            {l.seller && <span className="text-[10px] text-zinc-600 truncate">{l.seller}</span>}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-white text-base font-semibold">{fmt$(l.price)}</p>
                          {l.url && (
                            <a
                              href={l.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-indigo-400 hover:text-indigo-300 transition whitespace-nowrap"
                            >
                              View on eBay ↗
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {listings.length > 3 && (
                    <button
                      onClick={() => setShowAllListings(v => !v)}
                      className="block w-full text-center mt-3 text-xs text-zinc-400 hover:text-white border border-zinc-800 hover:border-zinc-600 rounded-lg py-1.5 transition"
                    >
                      {showAllListings ? 'Show less' : `Show more (${listings.length - 3} more)`}
                    </button>
                  )}
                  {listingsMeta?.ebay_search_url && (
                    <a
                      href={listingsMeta.ebay_search_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-center mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition"
                    >
                      View all on eBay ↗
                    </a>
                  )}
                </>
              )}
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

      {/* Name-update toast */}
      {nameToast && (
        <div className={`fixed bottom-5 right-5 z-50 flex items-center gap-2 px-4 py-3 rounded-xl border text-sm shadow-2xl ${
          nameToast.type === 'ok'
            ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300'
            : 'bg-red-500/20 border-red-500/30 text-red-300'
        }`}>
          {nameToast.text}
        </div>
      )}

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
                  <select
                    value={editForm.grading_company}
                    // Changing company resets the grade — ladders differ
                    onChange={e => setEditForm(f => ({ ...f, grading_company: e.target.value, grade: '' }))}
                    className={INPUT}
                  >
                    <option value="">—</option>
                    {['PSA','BGS','SGC','CGC','CBCS','PGX','TAG'].map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-zinc-500 text-xs block mb-1">Grade</label>
                  <select value={editForm.grade} onChange={setField('grade')} className={INPUT}>
                    <option value="">—</option>
                    {gradesFor(editForm.grading_company).map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
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
