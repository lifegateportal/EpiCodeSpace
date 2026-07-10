import React, { useState, useCallback, useEffect } from 'react';
import {
  X, Plus, Trash2, CheckCircle2, AlertCircle,
  Loader2, Eye, EyeOff, RefreshCw, CloudUpload, CloudDownload, Cloud, HardDrive,
} from 'lucide-react';
import {
  loadConnections, saveConnections, makeConnection, PLATFORM_META,
} from '../lib/connections.js';
import {
  verifyGistToken, pushToGist, pullFromGist, GIST_TOKEN_KEY, GIST_ID_KEY,
} from '../lib/gistSync.js';
import {
  checkR2Status, listR2Saves, saveToR2, loadFromR2, deleteR2Save,
} from '../lib/r2Sync.js';
import {
  checkRepoStatus,
  createRepoSnapshot,
  saveRepoRevision,
  loadRepoFromUrl,
  parseRepoUrl,
} from '../lib/repoSync.js';

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

// ─── R2 Sync Panel ────────────────────────────────────────────────────────────
function R2SyncPanel({ fileSystem, projectName, projectRepoUrl = '', onPullSuccess }) {
  const [open,      setOpen]      = useState(false);
  const [r2Status,  setR2Status]  = useState(null); // null | 'checking' | { ok, bucket } | { ok: false, error }
  const [saves,     setSaves]     = useState([]);
  const [loadingSaves, setLoadingSaves] = useState(false);
  const [status,    setStatus]    = useState(null); // null | 'saving' | 'loading' | { ok, msg }
  const [deleting,  setDeleting]  = useState(null); // key being deleted

  const isOp = status === 'saving' || status === 'loading' || !!deleting;

  // Auto-check status when panel opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setR2Status('checking');
      const r = await checkR2Status();
      if (cancelled) return;
      setR2Status(r);
      if (r.ok) fetchSaves();
    })();
    return () => { cancelled = true; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchSaves = useCallback(async () => {
    setLoadingSaves(true);
    const r = await listR2Saves();
    setLoadingSaves(false);
    if (r.ok) setSaves(r.saves || []);
  }, []);

  const handleSave = useCallback(async (snapshot = false) => {
    setStatus('saving');
    const r = await saveToR2(fileSystem || {}, projectName || '', { snapshot, repoUrl: projectRepoUrl });
    if (r.ok) {
      setStatus({ ok: true, msg: `Saved → ${r.key}` });
      fetchSaves();
    } else {
      setStatus({ ok: false, msg: r.error });
    }
  }, [fileSystem, projectName, fetchSaves]);

  const handleLoad = useCallback(async (key) => {
    setStatus('loading');
    const r = await loadFromR2(key);
    if (r.ok) {
      setStatus({ ok: true, msg: `Restored ${Object.keys(r.files || {}).length} files` });
      onPullSuccess?.(r);
    } else {
      setStatus({ ok: false, msg: r.error });
    }
  }, [onPullSuccess]);

  const handleDelete = useCallback(async (key) => {
    setDeleting(key);
    await deleteR2Save(key);
    setDeleting(null);
    fetchSaves();
  }, [fetchSaves]);

  const r2Ready = r2Status && typeof r2Status === 'object' && r2Status.ok;

  return (
    <div className="border border-fuchsia-500/20 rounded-xl overflow-hidden mb-2">
      {/* Header */}
      <button
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[#0d0520] hover:bg-[#130a28] transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <HardDrive size={13} className="text-orange-400" />
          <span className="text-xs font-medium text-white">R2 Storage</span>
          {r2Ready && <span className="text-[9px] bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded-full">ON</span>}
          {r2Status && typeof r2Status === 'object' && !r2Status.ok && <span className="text-[9px] bg-red-600/30 text-red-400 border border-red-500/30 px-1.5 py-0.5 rounded-full">NOT SET UP</span>}
        </div>
        <span className="text-[10px] text-purple-500">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="bg-[#0a0418] px-4 py-3 space-y-3">

          {/* Status check feedback */}
          {r2Status === 'checking' && (
            <div className="flex items-center gap-1.5 text-[11px] text-purple-400">
              <Loader2 size={11} className="animate-spin" /> Checking R2 connection…
            </div>
          )}
          {r2Status && typeof r2Status === 'object' && !r2Status.ok && (
            <div className="space-y-2">
              <div className="flex items-start gap-1.5 text-[11px] text-red-400">
                <AlertCircle size={11} className="mt-0.5 shrink-0" />
                <span>{r2Status.error}</span>
              </div>
              <p className="text-[10px] text-purple-400/60 leading-relaxed">
                Add these to your Replit Secrets tab:<br />
                <code className="bg-black/30 px-1 rounded">R2_ACCOUNT_ID</code>{' '}
                <code className="bg-black/30 px-1 rounded">R2_ACCESS_KEY_ID</code>{' '}
                <code className="bg-black/30 px-1 rounded">R2_SECRET_ACCESS_KEY</code>{' '}
                <code className="bg-black/30 px-1 rounded">R2_BUCKET_NAME</code>
              </p>
            </div>
          )}
          {r2Ready && (
            <p className="text-[10px] text-purple-400/70 leading-relaxed">
              Bucket: <code className="bg-black/30 px-1 rounded text-orange-300">{r2Status.bucket}</code>.
              Save your workspace to Cloudflare R2 and restore it on any device.
            </p>
          )}

          {/* Operation status */}
          {status && typeof status === 'object' && (
            <div className={`flex items-center gap-1.5 text-[11px] ${status.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {status.ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
              <span className="truncate">{status.msg}</span>
            </div>
          )}
          {(status === 'saving' || status === 'loading') && (
            <div className="flex items-center gap-1.5 text-[11px] text-purple-400">
              <Loader2 size={11} className="animate-spin" />
              {status === 'saving' ? 'Saving to R2…' : 'Loading from R2…'}
            </div>
          )}

          {/* Actions */}
          {r2Ready && (
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => handleSave(false)} disabled={isOp}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-[#15092a] border border-fuchsia-500/20 hover:border-orange-400/50 text-orange-300 hover:text-white rounded-lg transition-colors disabled:opacity-40">
                <CloudUpload size={11} /> Save Now
              </button>
              <button onClick={() => handleSave(true)} disabled={isOp}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-[#15092a] border border-fuchsia-500/20 hover:border-orange-400/50 text-orange-300 hover:text-white rounded-lg transition-colors disabled:opacity-40">
                <CloudUpload size={11} /> Snapshot
              </button>
              <button onClick={fetchSaves} disabled={loadingSaves || isOp}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-[#15092a] border border-fuchsia-500/20 hover:border-fuchsia-400/50 text-fuchsia-300 hover:text-white rounded-lg transition-colors disabled:opacity-40">
                <RefreshCw size={11} className={loadingSaves ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
          )}

          {/* Saves list */}
          {r2Ready && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {loadingSaves && saves.length === 0 && (
                <p className="text-[10px] text-purple-500/50 text-center py-2">Loading saves…</p>
              )}
              {!loadingSaves && saves.length === 0 && (
                <p className="text-[10px] text-purple-500/50 text-center py-2">No saves yet. Press "Save Now" to create one.</p>
              )}
              {saves.map(s => (
                <div key={s.key} className="flex items-center gap-2 bg-[#15092a] border border-fuchsia-500/10 rounded-lg px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-white font-mono truncate">{s.key}</p>
                    <p className="text-[9px] text-purple-500/60">
                      {s.lastModified ? new Date(s.lastModified).toLocaleString() : ''}{' '}
                      {s.size ? `· ${(s.size / 1024).toFixed(1)} KB` : ''}
                    </p>
                  </div>
                  <button onClick={() => handleLoad(s.key)} disabled={isOp}
                    className="text-[10px] text-orange-400 hover:text-white disabled:opacity-40 transition-colors px-1.5 py-1">
                    <CloudDownload size={11} />
                  </button>
                  <button onClick={() => handleDelete(s.key)} disabled={!!deleting || isOp}
                    className="text-[10px] text-red-500/60 hover:text-red-400 disabled:opacity-40 transition-colors px-1.5 py-1">
                    {deleting === s.key ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-purple-500/40">
            "Save Now" overwrites the latest save. "Snapshot" creates a timestamped backup.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Gist Sync Panel ──────────────────────────────────────────────────────────
function GistSyncPanel({ fileSystem, projectName, onPullSuccess }) {
  const [token,    setToken]    = useState(() => { try { return localStorage.getItem(GIST_TOKEN_KEY) || ''; } catch { return ''; } });
  const [showTok,  setShowTok]  = useState(false);
  const [gistId,   setGistIdUI] = useState(() => { try { return localStorage.getItem(GIST_ID_KEY) || ''; } catch { return ''; } });
  const [status,   setStatus]   = useState(null); // null | 'verifying' | 'pushing' | 'pulling' | { ok, msg }
  const [open,     setOpen]     = useState(false);

  const saveToken = useCallback((val) => {
    setToken(val);
    try { if (val.trim()) localStorage.setItem(GIST_TOKEN_KEY, val.trim()); else localStorage.removeItem(GIST_TOKEN_KEY); } catch { /* quota */ }
  }, []);

  const handleVerify = useCallback(async () => {
    if (!token.trim()) return;
    setStatus('verifying');
    const r = await verifyGistToken(token.trim());
    setStatus({ ok: r.ok, msg: r.ok ? `Authenticated as @${r.login}` : r.error });
  }, [token]);

  const handlePush = useCallback(async () => {
    setStatus('pushing');
    const r = await pushToGist(fileSystem || {}, projectName || '');
    if (r.ok) {
      setGistIdUI(r.gistId || '');
      setStatus({ ok: true, msg: `Pushed — Gist ${r.gistId}` });
    } else {
      setStatus({ ok: false, msg: r.error });
    }
  }, [fileSystem, projectName]);

  const handlePull = useCallback(async () => {
    setStatus('pulling');
    const r = await pullFromGist();
    if (r.ok) {
      setStatus({ ok: true, msg: `Pulled workspace: ${Object.keys(r.files || {}).length} files` });
      onPullSuccess?.(r);
    } else {
      setStatus({ ok: false, msg: r.error });
    }
  }, [onPullSuccess]);

  const isLoading = status === 'verifying' || status === 'pushing' || status === 'pulling';
  const loadingLabel = status === 'verifying' ? 'Verifying…' : status === 'pushing' ? 'Pushing…' : status === 'pulling' ? 'Pulling…' : '';

  return (
    <div className="border border-fuchsia-500/20 rounded-xl overflow-hidden mb-2">
      {/* Header toggle */}
      <button
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[#0d0520] hover:bg-[#130a28] transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Cloud size={13} className="text-fuchsia-400" />
          <span className="text-xs font-medium text-white">Gist Sync</span>
          {token && <span className="text-[9px] bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded-full">ON</span>}
        </div>
        <span className="text-[10px] text-purple-500">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="bg-[#0a0418] px-4 py-3 space-y-3">
          <p className="text-[10px] text-purple-400/70 leading-relaxed">
            Auto-saves your workspace to a private GitHub Gist. Accessible from any device with the same token.
            Requires a token with <code className="bg-black/30 px-1 rounded">gist</code> scope.
          </p>

          {/* Token input */}
          <div className="flex gap-2">
            <input
              type={showTok ? 'text' : 'password'}
              value={token}
              onChange={e => saveToken(e.target.value)}
              placeholder="ghp_… (gist scope)"
              autoComplete="off"
              className="flex-1 bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60"
            />
            <button onClick={() => setShowTok(p => !p)}
              className="px-3 py-2 text-purple-400 hover:text-white bg-[#15092a] border border-fuchsia-500/20 rounded-lg transition-colors">
              {showTok ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>

          {/* Gist ID (read-only) */}
          {gistId && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-purple-500/60">Gist ID:</span>
              <code className="text-[10px] text-purple-300/70 font-mono">{gistId}</code>
              <button onClick={() => { try { localStorage.removeItem(GIST_ID_KEY); setGistIdUI(''); } catch { /* */ } }}
                className="text-[10px] text-red-400/60 hover:text-red-400 ml-auto">clear</button>
            </div>
          )}

          {/* Status */}
          {status && typeof status === 'object' && (
            <div className={`flex items-center gap-1.5 text-[11px] ${status.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {status.ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
              <span className="truncate">{status.msg}</span>
            </div>
          )}
          {isLoading && (
            <div className="flex items-center gap-1.5 text-[11px] text-purple-400">
              <Loader2 size={11} className="animate-spin" /> {loadingLabel}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 flex-wrap">
            <button onClick={handleVerify} disabled={!token.trim() || isLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-[#15092a] border border-fuchsia-500/20 hover:border-fuchsia-400/50 text-fuchsia-300 hover:text-white rounded-lg transition-colors disabled:opacity-40">
              <RefreshCw size={11} /> Verify Token
            </button>
            <button onClick={handlePush} disabled={!token.trim() || isLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-[#15092a] border border-fuchsia-500/20 hover:border-fuchsia-400/50 text-fuchsia-300 hover:text-white rounded-lg transition-colors disabled:opacity-40">
              <CloudUpload size={11} /> Push Now
            </button>
            <button onClick={handlePull} disabled={!token.trim() || !gistId || isLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-[#15092a] border border-fuchsia-500/20 hover:border-fuchsia-400/50 text-fuchsia-300 hover:text-white rounded-lg transition-colors disabled:opacity-40">
              <CloudDownload size={11} /> Pull & Restore
            </button>
          </div>
          <p className="text-[10px] text-purple-500/50">
            Auto-push fires 3 s after you stop editing. "Pull & Restore" replaces your current workspace with the Gist copy.
          </p>
        </div>
      )}
    </div>
  );
}

function RepoSyncPanel({ fileSystem, projectName, projectRepoUrl = '', onPullSuccess, onRepoUrlChange }) {
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState(() => {
    try { return localStorage.getItem('epicodespace_repo_owner_v1') || 'me'; } catch { return 'me'; }
  });
  const [slug, setSlug] = useState(() => {
    const fallback = (projectName || 'project')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return fallback || 'project';
  });
  const [visibility, setVisibility] = useState(() => {
    try {
      const saved = localStorage.getItem('epicodespace_repo_visibility_v1');
      if (saved === 'private' || saved === 'unlisted' || saved === 'public') return saved;
    } catch {
      // ignore storage access failures
    }
    return 'private';
  });
  const [repoInput, setRepoInput] = useState(projectRepoUrl || '');
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(null); // 'checking'|'creating'|'saving'|'loading'
  const [apiStatus, setApiStatus] = useState(null);

  useEffect(() => {
    setRepoInput(projectRepoUrl || '');
    const parsed = parseRepoUrl(projectRepoUrl || '');
    if (parsed.ok) {
      setOwner(parsed.owner);
      setSlug(parsed.slug);
    }
  }, [projectRepoUrl]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading('checking');
      const res = await checkRepoStatus();
      if (cancelled) return;
      setApiStatus(res);
      setLoading(null);
    })();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    try {
      localStorage.setItem('epicodespace_repo_visibility_v1', visibility);
    } catch {
      // ignore storage access failures
    }
  }, [visibility]);

  const setOk = (msg) => setStatus({ ok: true, msg });
  const setErr = (msg) => setStatus({ ok: false, msg });

  const handleCreateRepo = useCallback(async () => {
    setLoading('creating');
    const res = await createRepoSnapshot({
      owner,
      slug,
      visibility,
      projectName,
      files: fileSystem || {},
      repoUrl: projectRepoUrl || '',
      message: 'Initial revision',
    });
    setLoading(null);
    if (!res.ok) {
      setErr(res.error || 'Failed to create repo.');
      return;
    }
    const url = res.urls?.repo || `/r/${owner}/${slug}`;
    setRepoInput(url);
    onRepoUrlChange?.(url);
    try { localStorage.setItem('epicodespace_repo_owner_v1', owner); } catch { /* ignore */ }
    setOk(`Repository created: ${url}`);
  }, [owner, slug, visibility, projectName, fileSystem, projectRepoUrl, onRepoUrlChange]);

  const handleSaveRevision = useCallback(async () => {
    if (!repoInput.trim()) {
      setErr('Set or create a repository URL first.');
      return;
    }
    setLoading('saving');
    const res = await saveRepoRevision({
      repoUrl: repoInput.trim(),
      files: fileSystem || {},
      projectName,
      message: 'Save revision',
    });
    setLoading(null);
    if (!res.ok) {
      setErr(res.error || 'Failed to save revision.');
      return;
    }
    const revisionUrl = res.urls?.revision || 'Revision saved';
    onRepoUrlChange?.(res.urls?.repo || repoInput.trim());
    setOk(`Revision saved: ${revisionUrl}`);
  }, [repoInput, fileSystem, projectName, onRepoUrlChange]);

  const handleLoadByUrl = useCallback(async () => {
    if (!repoInput.trim()) {
      setErr('Enter a repository URL to load.');
      return;
    }
    setLoading('loading');
    const res = await loadRepoFromUrl(repoInput.trim());
    setLoading(null);
    if (!res.ok) {
      setErr(res.error || 'Failed to load repository.');
      return;
    }
    onPullSuccess?.(res);
    onRepoUrlChange?.(res.repoUrl || repoInput.trim());
    setOk(`Loaded ${Object.keys(res.files || {}).length} files from ${res.repoUrl}`);
  }, [repoInput, onPullSuccess, onRepoUrlChange]);

  const busy = !!loading;

  return (
    <div className="border border-fuchsia-500/20 rounded-xl overflow-hidden mb-2">
      <button
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[#0d0520] hover:bg-[#130a28] transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Cloud size={13} className="text-cyan-400" />
          <span className="text-xs font-medium text-white">Repo URL Sync</span>
          {projectRepoUrl && <span className="text-[9px] bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded-full">LINKED</span>}
        </div>
        <span className="text-[10px] text-purple-500">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="bg-[#0a0418] px-4 py-3 space-y-3">
          <p className="text-[10px] text-purple-400/70 leading-relaxed">
            Create an Epicodespace repository URL, save immutable revisions, and load any repo URL on any device.
          </p>

          {apiStatus?.ok === false && (
            <div className="flex items-start gap-1.5 text-[11px] text-red-400">
              <AlertCircle size={11} className="mt-0.5 shrink-0" />
              <span>{apiStatus.error}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <input
              value={owner}
              onChange={e => setOwner(e.target.value)}
              placeholder="owner"
              className="bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-2 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none"
            />
            <input
              value={slug}
              onChange={e => setSlug(e.target.value)}
              placeholder="project-slug"
              className="bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-2 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none"
            />
          </div>

          <div className="flex gap-1">
            {['private', 'unlisted', 'public'].map(v => (
              <button
                key={v}
                onClick={() => setVisibility(v)}
                className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                  visibility === v
                    ? 'bg-cyan-600 border-cyan-500 text-white'
                    : 'border-fuchsia-500/20 text-purple-400 hover:text-white'
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          <input
            value={repoInput}
            onChange={e => setRepoInput(e.target.value)}
            placeholder="/r/owner/project or https://.../r/owner/project"
            className="w-full bg-[#15092a] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none"
          />

          {status && (
            <div className={`flex items-center gap-1.5 text-[11px] ${status.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {status.ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
              <span className="truncate">{status.msg}</span>
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-1.5 text-[11px] text-purple-400">
              <Loader2 size={11} className="animate-spin" />
              {loading === 'checking' ? 'Checking repo API…' : loading === 'creating' ? 'Creating repo…' : loading === 'saving' ? 'Saving revision…' : 'Loading repo…'}
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handleCreateRepo}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-[#15092a] border border-cyan-500/40 text-cyan-300 hover:text-white rounded-lg transition-colors disabled:opacity-40"
            >
              <Plus size={11} /> Create Repo URL
            </button>
            <button
              onClick={handleSaveRevision}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-[#15092a] border border-fuchsia-500/20 text-fuchsia-300 hover:text-white rounded-lg transition-colors disabled:opacity-40"
            >
              <CloudUpload size={11} /> Save Revision
            </button>
            <button
              onClick={handleLoadByUrl}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-[#15092a] border border-orange-500/30 text-orange-300 hover:text-white rounded-lg transition-colors disabled:opacity-40"
            >
              <CloudDownload size={11} /> Load URL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function ConnectionsManager({ connections, onChange, onClose, onGistPull, fileSystem, projectName, projectRepoUrl, onRepoUrlChange }) {
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
          <RepoSyncPanel
            fileSystem={fileSystem}
            projectName={projectName}
            projectRepoUrl={projectRepoUrl}
            onPullSuccess={onGistPull}
            onRepoUrlChange={onRepoUrlChange}
          />
          {/* R2 Storage sync */}
          <R2SyncPanel fileSystem={fileSystem} projectName={projectName} projectRepoUrl={projectRepoUrl} onPullSuccess={onGistPull} />
          {/* Gist Sync */}
          <GistSyncPanel fileSystem={fileSystem} projectName={projectName} onPullSuccess={onGistPull} />

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
