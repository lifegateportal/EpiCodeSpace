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

function langFromPath(path) {
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
  'lock',
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

  const MAX_FILES = 300;
  const subset = blobs.slice(0, MAX_FILES);
  if (blobs.length > MAX_FILES) {
    onProgress?.(`Repo has ${blobs.length} files; capping at ${MAX_FILES} to stay within limits.`);
  }

  onProgress?.(`Fetching ${subset.length} files…`);

  const BATCH = 8;
  const files = {};
  let done = 0;

  for (let i = 0; i < subset.length; i += BATCH) {
    const chunk = subset.slice(i, i + BATCH);
    await Promise.all(chunk.map(async item => {
      try {
        const data = await ghFetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}?ref=${defaultBranch}`,
          token
        );
        const content = typeof data.content === 'string'
          ? atob(data.content.replace(/\n/g, ''))
          : '';
        files[item.path] = {
          name: item.path.split('/').pop(),
          language: langFromPath(item.path),
          content,
        };
      } catch {
        // skip files that fail (e.g. submodules, encoding issues)
      }
      done++;
      if (done % 20 === 0 || done === subset.length) {
        onProgress?.(`Fetched ${done}/${subset.length} files…`);
      }
    }));
  }

  return { files, repoName, branch: defaultBranch, owner, repo };
}
