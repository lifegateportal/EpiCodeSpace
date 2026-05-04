import React, { useState, useCallback } from 'react';
import { X, Eye, EyeOff, Rocket, CheckCircle2, AlertCircle, Loader2, Plus, Trash2, Settings, Link, Copy, Clock } from 'lucide-react';
import { PLATFORM_META } from '../lib/connections.js';

const TOKEN_KEYS = {
  netlify: 'epicodespace_deploy_netlify_token',
  vercel:  'epicodespace_deploy_vercel_token',
  github:  'epicodespace_deploy_github_token',
};
const NETLIFY_SITE_KEY    = 'epicodespace_deploy_netlify_site_';
const GITHUB_REPO_KEY     = 'epicodespace_deploy_github_repo';
const CUSTOM_CFG_KEY      = 'epicodespace_deploy_custom_cfg';
const DEPLOY_HISTORY_KEY  = 'epicodespace_deploy_history';
const EPICGLOBAL_CFG_KEY  = 'epicodespace_deploy_epicglobal_cfg';

// ─── Deploy URL history helpers ───────────────────────────────────────────────
function loadDeployHistory() {
  try { return JSON.parse(localStorage.getItem(DEPLOY_HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveDeployRecord(projectName, platform, url) {
  const history = loadDeployHistory();
  // Upsert: same project+platform combo → replace, keep latest on top
  const filtered = history.filter(r => !(r.projectName === projectName && r.platform === platform));
  filtered.unshift({ projectName, platform, url, deployedAt: new Date().toISOString() });
  // Keep at most 50 records
  localStorage.setItem(DEPLOY_HISTORY_KEY, JSON.stringify(filtered.slice(0, 50)));
}
function getProjectHistory(projectName) {
  return loadDeployHistory().filter(r => r.projectName === projectName);
}

// ─── Crypto helpers ──────────────────────────────────────────────────────────
async function sha1Hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Platform deployers ───────────────────────────────────────────────────────
async function deployNetlify({ token, siteName, projectName, files, onProgress }) {
  const safeName = (siteName || projectName).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 1. Create or reuse site
  onProgress({ message: 'Finding/creating Netlify site…', percent: 5 });
  let siteId = localStorage.getItem(NETLIFY_SITE_KEY + safeName);
  if (!siteId) {
    const r = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ name: safeName }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Site create failed (${r.status}): ${txt.slice(0, 200)}`);
    }
    const site = await r.json();
    siteId = site.id;
    localStorage.setItem(NETLIFY_SITE_KEY + safeName, siteId);
  }

  // 2. Hash files
  onProgress({ message: 'Hashing files…', percent: 20 });
  const entries = Object.entries(files).filter(([, f]) => f?.content != null);
  const fileMap  = {};  // netlify path → sha1
  const contentByHash = {};
  for (const [path, f] of entries) {
    const content = f.content ?? '';
    const hash = await sha1Hex(content);
    fileMap['/' + path] = hash;
    contentByHash[hash] = { path, content };
  }

  // 3. Open deploy
  onProgress({ message: 'Opening deploy…', percent: 35 });
  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ files: fileMap }),
  });
  if (!deployRes.ok) {
    const txt = await deployRes.text();
    throw new Error(`Deploy open failed (${deployRes.status}): ${txt.slice(0, 200)}`);
  }
  const deploy = await deployRes.json();
  const required = deploy.required || [];

  // 4. Upload missing files
  let done = 0;
  for (const hash of required) {
    const entry = contentByHash[hash];
    if (!entry) continue;
    const filePath = '/' + entry.path.replace(/^\/+/, '');
    const upRes = await fetch(
      `https://api.netlify.com/api/v1/deploys/${deploy.id}/files${filePath}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: entry.content,
      }
    );
    if (!upRes.ok) throw new Error(`Upload failed for ${entry.path}`);
    done++;
    onProgress({
      message: `Uploading files… ${done}/${required.length}`,
      percent: 40 + Math.round((done / Math.max(required.length, 1)) * 55),
    });
  }

  const url = deploy.deploy_ssl_url || deploy.deploy_url || `https://${safeName}.netlify.app`;
  return { url };
}

async function deployVercel({ token, projectName, files, onProgress }) {
  const name = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  onProgress({ message: 'Creating Vercel deployment…', percent: 15 });

  const fileEntries = Object.entries(files).filter(([, f]) => f?.content != null);
  const vercelFiles = fileEntries.map(([path, f]) => ({
    file: path,
    data: f.content ?? '',
    encoding: 'utf8',
  }));

  const res = await fetch('https://api.vercel.com/v13/deployments', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, files: vercelFiles, projectSettings: { framework: null } }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Vercel deploy failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  onProgress({ message: 'Deployment queued!', percent: 95 });
  return { url: data.url ? `https://${data.url}` : `https://${name}.vercel.app` };
}

async function deployGitHub({ token, repo, files, onProgress }) {
  const slash = repo.indexOf('/');
  if (slash < 1) throw new Error('Repo must be in "owner/repo-name" format');
  const owner = repo.slice(0, slash);
  const repoName = repo.slice(slash + 1);
  if (!repoName) throw new Error('Repo name cannot be empty');

  const base = `https://api.github.com/repos/${owner}/${repoName}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github.v3+json',
  };

  // Ensure repo exists
  onProgress({ message: 'Checking repository…', percent: 5 });
  const checkRes = await fetch(base, { headers });
  if (!checkRes.ok) {
    onProgress({ message: 'Creating repository…', percent: 8 });
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST', headers,
      body: JSON.stringify({ name: repoName, private: false, auto_init: true }),
    });
    if (!createRes.ok) {
      const txt = await createRes.text();
      throw new Error(`Repo create failed (${createRes.status}): ${txt.slice(0, 200)}`);
    }
    // Brief wait for GitHub to initialise the repo
    await new Promise(r => setTimeout(r, 1200));
  }

  const entries = Object.entries(files).filter(([, f]) => f?.content != null);
  let done = 0;
  for (const [path, f] of entries) {
    const content = f.content ?? '';
    // btoa safe for Unicode
    const encoded = btoa(unescape(encodeURIComponent(content)));

    // Fetch existing SHA so we can update rather than create a conflict
    let existingSha;
    const existing = await fetch(`${base}/contents/${path}`, { headers });
    if (existing.ok) {
      const j = await existing.json();
      existingSha = Array.isArray(j) ? undefined : j.sha;
    }

    const body = { message: `Deploy from EpiCodeSpace: ${path}`, content: encoded };
    if (existingSha) body.sha = existingSha;

    const putRes = await fetch(`${base}/contents/${path}`, {
      method: 'PUT', headers, body: JSON.stringify(body),
    });
    if (!putRes.ok) {
      const txt = await putRes.text();
      throw new Error(`Push failed for ${path} (${putRes.status}): ${txt.slice(0, 120)}`);
    }
    done++;
    onProgress({
      message: `Pushing files… ${done}/${entries.length}`,
      percent: 10 + Math.round((done / entries.length) * 85),
    });
  }

  return { url: `https://github.com/${owner}/${repoName}` };
}

async function deployCustom({ url, method, authType, authValue, authHeader, extraHeaders, projectName, files, onProgress }) {
  if (!url.trim()) throw new Error('Endpoint URL is required');
  const reqHeaders = { 'Content-Type': 'application/json' };
  if (authType === 'bearer' && authValue.trim()) {
    reqHeaders['Authorization'] = `Bearer ${authValue.trim()}`;
  } else if (authType === 'apikey' && authHeader.trim() && authValue.trim()) {
    reqHeaders[authHeader.trim()] = authValue.trim();
  } else if (authType === 'basic' && authValue.trim()) {
    reqHeaders['Authorization'] = `Basic ${btoa(unescape(encodeURIComponent(authValue.trim())))}`;  // user:pass
  }
  for (const h of extraHeaders) {
    if (h.key.trim() && h.value.trim()) reqHeaders[h.key.trim()] = h.value.trim();
  }
  onProgress({ message: 'Sending to endpoint…', percent: 30 });
  const body = JSON.stringify({
    projectName,
    files: Object.fromEntries(
      Object.entries(files)
        .filter(([, f]) => f?.content != null)
        .map(([p, f]) => [p, f.content])
    ),
    deployedAt: new Date().toISOString(),
  });
  const res = await fetch(url.trim(), { method, headers: reqHeaders, body });
  onProgress({ message: 'Response received…', percent: 85 });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  const resultUrl = data?.url || data?.deploy_url || data?.deploymentUrl || data?.link || data?.href || null;
  return { url: resultUrl || `Success (HTTP ${res.status})` };
}

async function deployEpiGlobal({ apiUrl, apiKey, projectName, files, onProgress }) {
  if (!apiUrl.trim()) throw new Error('EpiGlobal API URL is required');
  if (!apiKey.trim())  throw new Error('EpiGlobal API Key is required');
  onProgress({ message: 'Deploying to EpiGlobal…', percent: 20 });
  const fileEntries = Object.fromEntries(
    Object.entries(files)
      .filter(([, f]) => f?.content != null)
      .map(([p, f]) => [p, f.content])
  );
  const res = await fetch(apiUrl.trim().replace(/\/$/, '') + '/deploy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey.trim()}`,
      'X-Api-Key': apiKey.trim(),
    },
    body: JSON.stringify({ projectName, files: fileEntries, deployedAt: new Date().toISOString() }),
  });
  onProgress({ message: 'Waiting for response…', percent: 80 });
  const text = await res.text();
  if (!res.ok) throw new Error(`EpiGlobal error (${res.status}): ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  const url = data?.url || data?.deploy_url || data?.deploymentUrl || data?.appUrl || data?.link || null;
  return { url: url || `Deployed (HTTP ${res.status})` };
}

// ─── Component ────────────────────────────────────────────────────────────────
const PLATFORMS = [
  { id: 'epicglobal', label: 'EpiGlobal' },
  { id: 'netlify',    label: 'Netlify'   },
  { id: 'vercel',     label: 'Vercel'    },
  { id: 'github',     label: 'GitHub'    },
  { id: 'custom',     label: 'Custom'    },
];

const AUTH_TYPES = [
  { id: 'none',   label: 'None'        },
  { id: 'bearer', label: 'Bearer Token'},
  { id: 'apikey', label: 'API Key'     },
  { id: 'basic',  label: 'Basic'       },
];

export default function DeployModal({ projectName, fileSystem, onClose, connections = [], onManageConnections }) {
  const [selectedConn, setSelectedConn]   = useState(null);
  const [platform, setPlatform] = useState('netlify');
  const [showToken, setShowToken] = useState(false);

  const [netlifyToken,    setNetlifyToken]    = useState(() => localStorage.getItem(TOKEN_KEYS.netlify) || '');
  const [netlifySite,     setNetlifySite]     = useState('');
  const [vercelToken,     setVercelToken]     = useState(() => localStorage.getItem(TOKEN_KEYS.vercel)  || '');
  const [githubToken,     setGithubToken]     = useState(() => localStorage.getItem(TOKEN_KEYS.github)  || '');
  const [githubRepo,      setGithubRepo]      = useState(() => localStorage.getItem(GITHUB_REPO_KEY)    || '');

  // EpiGlobal state
  const loadEpiGlobalCfg = () => { try { return JSON.parse(localStorage.getItem(EPICGLOBAL_CFG_KEY) || '{}'); } catch { return {}; } };
  const [epicglobalApiUrl, setEpicglobalApiUrl] = useState(() => loadEpiGlobalCfg().apiUrl || 'https://api.epicglobal.app');
  const [epicglobalApiKey, setEpicglobalApiKey] = useState(() => loadEpiGlobalCfg().apiKey || '');
  const [showEpicglobalKey, setShowEpicglobalKey] = useState(false);

  // Custom endpoint state
  const loadCustomCfg = () => { try { return JSON.parse(localStorage.getItem(CUSTOM_CFG_KEY) || '{}'); } catch { return {}; } };
  const [customUrl,      setCustomUrl]      = useState(() => loadCustomCfg().url      || '');
  const [customMethod,   setCustomMethod]   = useState(() => loadCustomCfg().method   || 'POST');
  const [customAuthType, setCustomAuthType] = useState(() => loadCustomCfg().authType || 'bearer');
  const [customAuthVal,  setCustomAuthVal]  = useState(() => loadCustomCfg().authVal  || '');
  const [customAuthHdr,  setCustomAuthHdr]  = useState(() => loadCustomCfg().authHdr  || 'X-API-Key');
  const [customHeaders,  setCustomHeaders]  = useState(() => loadCustomCfg().headers  || []);
  const [showCustomPass, setShowCustomPass] = useState(false);

  const addCustomHeader    = useCallback(() => setCustomHeaders(h => [...h, { key: '', value: '' }]), []);
  const removeCustomHeader = useCallback((i) => setCustomHeaders(h => h.filter((_, idx) => idx !== i)), []);
  const updateCustomHeader = useCallback((i, field, val) =>
    setCustomHeaders(h => h.map((row, idx) => idx === i ? { ...row, [field]: val } : row)), []);

  const [progress, setProgress] = useState(null); // { message, percent }
  const [result,   setResult]   = useState(null); // { url } | { error }
  const [urlHistory, setUrlHistory] = useState(() => getProjectHistory(projectName));
  const [copiedUrl, setCopiedUrl] = useState(null);

  const copyUrl = useCallback((url) => {
    navigator.clipboard?.writeText(url).catch(() => {});
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 1500);
  }, []);

  const isDeploying = progress !== null && result === null;

  const token    = platform === 'netlify' ? netlifyToken : platform === 'vercel' ? vercelToken : githubToken;
  const setToken = platform === 'netlify' ? setNetlifyToken : platform === 'vercel' ? setVercelToken : setGithubToken;

  const switchPlatform = useCallback((id) => {
    setPlatform(id);
    setResult(null);
    setProgress(null);
    setShowToken(false);
  }, []);

  const handleDeploy = useCallback(async () => {
    setProgress({ message: 'Starting…', percent: 0 });
    setResult(null);
    try {
      const onProgress = ({ message, percent }) => setProgress({ message, percent });
      let res;

      // ── Use a saved connection ───────────────────────────────────────────
      if (selectedConn) {
        const { platform: cp, token: ct, meta: cm = {} } = selectedConn;
        if (cp === 'epicglobal') {
          res = await deployEpiGlobal({ apiUrl: cm.apiUrl || 'https://api.epicglobal.app', apiKey: ct, projectName, files: fileSystem, onProgress });
        } else if (cp === 'netlify') {
          res = await deployNetlify({ token: ct, siteName: cm.siteName || '', projectName, files: fileSystem, onProgress });
        } else if (cp === 'vercel') {
          res = await deployVercel({ token: ct, projectName, files: fileSystem, onProgress });
        } else if (cp === 'github') {
          if (!cm.repo) throw new Error('Repository not set on this connection. Edit it in Manage Connections.');
          res = await deployGitHub({ token: ct, repo: cm.repo, files: fileSystem, onProgress });
        } else {
          res = await deployCustom({
            url: cm.url || '', method: cm.method || 'POST', authType: cm.authType || 'none',
            authValue: cm.authVal || '', authHeader: cm.authHdr || '',
            extraHeaders: cm.headers || [], projectName, files: fileSystem, onProgress,
          });
        }

      // ── Manual entry ────────────────────────────────────────────────────
      } else if (platform === 'epicglobal') {
        if (!epicglobalApiKey.trim()) throw new Error('EpiGlobal API Key is required');
        localStorage.setItem(EPICGLOBAL_CFG_KEY, JSON.stringify({ apiUrl: epicglobalApiUrl, apiKey: epicglobalApiKey }));
        res = await deployEpiGlobal({ apiUrl: epicglobalApiUrl, apiKey: epicglobalApiKey, projectName, files: fileSystem, onProgress });

      } else if (platform === 'netlify') {
        if (!netlifyToken.trim()) throw new Error('Netlify token is required');
        localStorage.setItem(TOKEN_KEYS.netlify, netlifyToken.trim());
        res = await deployNetlify({ token: netlifyToken.trim(), siteName: netlifySite.trim(), projectName, files: fileSystem, onProgress });

      } else if (platform === 'vercel') {
        if (!vercelToken.trim()) throw new Error('Vercel token is required');
        localStorage.setItem(TOKEN_KEYS.vercel, vercelToken.trim());
        res = await deployVercel({ token: vercelToken.trim(), projectName, files: fileSystem, onProgress });

      } else if (platform === 'github') {
        if (!githubToken.trim()) throw new Error('GitHub token is required');
        if (!githubRepo.trim())  throw new Error('Repository is required (owner/repo-name)');
        localStorage.setItem(TOKEN_KEYS.github, githubToken.trim());
        localStorage.setItem(GITHUB_REPO_KEY, githubRepo.trim());
        res = await deployGitHub({ token: githubToken.trim(), repo: githubRepo.trim(), files: fileSystem, onProgress });

      } else if (platform === 'custom') {
        localStorage.setItem(CUSTOM_CFG_KEY, JSON.stringify({
          url: customUrl, method: customMethod, authType: customAuthType,
          authVal: customAuthVal, authHdr: customAuthHdr, headers: customHeaders,
        }));
        res = await deployCustom({
          url: customUrl, method: customMethod, authType: customAuthType,
          authValue: customAuthVal, authHeader: customAuthHdr,
          extraHeaders: customHeaders, projectName, files: fileSystem, onProgress,
        });
      }

      setProgress({ message: 'Done!', percent: 100 });
      setResult({ url: res.url });
      const usedPlatform = selectedConn ? selectedConn.platform : platform;
      saveDeployRecord(projectName, usedPlatform, res.url);
      setUrlHistory(getProjectHistory(projectName));
    } catch (err) {
      setProgress(null);
      setResult({ error: err.message });
    }
  }, [selectedConn, platform, netlifyToken, netlifySite, vercelToken, githubToken, githubRepo,
      customUrl, customMethod, customAuthType, customAuthVal, customAuthHdr, customHeaders,
      projectName, fileSystem]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="deploy-title"
    >
      <div
        className="bg-[#15092a] border border-fuchsia-500/30 rounded-xl shadow-[0_0_40px_rgba(192,38,211,0.25)] p-6 w-[480px] max-w-[95vw] max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Project URL History */}
        {urlHistory.length > 0 && (
          <div className="mb-5 p-3 rounded-lg bg-[#0d0520] border border-fuchsia-500/15">
            <div className="flex items-center gap-1.5 mb-2">
              <Link size={11} className="text-fuchsia-400" />
              <span className="text-[10px] font-semibold text-purple-400 uppercase tracking-wider">Project URLs</span>
            </div>
            <div className="space-y-1.5">
              {urlHistory.map((rec, i) => {
                const pm = PLATFORM_META[rec.platform] || PLATFORM_META.custom;
                const dateStr = new Date(rec.deployedAt).toLocaleDateString();
                return (
                  <div key={i} className="flex items-center gap-2 group">
                    <span className={`${pm.badge} text-white text-[8px] font-bold px-1.5 py-0.5 rounded shrink-0`}>
                      {pm.label.slice(0, 3).toUpperCase()}
                    </span>
                    <a
                      href={rec.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 min-w-0 text-[11px] text-fuchsia-300 hover:text-fuchsia-200 truncate underline"
                    >{rec.url}</a>
                    <span className="text-[9px] text-purple-600 flex items-center gap-0.5 shrink-0">
                      <Clock size={8} />{dateStr}
                    </span>
                    <button
                      onClick={() => copyUrl(rec.url)}
                      className="shrink-0 text-purple-500 hover:text-fuchsia-300 transition-colors"
                      aria-label="Copy URL"
                    >
                      {copiedUrl === rec.url
                        ? <CheckCircle2 size={12} className="text-emerald-400" />
                        : <Copy size={12} />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <Rocket size={17} className="text-fuchsia-400" />
            <h2 id="deploy-title" className="text-sm font-semibold text-white">
              Deploy <span className="text-fuchsia-300">"{projectName}"</span>
            </h2>
          </div>
          <button onClick={onClose} className="text-purple-400 hover:text-white transition-colors" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        {/* ── Saved Connections ── */}
        {connections.length > 0 && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-semibold text-purple-400 uppercase tracking-wider">Saved Connections</span>
              {onManageConnections && (
                <button
                  onClick={onManageConnections}
                  className="text-[10px] text-fuchsia-400 hover:text-fuchsia-300 flex items-center gap-1 transition-colors"
                >
                  <Settings size={10} /> Manage
                </button>
              )}
            </div>
            <div className="space-y-1.5">
              {connections.map(conn => {
                const pm = PLATFORM_META[conn.platform] || PLATFORM_META.custom;
                const isSelected = selectedConn?.id === conn.id;
                const metaLine = conn.platform === 'github' ? conn.meta?.repo
                  : conn.platform === 'netlify' ? conn.meta?.siteName
                  : conn.platform === 'custom' ? conn.meta?.url
                  : null;
                return (
                  <button
                    key={conn.id}
                    onClick={() => setSelectedConn(isSelected ? null : conn)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                      isSelected
                        ? 'border-fuchsia-500/60 bg-fuchsia-900/20'
                        : 'border-fuchsia-500/10 bg-[#0d0520] hover:border-fuchsia-500/30'
                    }`}
                  >
                    <span className={`${pm.badge} text-white text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0`}>
                      {pm.label.slice(0, 3).toUpperCase()}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs text-white">{conn.label}</span>
                      {metaLine && <span className="text-[10px] text-purple-500/60 ml-2">{metaLine}</span>}
                    </div>
                    {isSelected && <CheckCircle2 size={13} className="text-fuchsia-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
            {selectedConn && (
              <p className="text-[10px] text-purple-500/50 mt-2 text-center">
                Ready to deploy using <span className="text-fuchsia-400">{selectedConn.label}</span>. Hit Deploy below.
              </p>
            )}
          </div>
        )}

        {/* Show manual form only when no connection selected */}
        {!selectedConn && (
          <>
          {connections.length > 0 && (
            <div className="flex items-center gap-2 mb-4">
              <div className="flex-1 h-px bg-fuchsia-500/10" />
              <span className="text-[10px] text-purple-500/50">or deploy manually</span>
              <div className="flex-1 h-px bg-fuchsia-500/10" />
            </div>
          )}

        {/* Platform tabs */}
        <div className="flex gap-1 mb-5 bg-[#0d0520] rounded-lg p-1">
          {PLATFORMS.map(p => (
            <button
              key={p.id}
              onClick={() => switchPlatform(p.id)}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                platform === p.id ? 'bg-fuchsia-600 text-white' : 'text-purple-400 hover:text-white'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Token input — hidden for Custom and EpiGlobal tabs (they have their own UI) */}
        {platform !== 'custom' && platform !== 'epicglobal' && (
          <div className="mb-4">
            <label className="block text-xs text-purple-400 mb-1.5">
              {platform === 'netlify' ? 'Netlify Personal Access Token'
                : platform === 'vercel' ? 'Vercel Token'
                : 'GitHub Personal Access Token'}
            </label>
            <div className="flex gap-2">
              <input
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder={
                  platform === 'netlify' ? 'nfp_…'
                    : platform === 'vercel' ? 'your vercel token'
                    : 'ghp_…'
                }
                autoComplete="off"
                className="flex-1 bg-[#0d0520] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60"
              />
              <button
                onClick={() => setShowToken(p => !p)}
                className="px-3 py-2 text-purple-400 hover:text-white bg-[#0d0520] border border-fuchsia-500/20 rounded-lg transition-colors"
                aria-label={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <p className="text-[10px] text-purple-500/50 mt-1">
              {platform === 'netlify' && <>Get it at: app.netlify.com/user/applications</>}
              {platform === 'vercel'  && <>Get it at: vercel.com/account/tokens</>}
              {platform === 'github'  && <>Get it at: github.com/settings/tokens (needs <code>repo</code> scope)</>}
            </p>
          </div>
        )}

        {/* ─── EpiGlobal form ─── */}
        {platform === 'epicglobal' && (
          <div className="space-y-3 mb-4">
            <div className="p-3 rounded-lg bg-fuchsia-900/20 border border-fuchsia-500/20">
              <p className="text-[10px] text-fuchsia-300/80 leading-relaxed">
                Deploy directly to <strong>EpiGlobal</strong> — no Git required.
                Find your API key on the EpiGlobal dashboard under <em>Setup → EpiCodeSpaces API credentials</em>.
              </p>
            </div>
            <div>
              <label className="block text-xs text-purple-400 mb-1.5">EpiGlobal API URL</label>
              <input
                type="url"
                value={epicglobalApiUrl}
                onChange={e => setEpicglobalApiUrl(e.target.value)}
                placeholder="https://api.epicglobal.app"
                className="w-full bg-[#0d0520] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60"
              />
            </div>
            <div>
              <label className="block text-xs text-purple-400 mb-1.5">EpiGlobal API Key <span className="text-purple-600">(VITE_ORCHESTRATOR_API_KEY)</span></label>
              <div className="flex gap-2">
                <input
                  type={showEpicglobalKey ? 'text' : 'password'}
                  value={epicglobalApiKey}
                  onChange={e => setEpicglobalApiKey(e.target.value)}
                  placeholder="Paste your API key here"
                  autoComplete="off"
                  className="flex-1 bg-[#0d0520] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60"
                />
                <button
                  onClick={() => setShowEpicglobalKey(v => !v)}
                  className="px-3 py-2 text-purple-400 hover:text-white bg-[#0d0520] border border-fuchsia-500/20 rounded-lg transition-colors"
                  aria-label={showEpicglobalKey ? 'Hide key' : 'Show key'}
                >
                  {showEpicglobalKey ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Platform-specific extras */}
        {platform === 'netlify' && (
          <div className="mb-4">
            <label className="block text-xs text-purple-400 mb-1.5">Site Name <span className="text-purple-600">(optional)</span></label>
            <input
              type="text"
              value={netlifySite}
              onChange={e => setNetlifySite(e.target.value)}
              placeholder={projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}
              className="w-full bg-[#0d0520] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60"
            />
          </div>
        )}

        {platform === 'github' && (
          <div className="mb-4">
            <label className="block text-xs text-purple-400 mb-1.5">Repository</label>
            <input
              type="text"
              value={githubRepo}
              onChange={e => setGithubRepo(e.target.value)}
              placeholder="username/my-project"
              className="w-full bg-[#0d0520] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60"
            />
            <p className="text-[10px] text-purple-500/50 mt-1">Created automatically if it doesn't exist</p>
          </div>
        )}

        {platform === 'vercel' && (
          <div className="mb-4 p-3 rounded-lg bg-amber-900/20 border border-amber-500/20">
            <p className="text-[10px] text-amber-300/80 leading-relaxed">
              Vercel's API may block browser-side requests due to CORS.
              If the deploy fails, use the terminal command instead:{' '}
              <code className="font-mono bg-black/30 px-1 rounded">deploy vercel</code>
            </p>
          </div>
        )}

        {/* ─── Custom endpoint UI ─── */}
        {platform === 'custom' && (
          <div className="space-y-3 mb-4">
            {/* URL + Method */}
            <div className="flex gap-2">
              <select
                value={customMethod}
                onChange={e => setCustomMethod(e.target.value)}
                className="bg-[#0d0520] border border-fuchsia-500/20 rounded-lg px-2 py-2 text-xs text-white focus:outline-none focus:border-fuchsia-400/60 shrink-0"
              >
                <option>POST</option>
                <option>PUT</option>
                <option>PATCH</option>
              </select>
              <input
                type="url"
                value={customUrl}
                onChange={e => setCustomUrl(e.target.value)}
                placeholder="https://your-platform.com/api/deploy"
                className="flex-1 bg-[#0d0520] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60"
              />
            </div>

            {/* Auth type */}
            <div>
              <label className="block text-xs text-purple-400 mb-1.5">Auth</label>
              <div className="flex gap-1 flex-wrap">
                {AUTH_TYPES.map(a => (
                  <button
                    key={a.id}
                    onClick={() => setCustomAuthType(a.id)}
                    className={`px-2.5 py-1 text-[10px] rounded-md border transition-colors ${
                      customAuthType === a.id
                        ? 'bg-fuchsia-600 border-fuchsia-600 text-white'
                        : 'border-fuchsia-500/20 text-purple-400 hover:text-white'
                    }`}
                  >{a.label}</button>
                ))}
              </div>
            </div>

            {/* Auth value inputs */}
            {customAuthType !== 'none' && (
              <div className="space-y-2">
                {customAuthType === 'apikey' && (
                  <input
                    type="text"
                    value={customAuthHdr}
                    onChange={e => setCustomAuthHdr(e.target.value)}
                    placeholder="Header name (e.g. X-API-Key)"
                    className="w-full bg-[#0d0520] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60"
                  />
                )}
                <div className="flex gap-2">
                  <input
                    type={showCustomPass ? 'text' : 'password'}
                    value={customAuthVal}
                    onChange={e => setCustomAuthVal(e.target.value)}
                    placeholder={
                      customAuthType === 'bearer' ? 'Token or API key'
                        : customAuthType === 'basic' ? 'username:password'
                        : 'Value'
                    }
                    autoComplete="off"
                    className="flex-1 bg-[#0d0520] border border-fuchsia-500/20 rounded-lg px-3 py-2 text-xs text-white placeholder-purple-500/50 focus:outline-none focus:border-fuchsia-400/60"
                  />
                  <button
                    onClick={() => setShowCustomPass(p => !p)}
                    className="px-3 py-2 text-purple-400 hover:text-white bg-[#0d0520] border border-fuchsia-500/20 rounded-lg transition-colors"
                    aria-label={showCustomPass ? 'Hide' : 'Show'}
                  >
                    {showCustomPass ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </div>
            )}

            {/* Extra headers */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-purple-400">Extra Headers</label>
                <button
                  onClick={addCustomHeader}
                  className="text-[10px] text-fuchsia-400 hover:text-fuchsia-300 flex items-center gap-1 transition-colors"
                >
                  <Plus size={10} /> Add
                </button>
              </div>
              {customHeaders.length === 0 && (
                <p className="text-[10px] text-purple-600">None</p>
              )}
              {customHeaders.map((h, i) => (
                <div key={i} className="flex gap-2 mb-1.5">
                  <input
                    type="text"
                    value={h.key}
                    onChange={e => updateCustomHeader(i, 'key', e.target.value)}
                    placeholder="Header"
                    className="w-2/5 bg-[#0d0520] border border-fuchsia-500/20 rounded px-2 py-1.5 text-xs text-white placeholder-purple-600 focus:outline-none focus:border-fuchsia-400/60"
                  />
                  <input
                    type="text"
                    value={h.value}
                    onChange={e => updateCustomHeader(i, 'value', e.target.value)}
                    placeholder="Value"
                    className="flex-1 bg-[#0d0520] border border-fuchsia-500/20 rounded px-2 py-1.5 text-xs text-white placeholder-purple-600 focus:outline-none focus:border-fuchsia-400/60"
                  />
                  <button
                    onClick={() => removeCustomHeader(i)}
                    className="text-red-400/60 hover:text-red-400 transition-colors px-1"
                    aria-label="Remove header"
                  ><Trash2 size={12} /></button>
                </div>
              ))}
            </div>

            {/* Payload note */}
            <div className="p-2.5 rounded-lg bg-sky-900/20 border border-sky-500/20">
              <p className="text-[10px] text-sky-300/80 leading-relaxed">
                Sends a <code className="bg-black/30 px-0.5 rounded">POST</code> (or chosen method) with JSON body:<br />
                <code className="bg-black/30 px-0.5 rounded">{'{'}projectName, files: {'{'}path: content{'}'}, deployedAt{'}'}</code>
              </p>
            </div>
          </div>
        )}
          </> // end !selectedConn manual form
        )}

        {/* Manage link when no saved connections exist */}
        {connections.length === 0 && onManageConnections && (
          <div className="mb-4 text-center">
            <button onClick={onManageConnections} className="text-[10px] text-fuchsia-400/70 hover:text-fuchsia-300 flex items-center gap-1 mx-auto transition-colors">
              <Settings size={10} /> Save a connection to skip token entry next time
            </button>
          </div>
        )}

        {/* Progress bar */}
        {progress && (
          <div className="mb-4">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-purple-300 truncate">{progress.message}</span>
              <span className="text-fuchsia-400 ml-2 shrink-0">{progress.percent}%</span>
            </div>
            <div className="h-1.5 bg-[#0d0520] rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-fuchsia-600 to-purple-400 transition-all duration-300 rounded-full"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}

        {/* Result */}
        {result && (
          <div className={`mb-4 p-3 rounded-lg flex items-start gap-2 ${
            result.error
              ? 'bg-red-900/20 border border-red-500/20'
              : 'bg-emerald-900/20 border border-emerald-500/20'
          }`}>
            {result.error ? (
              <>
                <AlertCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
                <p className="text-xs text-red-300 break-all">{result.error}</p>
              </>
            ) : (
              <>
                <CheckCircle2 size={14} className="text-emerald-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-emerald-300 mb-1">Deployed successfully!</p>
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-fuchsia-300 hover:text-fuchsia-200 underline break-all"
                  >
                    {result.url}
                  </a>
                </div>
              </>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-purple-400 hover:text-white border border-fuchsia-500/20 rounded-lg transition-colors"
          >
            {result?.url ? 'Close' : 'Cancel'}
          </button>
          <button
            onClick={handleDeploy}
            disabled={isDeploying}
            className="px-5 py-2 text-xs font-semibold bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-1.5"
          >
            {isDeploying
              ? <><Loader2 size={12} className="animate-spin" /> Deploying…</>
              : <><Rocket size={12} /> Deploy</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}
