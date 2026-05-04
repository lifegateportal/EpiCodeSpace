import React, { useState, useCallback } from 'react';
import {
  X, Plus, Trash2, CheckCircle2, AlertCircle,
  Loader2, Eye, EyeOff, RefreshCw,
} from 'lucide-react';
import {
  loadConnections, saveConnections, makeConnection, PLATFORM_META,
} from '../lib/connections.js';

const AUTH_TYPES = [
  { id: 'none',   label: 'None'         },
  { id: 'bearer', label: 'Bearer Token' },
  { id: 'apikey', label: 'API Key'      },
  { id: 'basic',  label: 'Basic'        },
];

// ─── Test a connection against the real platform API ─────────────────────────
async function testConnectionAPI(conn) {
  const { platform, token, meta } = conn;
  try {
    if (platform === 'netlify') {
      const r = await fetch('https://api.netlify.com/api/v1/user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return { ok: true, info: d.full_name || d.email || 'Authenticated' };
    }
    if (platform === 'vercel') {
      const r = await fetch('https://api.vercel.com/v2/user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return { ok: true, info: d.user?.username || d.user?.email || 'Authenticated' };
    }
    if (platform === 'github') {
      const r = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return { ok: true, info: `@${d.login}` };
    }
    if (platform === 'custom') {
      if (!meta?.url) return { ok: false, info: 'No endpoint URL configured' };
      return { ok: true, info: meta.url };
    }
    return { ok: false, info: 'Unknown platform' };
  } catch (e) {
    return { ok: false, info: e.message };
  }
}

// ─── Add Connection Form ───────────────────────────────────────────────────────
function AddForm({ onSave, onCancel }) {
  const [platform,    setPlatform]    = useState('netlify');
  const [label,       setLabel]       = useState('');
  const [token,       setToken]       = useState('');
  const [showToken,   setShowToken]   = useState(false);
  // platform-specific meta
  const [siteName,    setSiteName]    = useState('');
  const [repo,        setRepo]        = useState('');
  const [epicApiUrl,  setEpicApiUrl]  = useState('https://api.epicglobal.app');
  const [customUrl,   setCustomUrl]   = useState('');
  const [method,      setMethod]      = useState('POST');
  const [authType,    setAuthType]    = useState('bearer');
  const [authVal,     setAuthVal]     = useState('');
  const [authHdr,     setAuthHdr]     = useState('X-API-Key');
  const [extraHdrs,   setExtraHdrs]   = useState([]);

  const addHdr    = () => setExtraHdrs(h => [...h, { key: '', value: '' }]);
  const removeHdr = (i) => setExtraHdrs(h => h.filter((_, idx) => idx !== i));
  const updateHdr = (i, field, val) =>
    setExtraHdrs(h => h.map((row, idx) => idx === i ? { ...row, [field]: val } : row));

  const handleSave = useCallback(() => {
    const meta =
      platform === 'netlify'    ? { siteName } :
      platform === 'github'     ? { repo } :
      platform === 'epicglobal' ? { apiUrl: epicApiUrl } :
      platform === 'custom'     ? { url: customUrl, method, authType, authVal, authHdr, headers: extraHdrs } :
      {};
    onSave(makeConnection({
      platform,
      label: label.trim() || PLATFORM_META[platform].label,
      token: token.trim(),
      meta,
    }));
  }, [platform, label, token, siteName, repo, epicApiUrl, customUrl, method, authType, authVal, authHdr, extraHdrs, onSave]);

  const pm = PLATFORM_META[platform];

  return (
    <div className="bg-[#0d0520] border border-fuchsia-500/20 rounded-xl p-4 space-y-3">
      {/* Platform + Label row */}
      <div className="flex gap-2">
        <select
          value={platform}
          onChange={e => { setPlatform(e.target.value); }}
          className="bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-2 py-2 text-xs text-white focus:outline-none focus:border-fuchsia-400/60 shrink-0"
        >
          {Object.entries(PLATFORM_META).map(([id, m]) => (
            <option key={id} value={id}>{m.label}</option>
          ))}
        </select>
        <input
          type="text"
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder={`Label (e.g. My ${pm.label})`}
          className="flex-1 bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60"
        />
      </div>

      {/* Token */}
      {platform !== 'custom' && (
        <div className="flex gap-2">
          <input
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={pm.tokenPlaceholder}
            autoComplete="off"
            className="flex-1 bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60"
          />
          <button
            onClick={() => setShowToken(p => !p)}
            className="px-3 py-2 text-purple-400 hover:text-white bg-[#15092a] border border-fuchsia-500/20 rounded-lg transition-colors"
            aria-label="Toggle visibility"
          >
            {showToken ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
      )}
      <p className="text-[10px] text-purple-500/50">{pm.hint}</p>

      {/* EpiGlobal API URL */}
      {platform === 'epicglobal' && (
        <input type="url" value={epicApiUrl} onChange={e => setEpicApiUrl(e.target.value)}
          placeholder="https://api.epicglobal.app"
          className="w-full bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60" />
      )}

      {/* Netlify site name */}
      {platform === 'netlify' && (
        <input type="text" value={siteName} onChange={e => setSiteName(e.target.value)}
          placeholder="Site name (optional)"
          className="w-full bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60" />
      )}

      {/* GitHub repo */}
      {platform === 'github' && (
        <input type="text" value={repo} onChange={e => setRepo(e.target.value)}
          placeholder="owner/repo-name"
          className="w-full bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60" />
      )}

      {/* Custom endpoint */}
      {platform === 'custom' && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <select value={method} onChange={e => setMethod(e.target.value)}
              className="bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-2 py-2 text-xs text-white focus:outline-none shrink-0">
              <option>POST</option><option>PUT</option><option>PATCH</option>
            </select>
            <input type="url" value={customUrl} onChange={e => setCustomUrl(e.target.value)}
              placeholder="https://your-platform.com/api/deploy"
              className="flex-1 bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60" />
          </div>
          {/* Auth */}
          <div className="flex gap-1 flex-wrap">
            {AUTH_TYPES.map(a => (
              <button key={a.id} onClick={() => setAuthType(a.id)}
                className={`px-2.5 py-1 text-[10px] rounded-md border transition-colors ${
                  authType === a.id ? 'bg-fuchsia-600 border-fuchsia-600 text-white' : 'border-fuchsia-500/20 text-purple-400 hover:text-white'
                }`}>{a.label}</button>
            ))}
          </div>
          {authType !== 'none' && (
            <div className="space-y-1.5">
              {authType === 'apikey' && (
                <input type="text" value={authHdr} onChange={e => setAuthHdr(e.target.value)}
                  placeholder="Header name (e.g. X-API-Key)"
                  className="w-full bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60" />
              )}
              <div className="flex gap-2">
                <input type={showToken ? 'text' : 'password'} value={authVal} onChange={e => setAuthVal(e.target.value)}
                  placeholder={authType === 'basic' ? 'username:password' : 'Token value'}
                  autoComplete="off"
                  className="flex-1 bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60" />
                <button onClick={() => setShowToken(p => !p)}
                  className="px-3 py-2 text-purple-400 hover:text-white bg-[#15092a] border border-fuchsia-500/20 rounded-lg transition-colors">
                  {showToken ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
            </div>
          )}
          {/* Extra headers */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-purple-400">Extra Headers</span>
              <button onClick={addHdr} className="text-[10px] text-fuchsia-400 hover:text-fuchsia-300 flex items-center gap-1">
                <Plus size={10} /> Add
              </button>
            </div>
            {extraHdrs.map((h, i) => (
              <div key={i} className="flex gap-1.5 mb-1.5">
                <input type="text" value={h.key} onChange={e => updateHdr(i, 'key', e.target.value)} placeholder="Header"
                  className="w-2/5 bg-[#15092a] border border-fuchsia-500/20 rounded px-2 py-1.5 text-xs text-white placeholder-purple-600 focus:outline-none" />
                <input type="text" value={h.value} onChange={e => updateHdr(i, 'value', e.target.value)} placeholder="Value"
                  className="flex-1 bg-[#15092a] border border-fuchsia-500/20 rounded px-2 py-1.5 text-xs text-white placeholder-purple-600 focus:outline-none" />
                <button onClick={() => removeHdr(i)} className="text-red-400/60 hover:text-red-400 px-1">
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Form actions */}
      <div className="flex gap-2 justify-end pt-1">
        <button onClick={onCancel}
          className="px-3 py-1.5 text-xs text-purple-400 hover:text-white border border-fuchsia-500/20 rounded-lg transition-colors">
          Cancel
        </button>
        <button onClick={handleSave}
          className="px-4 py-1.5 text-xs font-semibold bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-lg transition-colors flex items-center gap-1.5">
          <Plus size={12} /> Save Connection
        </button>
      </div>
    </div>
  );
}

// ─── Connection card ───────────────────────────────────────────────────────────
function ConnectionCard({ conn, onDisconnect, onReplace }) {
  const [testState, setTestState] = useState(null); // null | 'testing' | { ok, info }
  const pm = PLATFORM_META[conn.platform] || PLATFORM_META.custom;

  const maskToken = (t) => t ? `${t.slice(0, 6)}${'•'.repeat(8)}` : '—';
  const metaSummary = conn.platform === 'github' ? conn.meta?.repo
    : conn.platform === 'netlify' ? (conn.meta?.siteName || null)
    : conn.platform === 'custom' ? conn.meta?.url
    : null;

  const handleTest = useCallback(async () => {
    setTestState('testing');
    const result = await testConnectionAPI(conn);
    setTestState(result);
  }, [conn]);

  return (
    <div className="flex items-center gap-3 bg-[#0d0520] border border-fuchsia-500/15 rounded-xl px-4 py-3">
      {/* Platform badge */}
      <span className={`${pm.badge} text-white text-[9px] font-bold px-2 py-0.5 rounded-md shrink-0`}>
        {pm.label.slice(0, 3).toUpperCase()}
      </span>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-white truncate">{conn.label}</span>
          {testState && testState !== 'testing' && (
            testState.ok
              ? <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />
              : <AlertCircle size={11} className="text-red-400 shrink-0" />
          )}
        </div>
        <div className="text-[10px] text-purple-500/70 truncate">
          {maskToken(conn.token)}
          {metaSummary && <span className="ml-1 text-purple-400/60">· {metaSummary}</span>}
        </div>
        {testState && testState !== 'testing' && (
          <div className={`text-[10px] mt-0.5 truncate ${testState.ok ? 'text-emerald-400/80' : 'text-red-400/80'}`}>
            {testState.info}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={handleTest}
          disabled={testState === 'testing'}
          title="Test connection"
          className="p-1.5 text-purple-400 hover:text-fuchsia-300 transition-colors disabled:opacity-40"
        >
          {testState === 'testing'
            ? <Loader2 size={13} className="animate-spin" />
            : <RefreshCw size={13} />}
        </button>
        <button
          onClick={() => onDisconnect(conn.id)}
          title="Disconnect"
          className="p-1.5 text-purple-500/60 hover:text-red-400 transition-colors"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function ConnectionsManager({ connections, onChange, onClose }) {
  const [showAdd, setShowAdd] = useState(connections.length === 0);

  const handleSave = useCallback((conn) => {
    const next = [...connections, conn];
    saveConnections(next);
    onChange(next);
    setShowAdd(false);
  }, [connections, onChange]);

  const handleDisconnect = useCallback((id) => {
    const next = connections.filter(c => c.id !== id);
    saveConnections(next);
    onChange(next);
  }, [connections, onChange]);

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="conn-mgr-title"
    >
      <div
        className="bg-[#15092a] border border-fuchsia-500/30 rounded-xl shadow-[0_0_40px_rgba(192,38,211,0.25)] p-6 w-[480px] max-w-[95vw] max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5 shrink-0">
          <h2 id="conn-mgr-title" className="text-sm font-semibold text-white">Manage Connections</h2>
          <button onClick={onClose} className="text-purple-400 hover:text-white transition-colors" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-0.5">
          {connections.length === 0 && !showAdd && (
            <p className="text-xs text-purple-500/60 text-center py-4">No saved connections yet.</p>
          )}

          {connections.map(conn => (
            <ConnectionCard
              key={conn.id}
              conn={conn}
              onDisconnect={handleDisconnect}
            />
          ))}

          {showAdd ? (
            <AddForm
              onSave={handleSave}
              onCancel={() => setShowAdd(false)}
            />
          ) : (
            <button
              onClick={() => setShowAdd(true)}
              className="w-full py-2.5 text-xs text-fuchsia-400 hover:text-fuchsia-300 border border-dashed border-fuchsia-500/30 hover:border-fuchsia-400/50 rounded-xl transition-colors flex items-center justify-center gap-1.5"
            >
              <Plus size={13} /> Add Connection
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-2 text-xs font-medium bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
