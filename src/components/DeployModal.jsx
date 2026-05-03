import React, { useState, useCallback } from 'react';
import { X, Eye, EyeOff, Rocket, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

const TOKEN_KEYS = {
  netlify: 'epicodespace_deploy_netlify_token',
  vercel:  'epicodespace_deploy_vercel_token',
  github:  'epicodespace_deploy_github_token',
};
const NETLIFY_SITE_KEY = 'epicodespace_deploy_netlify_site_';
const GITHUB_REPO_KEY  = 'epicodespace_deploy_github_repo';

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

// ─── Component ────────────────────────────────────────────────────────────────
const PLATFORMS = [
  { id: 'netlify', label: 'Netlify' },
  { id: 'vercel',  label: 'Vercel'  },
  { id: 'github',  label: 'GitHub'  },
];

export default function DeployModal({ projectName, fileSystem, onClose }) {
  const [platform, setPlatform] = useState('netlify');
  const [showToken, setShowToken] = useState(false);

  const [netlifyToken,    setNetlifyToken]    = useState(() => localStorage.getItem(TOKEN_KEYS.netlify) || '');
  const [netlifySite,     setNetlifySite]     = useState('');
  const [vercelToken,     setVercelToken]     = useState(() => localStorage.getItem(TOKEN_KEYS.vercel)  || '');
  const [githubToken,     setGithubToken]     = useState(() => localStorage.getItem(TOKEN_KEYS.github)  || '');
  const [githubRepo,      setGithubRepo]      = useState(() => localStorage.getItem(GITHUB_REPO_KEY)    || '');

  const [progress, setProgress] = useState(null); // { message, percent }
  const [result,   setResult]   = useState(null); // { url } | { error }

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

      if (platform === 'netlify') {
        if (!netlifyToken.trim()) throw new Error('Netlify token is required');
        localStorage.setItem(TOKEN_KEYS.netlify, netlifyToken.trim());
        res = await deployNetlify({ token: netlifyToken.trim(), siteName: netlifySite.trim(), projectName, files: fileSystem, onProgress });

      } else if (platform === 'vercel') {
        if (!vercelToken.trim()) throw new Error('Vercel token is required');
        localStorage.setItem(TOKEN_KEYS.vercel, vercelToken.trim());
        res = await deployVercel({ token: vercelToken.trim(), projectName, files: fileSystem, onProgress });

      } else {
        if (!githubToken.trim()) throw new Error('GitHub token is required');
        if (!githubRepo.trim())  throw new Error('Repository is required (owner/repo-name)');
        localStorage.setItem(TOKEN_KEYS.github, githubToken.trim());
        localStorage.setItem(GITHUB_REPO_KEY, githubRepo.trim());
        res = await deployGitHub({ token: githubToken.trim(), repo: githubRepo.trim(), files: fileSystem, onProgress });
      }

      setProgress({ message: 'Done!', percent: 100 });
      setResult({ url: res.url });
    } catch (err) {
      setProgress(null);
      setResult({ error: err.message });
    }
  }, [platform, netlifyToken, netlifySite, vercelToken, githubToken, githubRepo, projectName, fileSystem]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="deploy-title"
    >
      <div
        className="bg-[#15092a] border border-fuchsia-500/30 rounded-xl shadow-[0_0_40px_rgba(192,38,211,0.25)] p-6 w-[440px] max-w-[95vw]"
        onClick={e => e.stopPropagation()}
      >
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

        {/* Token input */}
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
