const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', cs: 'csharp',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'scss',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', env: 'ini',
  md: 'markdown', mdx: 'markdown', txt: 'plaintext',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  xml: 'xml', svg: 'xml', graphql: 'graphql', gql: 'graphql',
  sql: 'sql', php: 'php', dart: 'dart', lua: 'lua', r: 'r',
  vue: 'html', svelte: 'html',
};

function isEnvFile(path) {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  return base === '.env' || base.startsWith('.env.');
}

function langFromPath(path) {
  if (isEnvFile(path)) return 'ini';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] || 'plaintext';
}

function parseGitHubUrl(rawUrl) {
  try {
    const url = new URL(rawUrl.trim());
    if (url.hostname !== 'github.com') return null;
    const parts = url.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
    if (parts.length < 2) return null;
    const [owner, repo, , , ...rest] = parts;
    const branch = rest.length ? rest.join('/') : null;
    return { owner, repo, branch };
  } catch {
    const m = rawUrl.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (m) return { owner: m[1], repo: m[2], branch: null };
    return null;
  }
}

const BINARY_EXTS = new Set([
  'png','jpg','jpeg','gif','webp','ico','bmp','tiff','svg',
  'woff','woff2','ttf','eot','otf',
  'mp3','mp4','wav','ogg','webm','mov',
  'zip','tar','gz','7z','rar',
  'pdf','doc','docx','xls','xlsx',
  'exe','dll','so','dylib','wasm',
]);

function isBinary(path) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_EXTS.has(ext);
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', '__pycache__',
  '.cache', 'coverage', '.turbo', '.parcel-cache',
]);

function shouldSkip(path) {
  return path.split('/').some(seg => SKIP_DIRS.has(seg));
}

const PRIORITY_PATTERNS = [
  /^package\.json$/i,
  /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb)$/i,
  /^(tsconfig|jsconfig)\..+$/i,
  /^(vite|next|nuxt|webpack|rollup|astro|svelte|tailwind|postcss)\.config\..+$/i,
  /^(app|src)\/(main|index|app|layout)\.[jt]sx?$/i,
  /\.css$/i,
  /^\.env(\..+)?$/i,
  /^README(\.md)?$/i,
];

function priorityScore(path) {
  let score = 0;
  if (isEnvFile(path)) score += 50;
  if (/\.(css|scss|sass|less)$/i.test(path)) score += 40;
  if (path.startsWith('src/') || path.startsWith('app/')) score += 10;
  for (let i = 0; i < PRIORITY_PATTERNS.length; i += 1) {
    if (PRIORITY_PATTERNS[i].test(path)) {
      score += 200 - i * 15;
    }
  }
  return score;
}

function pickCloneSubset(blobs, maxFiles) {
  if (blobs.length <= maxFiles) return blobs;

  const ranked = blobs
    .map((item, index) => ({ item, score: priorityScore(item.path), index }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

  return ranked.slice(0, maxFiles).map((entry) => entry.item);
}

async function ghFetch(url, token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `GitHub API error: ${res.status}`);
  }
  return res.json();
}

export async function cloneRepo(rawUrl, { token, onProgress } = {}) {
  const parsed = parseGitHubUrl(rawUrl);
  if (!parsed) throw new Error('Invalid GitHub URL. Use: https://github.com/owner/repo');

  const { owner, repo, branch } = parsed;
  onProgress?.(`Fetching repo info for ${owner}/${repo}…`);

  const repoInfo = await ghFetch(`https://api.github.com/repos/${owner}/${repo}`, token);
  const defaultBranch = branch || repoInfo.default_branch;
  const repoName = repoInfo.name;

  onProgress?.(`Fetching file tree (${defaultBranch})…`);
  const treeData = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
    token
  );

  if (treeData.truncated) {
    onProgress?.('⚠️ Repository is very large — only a subset of files will be fetched.');
  }

  const blobs = treeData.tree.filter(
    item => item.type === 'blob' && !isBinary(item.path) && !shouldSkip(item.path)
  );

  const MAX_FILES = 1200;
  const subset = pickCloneSubset(blobs, MAX_FILES);
  if (blobs.length > MAX_FILES) {
    onProgress?.(`Repo has ${blobs.length} files; importing a prioritized ${MAX_FILES}-file subset (entrypoints, CSS, env, and build configs first).`);
  }

  onProgress?.(`Fetching ${subset.length} files…`);

  const BATCH = 8;
  const files = {};
  const failed = [];
  let done = 0;

  async function fetchOne(item) {
    // Use raw.githubusercontent.com for file content — it has no per-hour API
    // rate limit for public repos, so a 300-file clone won't exhaust the quota.
    // Only the two tree/repo-info calls above need the authenticated API.
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${item.path}`;
    const rawHeaders = {};
    if (token) rawHeaders.Authorization = `Bearer ${token}`;
    const res = await fetch(rawUrl, { headers: rawHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${item.path}`);
    const content = await res.text();
    files[item.path] = {
      name: item.path.split('/').pop(),
      language: langFromPath(item.path),
      content,
    };
  }

  for (let i = 0; i < subset.length; i += BATCH) {
    const chunk = subset.slice(i, i + BATCH);
    await Promise.all(chunk.map(async item => {
      try {
        await fetchOne(item);
      } catch {
        // First attempt failed — retry once after a short delay.
        await new Promise(r => setTimeout(r, 600));
        try {
          await fetchOne(item);
        } catch (err2) {
          failed.push(item.path);
        }
      }
      done++;
      if (done % 20 === 0 || done === subset.length) {
        onProgress?.(`Fetched ${done}/${subset.length} files…`);
      }
    }));
  }

  if (failed.length > 0) {
    onProgress?.(`⚠️ ${failed.length} file(s) could not be fetched (rate limit or network): ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`);
  }

  return { files, repoName, branch: defaultBranch, owner, repo, failed };
}
