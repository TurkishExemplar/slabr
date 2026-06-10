import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { API } from '../lib/api';

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_BADGE = {
  sports_card: 'bg-blue-500/20 text-blue-400',
  tcg:         'bg-purple-500/20 text-purple-400',
  comic:       'bg-amber-500/20 text-amber-400',
  sealed:      'bg-emerald-500/20 text-emerald-400',
};

const CATEGORY_LABELS = {
  sports_card: 'Sports', tcg: 'TCG', comic: 'Comics', sealed: 'Sealed',
};

const GRADING_COMPANIES = ['PSA', 'BGS', 'CGC', 'SGC', 'CSG', 'HGA'];

const INPUT =
  'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-white text-sm ' +
  'placeholder-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition';

const DEFAULT_FORM = {
  condition: 'raw',
  grading_company: '',
  grade: '',
  cert_number: '',
  quantity: 1,
  purchase_price: '',
  purchase_date: '',
  is_one_of_one: false,
  manual_value: '',
};

const MANUAL_DEFAULT = {
  item_type: 'sports_card',
  name: '',
  year: '',
  set_name: '',
  card_number: '',
};

// Detect 1/1 keywords in name, card number, or set name
function detectOneOfOne(name = '', cardNumber = '', setName = '') {
  const text = [name, cardNumber, setName].join(' ').toLowerCase();
  return /\b1\/1\b|1 of 1|one of one|superfractor|printing plate|logoman/.test(text);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null || isNaN(n)) return null;
  return `$${parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Add Page ──────────────────────────────────────────────────────────────────

export default function Add() {
  const { token } = useAuth();
  const navigate = useNavigate();

  // ── Search state ─────────────────────────────────────────────────────────
  const [activeTab, setActiveTab]         = useState('search');
  const [query, setQuery]                 = useState('');
  const [results, setResults]             = useState([]);
  const [searching, setSearching]         = useState(false);
  const [registeringId, setRegisteringId] = useState(null); // ebay_item_id being registered
  const [selectedItem, setSelectedItem]   = useState(null);
  const [panelOpen, setPanelOpen]         = useState(false);
  const [form, setForm]                   = useState(DEFAULT_FORM);
  const [submitting, setSubmitting]       = useState(false);
  const [formError, setFormError]         = useState('');

  // ── Manual-add state ─────────────────────────────────────────────────────
  const [manualMode, setManualMode]             = useState(false);
  const [manualForm, setManualForm]             = useState(MANUAL_DEFAULT);
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualError, setManualError]           = useState('');

  // ── Scan state ───────────────────────────────────────────────────────────
  const [scanState,      setScanState]      = useState('checking');
  const [scanItemType,   setScanItemType]   = useState('');
  const [scanResult,     setScanResult]     = useState(null);
  const [scanForm,       setScanForm]       = useState({});
  const [scanSubmitting, setScanSubmitting] = useState(false);
  const [scanSubmitError, setScanSubmitError] = useState('');
  const fileInputRef = useRef(null);

  // Check scan availability once when Scan tab becomes active
  useEffect(() => {
    if (activeTab !== 'scan' || scanState !== 'checking') return;
    fetch(`${API}/api/scan/status`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setScanState(d.available ? 'idle' : 'unavailable'))
      .catch(() => setScanState('unavailable'));
  }, [activeTab, scanState, token]);

  // ── Scan: handle file selection ──────────────────────────────────────────
  const handleFileChange = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = '';

    setScanState('scanning');
    setScanResult(null);
    setScanSubmitError('');

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const res = await fetch(`${API}/api/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ image_base64: evt.target.result, item_type: scanItemType || undefined }),
        });
        const data = await res.json();

        if (data.fallback === 'search') { setScanState('unavailable'); return; }
        if (!data.match)                { setScanState('error');       return; }

        setScanResult(data);
        setScanForm({
          name:            data.name            ?? '',
          set_name:        data.set_name         ?? '',
          year:            data.year             ?? '',
          card_number:     data.card_number      ?? '',
          condition:       data.condition        ?? 'raw',
          grading_company: data.grading_company  ?? '',
          grade:           data.grade            ?? '',
          cert_number:     data.cert_number      ?? '',
          quantity: 1, purchase_price: '', purchase_date: '',
          is_one_of_one: detectOneOfOne(data.name, data.card_number, data.set_name),
          manual_value: '',
        });
        setScanState('result');
      } catch {
        setScanState('error');
      }
    };
    reader.readAsDataURL(file);
  }, [token, scanItemType]);

  // ── Scan: confirm + add ──────────────────────────────────────────────────
  async function handleScanConfirm(e) {
    e.preventDefault();
    setScanSubmitError('');

    if (scanForm.condition === 'graded') {
      if (!scanForm.grading_company) { setScanSubmitError('Grading company is required'); return; }
      if (!scanForm.grade?.trim())   { setScanSubmitError('Grade is required');           return; }
    }
    if (!scanForm.quantity || parseInt(scanForm.quantity) < 1) {
      setScanSubmitError('Quantity must be at least 1'); return;
    }

    setScanSubmitting(true);
    try {
      const body = {
        catalog_id:      scanResult.catalog_id,
        condition:       scanForm.condition,
        grading_company: scanForm.condition === 'graded' ? scanForm.grading_company : null,
        grade:           scanForm.condition === 'graded' ? scanForm.grade?.trim()   : null,
        cert_number:     scanForm.condition === 'graded' && scanForm.cert_number?.trim()
                           ? scanForm.cert_number.trim() : null,
        quantity:        parseInt(scanForm.quantity) || 1,
        purchase_price:  scanForm.purchase_price !== '' ? parseFloat(scanForm.purchase_price) : null,
        purchase_date:   scanForm.purchase_date  || null,
        scan_identified: true, scan_source: 'claude',
        scan_value:      scanResult.current_value,
        forecast_30d:    scanResult.forecast_30d,
        is_one_of_one:   scanForm.is_one_of_one === true,
        manual_value:    scanForm.is_one_of_one && scanForm.manual_value !== ''
                           ? parseFloat(scanForm.manual_value) : null,
      };
      const res = await fetch(`${API}/api/portfolio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json(); setScanSubmitError(d.error || 'Failed to add item'); return; }
      navigate('/dashboard', { state: { added: true } });
    } catch {
      setScanSubmitError('Network error — is the server running?');
    } finally {
      setScanSubmitting(false);
    }
  }

  function setScanField(key) {
    return (e) => setScanForm(f => ({ ...f, [key]: e.target.value }));
  }

  // ── Debounced search ─────────────────────────────────────────────────────
  // The in-flight request is aborted on every keystroke — SCP-enriched
  // searches can be slow, and a stale slow response must never overwrite the
  // results of a newer query.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); setManualMode(false); return; }
    setSearching(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/api/catalog/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        setResults(await res.json());
      } catch (err) {
        if (err.name !== 'AbortError') setResults([]);
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  // ── Open add-panel ───────────────────────────────────────────────────────
  // For SportsCardsPro results: first upsert into master_catalog to get a real
  // catalog_id, then open the grading/condition panel.
  async function openForm(item) {
    let catalogItem = item;

    if (item.source === 'scp') {
      setRegisteringId(item.ebay_item_id);
      try {
        const res = await fetch(`${API}/api/catalog/from-scp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            ebay_item_id: item.ebay_item_id,   // SCP product id (reused column)
            name:         item.name,
            item_type:    item.item_type,
            year:         item.year,
            set_name:     item.set_name,
            card_number:  item.card_number,
            sport_game:   item.sport_game,
            image_url:    item.image_url,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          // Without a real catalog_id the add flow would dead-end at the
          // portfolio POST — stop here instead of opening a broken panel.
          console.error('[slabr] from-scp failed:', data.error);
          alert('Could not register this card — please try again.');
          return;
        }
        catalogItem = data;
      } catch (err) {
        console.error('[slabr] from-scp error:', err.message);
        alert('Could not register this card — please try again.');
        return;
      } finally {
        setRegisteringId(null);
      }
    }

    setSelectedItem(catalogItem);
    const is1of1 = detectOneOfOne(catalogItem.name, catalogItem.card_number, catalogItem.set_name);
    setForm({ ...DEFAULT_FORM, is_one_of_one: is1of1 });
    setFormError('');
    requestAnimationFrame(() => requestAnimationFrame(() => setPanelOpen(true)));
  }

  function closeForm() {
    setPanelOpen(false);
    setTimeout(() => setSelectedItem(null), 300);
  }

  // ── Manual catalog create ────────────────────────────────────────────────
  async function handleManualCreate(e) {
    e.preventDefault();
    if (!manualForm.name.trim()) { setManualError('Card name is required'); return; }

    setManualSubmitting(true);
    setManualError('');
    try {
      const res = await fetch(`${API}/api/catalog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(manualForm),
      });
      const data = await res.json();
      if (!res.ok) { setManualError(data.error || 'Failed to create card'); return; }
      setManualMode(false);
      openForm(data);  // data.source === 'manual', no catalog registration needed
    } catch {
      setManualError('Network error — is the server running?');
    } finally {
      setManualSubmitting(false);
    }
  }

  // ── Portfolio submit ─────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');

    if (!form.condition) { setFormError('Condition is required'); return; }
    if (form.condition === 'graded') {
      if (!form.grading_company) { setFormError('Grading company is required'); return; }
      if (!form.grade.trim())    { setFormError('Grade is required');            return; }
    }
    if (!form.quantity || parseInt(form.quantity) < 1) {
      setFormError('Quantity must be at least 1'); return;
    }

    setSubmitting(true);
    try {
      const body = {
        catalog_id:      selectedItem.id,
        condition:       form.condition,
        grading_company: form.condition === 'graded' ? form.grading_company : null,
        grade:           form.condition === 'graded' ? form.grade.trim()    : null,
        cert_number:     form.condition === 'graded' && form.cert_number.trim()
                           ? form.cert_number.trim() : null,
        quantity:        parseInt(form.quantity) || 1,
        purchase_price:  form.purchase_price !== '' ? parseFloat(form.purchase_price) : null,
        purchase_date:   form.purchase_date  || null,
        is_one_of_one:   form.is_one_of_one === true,
        manual_value:    form.is_one_of_one && form.manual_value !== ''
                           ? parseFloat(form.manual_value) : null,
      };
      const res = await fetch(`${API}/api/portfolio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json(); setFormError(d.error || 'Failed to add item'); return; }
      navigate('/dashboard', { state: { added: true } });
    } catch {
      setFormError('Network error — is the server running?');
    } finally {
      setSubmitting(false);
    }
  }

  function setField(key) {
    return (e) => setForm(f => ({ ...f, [key]: e.target.value }));
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#09090b]">

      {/* Nav */}
      <header className="border-b border-zinc-800 sticky top-0 bg-[#09090b]/95 backdrop-blur z-10">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/dashboard" className="flex items-center gap-1.5 text-zinc-500 hover:text-white transition text-sm">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Portfolio
            </Link>
            <span className="text-zinc-800">|</span>
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-md bg-indigo-500 flex items-center justify-center">
                <span className="text-white text-[10px] font-bold">S</span>
              </div>
              <span className="text-white text-sm font-medium">Slabr</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        <h1 className="text-white text-2xl font-semibold mb-6">Add to Collection</h1>

        {/* Tabs */}
        <div className="flex border-b border-zinc-800 mb-8">
          {[{ key: 'search', label: 'Search' }, { key: 'scan', label: 'Scan' }].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition ${
                activeTab === tab.key
                  ? 'border-indigo-500 text-white'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Search Tab ─────────────────────────────────────────────────── */}
        {activeTab === 'search' && (
          <div className="space-y-4">
            {/* Search input */}
            <div className="relative">
              <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-4.35-4.35M16.65 16.65A7.5 7.5 0 1116.65 2a7.5 7.5 0 010 14.65z" />
              </svg>
              <input
                type="text"
                value={query}
                onChange={e => { setQuery(e.target.value); setManualMode(false); }}
                placeholder="Search any card, player, or set…"
                autoFocus
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-10 pr-4 py-3 text-white text-sm
                           placeholder-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
              />
              {searching && (
                <div className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-zinc-600 border-t-indigo-500 rounded-full animate-spin" />
              )}
            </div>

            {/* Results */}
            {results.length > 0 && !manualMode && (
              <div className="space-y-2">
                {results.map(item => {
                  const key = item.source === 'scp' ? item.ebay_item_id : String(item.id);
                  const isRegistering = registeringId === item.ebay_item_id;
                  const price = fmt(item.current_value);

                  return (
                    <button
                      key={key}
                      onClick={() => openForm(item)}
                      disabled={!!registeringId}
                      className="w-full text-left bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700
                                 rounded-xl p-4 transition group disabled:opacity-60 disabled:cursor-default"
                    >
                      <div className="flex items-center gap-3">
                        {/* Image thumbnail */}
                        <div className="w-14 h-14 rounded-lg bg-zinc-800 shrink-0 overflow-hidden flex items-center justify-center">
                          {item.image_url ? (
                            <img src={item.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                          ) : (
                            <svg className="w-5 h-5 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                          )}
                        </div>

                        {/* Text */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider ${TYPE_BADGE[item.item_type] ?? 'bg-zinc-700 text-zinc-400'}`}>
                              {CATEGORY_LABELS[item.item_type] ?? item.item_type ?? 'Card'}
                            </span>
                            {item.year && <span className="text-zinc-600 text-xs">{item.year}</span>}
                          </div>
                          <p className="text-white text-sm font-medium leading-snug line-clamp-2">{item.name}</p>
                          {item.set_name && (
                            <p className="text-zinc-500 text-xs mt-0.5 truncate">{item.set_name}</p>
                          )}
                          {price && (
                            <p className="text-emerald-400 text-xs mt-0.5 font-medium">
                              {price}
                              {item.source === 'scp' && <span className="text-zinc-500 font-normal"> · via SportsCardsPro</span>}
                            </p>
                          )}
                          {item.sport_game && (
                            <p className="text-zinc-600 text-[11px] mt-0.5 capitalize">{item.sport_game}</p>
                          )}
                        </div>

                        {/* Arrow / spinner */}
                        {isRegistering ? (
                          <div className="w-4 h-4 border-2 border-zinc-600 border-t-indigo-400 rounded-full animate-spin shrink-0" />
                        ) : (
                          <svg className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 transition shrink-0"
                            fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* No results → offer manual add */}
            {query.trim() && !searching && results.length === 0 && !manualMode && (
              <div className="text-center py-12">
                <p className="text-zinc-500 text-sm mb-4">No results for "{query}"</p>
                <button
                  onClick={() => {
                    setManualMode(true);
                    setManualForm({ ...MANUAL_DEFAULT, name: query.trim() });
                    setManualError('');
                  }}
                  className="text-indigo-400 hover:text-indigo-300 text-sm border border-indigo-500/30
                             hover:border-indigo-500/50 px-5 py-2.5 rounded-xl transition"
                >
                  Can't find your card? Add it manually →
                </button>
              </div>
            )}

            {/* Manual add form */}
            {manualMode && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
                <div className="flex items-center justify-between mb-5">
                  <h3 className="text-white font-semibold text-sm">Add Card Manually</h3>
                  <button onClick={() => setManualMode(false)} className="text-zinc-500 hover:text-white transition p-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                <form onSubmit={handleManualCreate} className="space-y-4">
                  {/* Type */}
                  <div>
                    <label className="block text-zinc-400 text-xs font-medium uppercase tracking-wider mb-2">Type</label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {[
                        { value: 'sports_card', label: 'Sports Card' },
                        { value: 'tcg',         label: 'TCG'         },
                        { value: 'comic',       label: 'Comic'       },
                        { value: 'sealed',      label: 'Sealed'      },
                      ].map(t => (
                        <button key={t.value} type="button"
                          onClick={() => setManualForm(f => ({ ...f, item_type: t.value }))}
                          className={`py-2 rounded-lg text-xs font-medium border transition ${
                            manualForm.item_type === t.value
                              ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                              : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'
                          }`}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Name */}
                  <div>
                    <label className="block text-zinc-400 text-xs font-medium uppercase tracking-wider mb-1.5">
                      Card Name <span className="text-red-400">*</span>
                    </label>
                    <input type="text" value={manualForm.name} required autoFocus
                      onChange={e => setManualForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. LeBron James Rookie" className={INPUT} />
                  </div>

                  {/* Year + Set */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-zinc-400 text-xs font-medium uppercase tracking-wider mb-1.5">Year</label>
                      <input type="number" value={manualForm.year} placeholder="2003"
                        onChange={e => setManualForm(f => ({ ...f, year: e.target.value }))}
                        className={INPUT} />
                    </div>
                    <div>
                      <label className="block text-zinc-400 text-xs font-medium uppercase tracking-wider mb-1.5">Set / Product</label>
                      <input type="text" value={manualForm.set_name} placeholder="Topps Chrome"
                        onChange={e => setManualForm(f => ({ ...f, set_name: e.target.value }))}
                        className={INPUT} />
                    </div>
                  </div>

                  {/* Card number */}
                  <div>
                    <label className="block text-zinc-400 text-xs font-medium uppercase tracking-wider mb-1.5">Card Number</label>
                    <input type="text" value={manualForm.card_number} placeholder="Optional (e.g. 111)"
                      onChange={e => setManualForm(f => ({ ...f, card_number: e.target.value }))}
                      className={INPUT} />
                  </div>

                  {manualError && (
                    <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                      {manualError}
                    </div>
                  )}

                  <div className="flex gap-3 pt-1">
                    <button type="button" onClick={() => setManualMode(false)}
                      className="flex-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-sm font-medium py-2.5 rounded-lg transition">
                      Cancel
                    </button>
                    <button type="submit" disabled={manualSubmitting || !manualForm.name.trim()}
                      className="flex-1 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-lg transition">
                      {manualSubmitting ? 'Creating…' : 'Continue →'}
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* Initial hint */}
            {!query.trim() && !manualMode && (
              <div className="text-center py-12 text-zinc-600 text-sm">
                Type to search the SportsCardsPro price guide
              </div>
            )}
          </div>
        )}

        {/* ── Scan Tab ───────────────────────────────────────────────────── */}
        {activeTab === 'scan' && (
          <div>
            {scanState === 'checking' && (
              <div className="flex items-center justify-center py-20">
                <div className="w-5 h-5 border-2 border-zinc-600 border-t-indigo-500 rounded-full animate-spin" />
              </div>
            )}

            {scanState === 'unavailable' && (
              <div className="border border-dashed border-zinc-800 rounded-2xl flex flex-col items-center justify-center py-16 gap-4 text-center">
                <div className="w-14 h-14 rounded-2xl bg-zinc-800/80 flex items-center justify-center">
                  <svg className="w-6 h-6 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                </div>
                <div>
                  <p className="text-zinc-300 font-medium">Scan Unavailable</p>
                  <p className="text-zinc-600 text-sm mt-1">ANTHROPIC_API_KEY is not configured on this server</p>
                </div>
                <button onClick={() => setActiveTab('search')}
                  className="text-indigo-400 hover:text-indigo-300 text-sm border border-indigo-500/30 hover:border-indigo-500/50 px-4 py-2 rounded-lg transition">
                  Use Search Instead
                </button>
              </div>
            )}

            {scanState === 'idle' && (
              <div className="space-y-6">
                <div>
                  <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider mb-2">Item Type</p>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { value: '',            label: 'Auto-detect' },
                      { value: 'sports_card', label: 'Sports Card' },
                      { value: 'tcg',         label: 'TCG'         },
                      { value: 'comic',       label: 'Comics'      },
                    ].map(opt => (
                      <button key={opt.value} type="button"
                        onClick={() => setScanItemType(opt.value)}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-medium border transition ${
                          scanItemType === opt.value
                            ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                            : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'
                        }`}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="block cursor-pointer">
                  <input ref={fileInputRef} type="file" accept="image/*" capture="environment"
                    className="sr-only" onChange={handleFileChange} />
                  <div className="border-2 border-dashed border-zinc-700 hover:border-indigo-500/50 rounded-2xl
                                  flex flex-col items-center justify-center py-16 gap-4 transition group">
                    <div className="w-16 h-16 rounded-2xl bg-zinc-800 group-hover:bg-zinc-700 flex items-center justify-center transition">
                      <svg className="w-7 h-7 text-zinc-500 group-hover:text-indigo-400 transition"
                        fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                          d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </div>
                    <div className="text-center">
                      <p className="text-zinc-300 font-medium text-sm">Take a photo or upload</p>
                      <p className="text-zinc-600 text-xs mt-1">Tap to use camera · or choose a file</p>
                    </div>
                  </div>
                </label>
              </div>
            )}

            {scanState === 'scanning' && (
              <div className="flex flex-col items-center justify-center py-20 gap-5">
                <div className="w-12 h-12 border-2 border-zinc-700 border-t-indigo-500 rounded-full animate-spin" />
                <p className="text-zinc-400 text-sm">Identifying card…</p>
              </div>
            )}

            {scanState === 'error' && (
              <div className="border border-dashed border-zinc-800 rounded-2xl flex flex-col items-center justify-center py-16 gap-4 text-center">
                <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center">
                  <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-zinc-300 font-medium">Couldn't identify this item</p>
                  <p className="text-zinc-600 text-sm mt-1">Try a clearer photo, or search manually</p>
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setScanState('idle')}
                    className="text-zinc-400 hover:text-white text-sm border border-zinc-700 hover:border-zinc-600 px-4 py-2 rounded-lg transition">
                    Try Again
                  </button>
                  <button onClick={() => setActiveTab('search')}
                    className="text-indigo-400 hover:text-indigo-300 text-sm border border-indigo-500/30 hover:border-indigo-500/50 px-4 py-2 rounded-lg transition">
                    Switch to Search
                  </button>
                </div>
              </div>
            )}

            {scanState === 'result' && scanResult && (
              <div className="space-y-5">
                <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-zinc-500 text-xs font-medium uppercase tracking-wider mb-1">Identified</p>
                      <p className="text-white font-semibold">{scanResult.name ?? 'Unknown Card'}</p>
                      {scanResult.set_name && (
                        <p className="text-zinc-500 text-sm mt-0.5">
                          {[scanResult.set_name, scanResult.year].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                    <ConfidenceBadge distance={scanResult.confidence} />
                  </div>
                  {scanResult.current_value != null && (
                    <div className="mt-3 pt-3 border-t border-zinc-800 flex items-center justify-between">
                      <span className="text-zinc-500 text-xs">Estimated value</span>
                      <span className="text-white text-sm font-medium">
                        ${parseFloat(scanResult.current_value).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  )}
                </div>

                <form onSubmit={handleScanConfirm} className="space-y-4">
                  <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider">Review & Edit Details</p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {[
                      { key: 'name',        label: 'Name',        type: 'text'   },
                      { key: 'set_name',    label: 'Set',         type: 'text'   },
                      { key: 'year',        label: 'Year',        type: 'number' },
                      { key: 'card_number', label: 'Card Number', type: 'text', placeholder: 'Optional' },
                    ].map(f => (
                      <div key={f.key}>
                        <label className="block text-zinc-500 text-xs mb-1.5">{f.label}</label>
                        <input type={f.type} value={scanForm[f.key]} onChange={setScanField(f.key)}
                          placeholder={f.placeholder} className={INPUT} />
                      </div>
                    ))}
                  </div>

                  <div>
                    <label className="block text-zinc-400 text-xs font-medium mb-2 uppercase tracking-wider">
                      Condition <span className="text-red-400">*</span>
                    </label>
                    <div className="flex gap-2">
                      {['raw', 'graded'].map(c => (
                        <button key={c} type="button"
                          onClick={() => setScanForm(f => ({ ...f, condition: c }))}
                          className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition capitalize ${
                            scanForm.condition === c
                              ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                              : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'
                          }`}>
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>

                  {scanForm.condition === 'graded' && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-zinc-500 text-xs mb-1.5">Grading Company *</label>
                        <select value={scanForm.grading_company} onChange={setScanField('grading_company')}
                          className={INPUT + ' appearance-none'}>
                          <option value="">Select…</option>
                          {GRADING_COMPANIES.map(g => <option key={g} value={g}>{g}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-zinc-500 text-xs mb-1.5">Grade *</label>
                        <input type="text" value={scanForm.grade} onChange={setScanField('grade')}
                          placeholder="e.g. 10" className={INPUT} />
                      </div>
                      <div>
                        <label className="block text-zinc-500 text-xs mb-1.5">Cert Number</label>
                        <input type="text" value={scanForm.cert_number} onChange={setScanField('cert_number')}
                          placeholder="Optional" className={INPUT} />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-zinc-500 text-xs mb-1.5">Quantity</label>
                      <input type="number" min="1" value={scanForm.quantity} onChange={setScanField('quantity')} className={INPUT} />
                    </div>
                    <div>
                      <label className="block text-zinc-500 text-xs mb-1.5">Purchase Price ($)</label>
                      <input type="number" step="0.01" min="0" value={scanForm.purchase_price}
                        onChange={setScanField('purchase_price')} placeholder="0.00" className={INPUT} />
                    </div>
                    <div>
                      <label className="block text-zinc-500 text-xs mb-1.5">Purchase Date</label>
                      <input type="date" value={scanForm.purchase_date} onChange={setScanField('purchase_date')}
                        className={INPUT + ' [color-scheme:dark]'} />
                    </div>
                  </div>

                  {/* 1/1 toggle */}
                  <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
                    <div>
                      <p className="text-zinc-300 text-sm font-medium">This is a 1 of 1</p>
                      <p className="text-zinc-600 text-xs">Superfractor, Printing Plate, Logoman, etc.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setScanForm(f => ({ ...f, is_one_of_one: !f.is_one_of_one }))}
                      className={`w-11 h-6 rounded-full transition-colors duration-200 flex items-center px-0.5 shrink-0 ${scanForm.is_one_of_one ? 'bg-amber-500' : 'bg-zinc-700'}`}
                    >
                      <span className={`w-5 h-5 rounded-full bg-white shadow transform transition-transform duration-200 ${scanForm.is_one_of_one ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>

                  {scanForm.is_one_of_one && (
                    <div>
                      <label className="block text-amber-400/80 text-xs font-medium mb-1.5 uppercase tracking-wider">
                        Owner Estimated Value ($)
                      </label>
                      <input
                        type="number" step="0.01" min="0"
                        value={scanForm.manual_value ?? ''}
                        onChange={e => setScanForm(f => ({ ...f, manual_value: e.target.value }))}
                        placeholder="Your estimated value"
                        className="w-full bg-zinc-800 border border-amber-500/30 rounded-lg px-3.5 py-2.5 text-white text-sm
                                   placeholder-zinc-600 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 transition"
                      />
                    </div>
                  )}

                  {scanSubmitError && (
                    <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                      {scanSubmitError}
                    </div>
                  )}

                  <div className="flex gap-3 pt-2">
                    <button type="button" onClick={() => setScanState('idle')}
                      className="flex-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 font-medium py-2.5 rounded-lg text-sm transition">
                      Scan Again
                    </button>
                    <button type="submit" disabled={scanSubmitting}
                      className="flex-1 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm transition">
                      {scanSubmitting ? 'Adding…' : 'Add to Portfolio'}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ── Slide-in Add Form ─────────────────────────────────────────────── */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className={`absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-300 ${panelOpen ? 'opacity-100' : 'opacity-0'}`}
            onClick={closeForm}
          />

          <div className={`relative w-full max-w-md bg-[#0a0a0d] border-l border-zinc-800 shadow-2xl flex flex-col
                           transition-transform duration-300 ease-out ${panelOpen ? 'translate-x-0' : 'translate-x-full'}`}>
            {/* Panel header */}
            <div className="flex items-start justify-between px-6 py-5 border-b border-zinc-800 shrink-0">
              <div className="flex items-start gap-3 flex-1 min-w-0 pr-3">
                {/* Card image preview */}
                {selectedItem.image_url && (
                  <div className="w-14 h-14 rounded-lg bg-zinc-800 shrink-0 overflow-hidden">
                    <img src={selectedItem.image_url} alt="" className="w-full h-full object-cover" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider ${TYPE_BADGE[selectedItem.item_type] ?? 'bg-zinc-700 text-zinc-400'}`}>
                      {CATEGORY_LABELS[selectedItem.item_type] ?? selectedItem.item_type}
                    </span>
                    {selectedItem.year && <span className="text-zinc-600 text-xs">{selectedItem.year}</span>}
                  </div>
                  <p className="text-white font-semibold text-sm leading-snug">{selectedItem.name}</p>
                  {selectedItem.set_name && (
                    <p className="text-zinc-500 text-xs mt-0.5">{selectedItem.set_name}</p>
                  )}
                  {selectedItem.current_value != null && (
                    <p className="text-emerald-400 text-xs mt-0.5">
                      {fmt(selectedItem.current_value)}
                      <span className="text-zinc-500"> · via SportsCardsPro</span>
                    </p>
                  )}
                </div>
              </div>
              <button onClick={closeForm} className="text-zinc-500 hover:text-white transition shrink-0 p-1 mt-0.5">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-6 space-y-5">

              {/* Condition toggle */}
              <div>
                <label className="block text-zinc-400 text-xs font-medium mb-2 uppercase tracking-wider">
                  Condition <span className="text-red-400">*</span>
                </label>
                <div className="flex gap-2">
                  {['raw', 'graded'].map(c => (
                    <button key={c} type="button"
                      onClick={() => setForm(f => ({ ...f, condition: c, grading_company: '', grade: '', cert_number: '' }))}
                      className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition capitalize ${
                        form.condition === c
                          ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                          : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'
                      }`}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              {/* Grading fields */}
              {form.condition === 'graded' && (
                <>
                  <div>
                    <label className="block text-zinc-400 text-xs font-medium mb-1.5 uppercase tracking-wider">
                      Grading Company <span className="text-red-400">*</span>
                    </label>
                    <select value={form.grading_company} onChange={setField('grading_company')}
                      className={INPUT + ' appearance-none'}>
                      <option value="">Select company…</option>
                      {GRADING_COMPANIES.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-zinc-400 text-xs font-medium mb-1.5 uppercase tracking-wider">
                      Grade <span className="text-red-400">*</span>
                    </label>
                    <input type="text" value={form.grade} onChange={setField('grade')}
                      placeholder="e.g. 10, 9.5, 8" className={INPUT} />
                  </div>
                  <div>
                    <label className="block text-zinc-400 text-xs font-medium mb-1.5 uppercase tracking-wider">Cert Number</label>
                    <input type="text" value={form.cert_number} onChange={setField('cert_number')}
                      placeholder="Optional" className={INPUT} />
                  </div>
                </>
              )}

              <div>
                <label className="block text-zinc-400 text-xs font-medium mb-1.5 uppercase tracking-wider">Quantity</label>
                <input type="number" value={form.quantity} onChange={setField('quantity')} min="1" className={INPUT} />
              </div>

              <div>
                <label className="block text-zinc-400 text-xs font-medium mb-1.5 uppercase tracking-wider">Purchase Price ($)</label>
                <input type="number" value={form.purchase_price} onChange={setField('purchase_price')}
                  min="0" step="0.01" placeholder="0.00" className={INPUT} />
              </div>

              <div>
                <label className="block text-zinc-400 text-xs font-medium mb-1.5 uppercase tracking-wider">Purchase Date</label>
                <input type="date" value={form.purchase_date} onChange={setField('purchase_date')}
                  className={INPUT + ' [color-scheme:dark]'} />
              </div>

              {/* 1/1 toggle */}
              <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
                <div>
                  <p className="text-zinc-300 text-sm font-medium">This is a 1 of 1</p>
                  <p className="text-zinc-600 text-xs">Superfractor, Printing Plate, Logoman, etc.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, is_one_of_one: !f.is_one_of_one }))}
                  className={`w-11 h-6 rounded-full transition-colors duration-200 flex items-center px-0.5 shrink-0 ${form.is_one_of_one ? 'bg-amber-500' : 'bg-zinc-700'}`}
                >
                  <span className={`w-5 h-5 rounded-full bg-white shadow transform transition-transform duration-200 ${form.is_one_of_one ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {form.is_one_of_one && (
                <div>
                  <label className="block text-amber-400/80 text-xs font-medium mb-1.5 uppercase tracking-wider">
                    Owner Estimated Value ($)
                  </label>
                  <input
                    type="number" step="0.01" min="0"
                    value={form.manual_value}
                    onChange={setField('manual_value')}
                    placeholder="Your estimated value"
                    className="w-full bg-zinc-800 border border-amber-500/30 rounded-lg px-3.5 py-2.5 text-white text-sm
                               placeholder-zinc-600 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 transition"
                  />
                </div>
              )}

              {formError && (
                <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                  {formError}
                </div>
              )}

              <div className="flex gap-3 pt-2 pb-4">
                <button type="button" onClick={closeForm}
                  className="flex-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 font-medium py-2.5 rounded-lg text-sm transition">
                  Cancel
                </button>
                <button type="submit" disabled={submitting}
                  className="flex-1 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg text-sm transition">
                  {submitting ? 'Adding…' : 'Add to Portfolio'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ConfidenceBadge ───────────────────────────────────────────────────────────

function ConfidenceBadge({ distance }) {
  if (distance == null) return null;
  const [label, cls] =
    distance >= 0.85 ? ['High confidence',   'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'] :
    distance >= 0.65 ? ['Medium confidence', 'bg-amber-500/20   text-amber-400   border-amber-500/30'  ] :
                       ['Low confidence',    'bg-red-500/20     text-red-400     border-red-500/30'    ];
  return (
    <span className={`text-[10px] font-semibold px-2 py-1 rounded-full border whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}
