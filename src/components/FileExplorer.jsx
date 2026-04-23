import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  ChevronDown, ChevronRight, Folder, FolderOpen, File as FileIcon,
  FilePlus, FolderPlus, FileEdit, Trash2, Copy, Scissors, ClipboardPaste,
  Search, X, RefreshCw, Save, FolderOpen as FolderOpenIcon,
} from 'lucide-react';

/* ── Tree builder: converts flat {path: file} map into a nested tree ───────── */
function buildTree(fileSystem, emptyFolders) {
  const root = { name: '', path: '', type: 'folder', children: {} };
  const ensureDir = (segments) => {
    let node = root;
    let curPath = '';
    for (const seg of segments) {
      curPath = curPath ? `${curPath}/${seg}` : seg;
      if (!node.children[seg]) {
        node.children[seg] = { name: seg, path: curPath, type: 'folder', children: {} };
      }
      node = node.children[seg];
    }
    return node;
  };
  // Files
  Object.keys(fileSystem).forEach(path => {
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    const parent = parts.length ? ensureDir(parts) : root;
    parent.children[fileName] = { name: fileName, path, type: 'file' };
  });
  // Empty folders
  (emptyFolders || []).forEach(folderPath => {
    const parts = folderPath.split('/').filter(Boolean);
    ensureDir(parts);
  });
  // Convert children objects to sorted arrays (folders first, then files)
  const toArray = (node) => {
    if (node.type !== 'folder') return node;
    const entries = Object.values(node.children).map(toArray);
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ...node, children: entries };
  };
  return toArray(root);
}

/* ── Extension → icon color ──────────────────────────────────────────────── */
function iconColorForName(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return 'text-yellow-400';
    case 'jsx': return 'text-cyan-400';
    case 'ts': return 'text-sky-400';
    case 'tsx': return 'text-cyan-300';
    case 'css': case 'scss': return 'text-pink-400';
    case 'html': return 'text-orange-400';
    case 'json': return 'text-amber-300';
    case 'md': return 'text-cyan-300';
    case 'py': return 'text-green-400';
    case 'svg': case 'png': case 'jpg': case 'jpeg': case 'gif': return 'text-purple-300';
    default: return 'text-fuchsia-400/70';
  }
}

/* ── Visible-node flattening for keyboard navigation ─────────────────────── */
function flattenVisible(node, expanded, depth = 0, out = []) {
  if (node.type === 'folder') {
    if (depth > 0) out.push({ ...node, depth });
    const isOpen = depth === 0 ? true : !!expanded[node.path];
    if (isOpen) node.children.forEach(c => flattenVisible(c, expanded, depth + 1, out));
  } else {
    out.push({ ...node, depth });
  }
  return out;
}

const EXPAND_KEY = 'epicodespace_explorer_expanded_v1';
const FOLDERS_KEY = 'epicodespace_empty_folders_v1';

export default function FileExplorer({
  fileSystem,
  activeFile,
  projectName,
  onFileClick,
  onCreateFile,     // (path: string) => void
  onDeleteFile,     // (path: string) => void
  onRenameFile,     // (oldPath, newPath) => void
  onMoveFile,       // (oldPath, newPath) => void  (drag & drop)
  onDropFiles,      // (files: FileList|File[], folderPath: string) => void
  onProjectRename,  // (name: string) => void
  onImport,
  onExport,
  onNewProjectTemplate, // (template: string) => void
  className = '',
}) {
  /* ── Persisted state ─────────────────────────────────────────────────── */
  const [expanded, setExpanded] = useState(() => {
    try { return JSON.parse(localStorage.getItem(EXPAND_KEY) || '{}'); } catch { return {}; }
  });
  const [emptyFolders, setEmptyFolders] = useState(() => {
    try { return JSON.parse(localStorage.getItem(FOLDERS_KEY) || '[]'); } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem(EXPAND_KEY, JSON.stringify(expanded)); } catch {} }, [expanded]);
  useEffect(() => { try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(emptyFolders)); } catch {} }, [emptyFolders]);

  /* ── Local UI state ──────────────────────────────────────────────────── */
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState(null);   // path being renamed
  const [renameValue, setRenameValue] = useState('');
  const [creating, setCreating] = useState(null);   // { parentPath, type: 'file'|'folder' }
  const [createValue, setCreateValue] = useState('');
  const [selected, setSelected] = useState(activeFile);
  const [ctxMenu, setCtxMenu] = useState(null);     // { x, y, node }
  const [dragOver, setDragOver] = useState(null);   // folder path currently being hovered during drag
  const [clipboard, setClipboard] = useState(null); // { op: 'cut'|'copy', path }
  const treeRef = useRef(null);

  const tree = useMemo(() => buildTree(fileSystem, emptyFolders), [fileSystem, emptyFolders]);

  /* ── Filter: collect paths matching query, auto-expand their ancestors ─ */
  const filteredTree = useMemo(() => {
    if (!filter.trim()) return tree;
    const q = filter.toLowerCase();
    const matchPaths = new Set();
    Object.keys(fileSystem).forEach(p => {
      if (p.toLowerCase().includes(q)) {
        matchPaths.add(p);
        const parts = p.split('/'); parts.pop();
        let cur = '';
        parts.forEach(seg => { cur = cur ? `${cur}/${seg}` : seg; matchPaths.add(cur); });
      }
    });
    const prune = (node) => {
      if (node.type === 'file') return matchPaths.has(node.path) ? node : null;
      const kids = node.children.map(prune).filter(Boolean);
      if (kids.length === 0 && !matchPaths.has(node.path) && node.path !== '') return null;
      return { ...node, children: kids };
    };
    return prune(tree) || { ...tree, children: [] };
  }, [tree, filter, fileSystem]);

  /* ── When filtering, force-expand matching folders ───────────────────── */
  const effectiveExpanded = useMemo(() => {
    if (!filter.trim()) return expanded;
    const merged = { ...expanded };
    const walk = (node) => { if (node.type === 'folder' && node.path) { merged[node.path] = true; node.children.forEach(walk); } };
    filteredTree.children.forEach(walk);
    return merged;
  }, [filter, expanded, filteredTree]);

  const visibleNodes = useMemo(() => flattenVisible(filteredTree, effectiveExpanded), [filteredTree, effectiveExpanded]);

  useEffect(() => { setSelected(activeFile); }, [activeFile]);

  /* ── Global listeners to close context menu ──────────────────────────── */
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') setCtxMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [ctxMenu]);

  /* ── Folder toggle ───────────────────────────────────────────────────── */
  const toggleFolder = useCallback((path) => {
    setExpanded(prev => ({ ...prev, [path]: !prev[path] }));
  }, []);

  /* ── Actions ─────────────────────────────────────────────────────────── */
  const startCreate = (parentPath, type) => {
    if (parentPath) setExpanded(prev => ({ ...prev, [parentPath]: true }));
    setCreating({ parentPath, type });
    setCreateValue('');
  };

  const commitCreate = () => {
    if (!creating) return;
    const name = createValue.trim();
    if (!name) { setCreating(null); return; }
    if (!/^[A-Za-z0-9._\- ]+$/.test(name)) {
      // Reject path separators and risky chars
      setCreating(null); return;
    }
    const fullPath = creating.parentPath ? `${creating.parentPath}/${name}` : name;
    if (creating.type === 'file') {
      if (!fileSystem[fullPath]) onCreateFile?.(fullPath);
    } else {
      setEmptyFolders(prev => prev.includes(fullPath) ? prev : [...prev, fullPath]);
      setExpanded(prev => ({ ...prev, [fullPath]: true }));
    }
    setCreating(null);
    setCreateValue('');
  };

  const commitRename = (oldPath) => {
    const trimmed = renameValue.trim();
    setRenaming(null);
    if (!trimmed || trimmed === oldPath.split('/').pop()) return;
    if (!/^[A-Za-z0-9._\- ]+$/.test(trimmed)) return;
    const parts = oldPath.split('/');
    parts[parts.length - 1] = trimmed;
    const newPath = parts.join('/');
    if (newPath === oldPath) return;
    if (fileSystem[oldPath]) onRenameFile?.(oldPath, newPath);
  };

  const deleteNode = (node) => {
    if (!window.confirm(`Delete ${node.type === 'folder' ? 'folder' : 'file'} "${node.path}"?`)) return;
    if (node.type === 'file') {
      onDeleteFile?.(node.path);
    } else {
      // Delete all files under this folder + remove from emptyFolders
      Object.keys(fileSystem).forEach(p => { if (p === node.path || p.startsWith(node.path + '/')) onDeleteFile?.(p); });
      setEmptyFolders(prev => prev.filter(f => f !== node.path && !f.startsWith(node.path + '/')));
    }
  };

  const duplicateFile = (path) => {
    const f = fileSystem[path]; if (!f) return;
    const parts = path.split('.'); const ext = parts.length > 1 ? '.' + parts.pop() : '';
    const base = parts.join('.');
    let copyPath = `${base}.copy${ext}`; let i = 1;
    while (fileSystem[copyPath]) { i++; copyPath = `${base}.copy${i}${ext}`; }
    onCreateFile?.(copyPath, f.content, f.language);
  };

  const copyPath = (path) => { navigator.clipboard?.writeText(path).catch(() => {}); };

  /* ── Keyboard navigation on tree ─────────────────────────────────────── */
  const onTreeKeyDown = useCallback((e) => {
    if (renaming || creating) return;
    const idx = visibleNodes.findIndex(n => n.path === selected);
    const cur = visibleNodes[idx];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelected(visibleNodes[Math.min(visibleNodes.length - 1, Math.max(0, idx + 1))]?.path ?? selected);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelected(visibleNodes[Math.max(0, idx - 1)]?.path ?? selected);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (cur?.type === 'folder' && !effectiveExpanded[cur.path]) toggleFolder(cur.path);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (cur?.type === 'folder' && effectiveExpanded[cur.path]) toggleFolder(cur.path);
        else if (cur) {
          // Jump to parent
          const parentPath = cur.path.split('/').slice(0, -1).join('/');
          if (parentPath) setSelected(parentPath);
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (cur?.type === 'file') onFileClick?.(cur.path);
        else if (cur?.type === 'folder') toggleFolder(cur.path);
        break;
      case 'F2':
        if (cur) { e.preventDefault(); setRenaming(cur.path); setRenameValue(cur.name); }
        break;
      case 'Delete':
      case 'Backspace':
        if (cur && e.metaKey === false) { e.preventDefault(); deleteNode(cur); }
        break;
      default: break;
    }
  }, [visibleNodes, selected, effectiveExpanded, renaming, creating, toggleFolder, onFileClick]);

  /* ── Drag & drop ─────────────────────────────────────────────────────── */
  const onDragStart = (e, node) => {
    if (node.type !== 'file') return;
    e.dataTransfer.setData('text/path', node.path);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDropFolder = (e, folderPath) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);

    const droppedFiles = e.dataTransfer?.files;
    if (droppedFiles && droppedFiles.length > 0) {
      onDropFiles?.(droppedFiles, folderPath || '');
      return;
    }

    const src = e.dataTransfer.getData('text/path');
    if (!src) return;
    const fileName = src.split('/').pop();
    const dst = folderPath ? `${folderPath}/${fileName}` : fileName;
    if (dst === src || fileSystem[dst]) return;
    onMoveFile?.(src, dst);
  };

  /* ── Render a single tree row ────────────────────────────────────────── */
  const renderNode = (node) => {
    const isFolder = node.type === 'folder';
    const isOpen = isFolder && !!effectiveExpanded[node.path];
    const isActive = !isFolder && node.path === activeFile;
    const isSelected = node.path === selected;
    const isRenaming = renaming === node.path;
    const indent = 8 + node.depth * 12;

    return (
      <div
        key={node.path}
        role="treeitem"
        aria-level={node.depth}
        aria-selected={isSelected}
        aria-expanded={isFolder ? isOpen : undefined}
        data-path={node.path}
        draggable={!isFolder && !isRenaming}
        onDragStart={(e) => onDragStart(e, node)}
        onDragOver={isFolder ? (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = e.dataTransfer?.files?.length ? 'copy' : 'move';
          setDragOver(node.path);
        } : undefined}
        onDragLeave={isFolder ? () => setDragOver(prev => prev === node.path ? null : prev) : undefined}
        onDrop={isFolder ? (e) => onDropFolder(e, node.path) : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setSelected(node.path);
          if (isFolder) toggleFolder(node.path);
          else onFileClick?.(node.path);
        }}
        onDoubleClick={(e) => { if (!isFolder) { e.stopPropagation(); setRenaming(node.path); setRenameValue(node.name); } }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setSelected(node.path);
          setCtxMenu({ x: e.clientX, y: e.clientY, node });
        }}
        className={`group flex items-center gap-1 py-1 pr-1 text-xs rounded cursor-pointer select-none transition-colors
          ${isActive ? 'bg-fuchsia-500/15 text-fuchsia-100 shadow-[inset_2px_0_0_rgba(232,121,249,1)]'
           : isSelected ? 'bg-[#25104a] text-purple-100'
           : 'text-purple-300 hover:bg-[#25104a]/70 hover:text-purple-100'}
          ${dragOver === node.path ? 'outline outline-1 outline-fuchsia-400/60 bg-fuchsia-500/10' : ''}`}
        style={{ paddingLeft: indent }}
      >
        {isFolder ? (
          <span className="flex items-center shrink-0">
            {isOpen ? <ChevronDown size={12} className="text-purple-400/60" /> : <ChevronRight size={12} className="text-purple-400/60" />}
            {isOpen ? <FolderOpen size={13} className="text-fuchsia-400 ml-0.5" /> : <Folder size={13} className="text-fuchsia-400 ml-0.5" />}
          </span>
        ) : (
          <span className="flex items-center shrink-0 ml-3">
            <FileIcon size={12} className={iconColorForName(node.name)} />
          </span>
        )}
        {isRenaming ? (
          <form onSubmit={(e) => { e.preventDefault(); commitRename(node.path); }} className="flex-1 flex">
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => commitRename(node.path)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setRenaming(null); } }}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Rename ${node.name}`}
              className="flex-1 bg-[#0a0412] border border-fuchsia-500/40 text-purple-100 text-xs px-1.5 py-0.5 rounded outline-none"
            />
          </form>
        ) : (
          <span className="flex-1 truncate">{node.name}</span>
        )}
        {!isRenaming && (
          <span className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            {isFolder && (
              <>
                <button aria-label={`New file in ${node.path}`} title="New file" onClick={(e) => { e.stopPropagation(); startCreate(node.path, 'file'); }} className="p-0.5 text-purple-500/50 hover:text-fuchsia-300"><FilePlus size={11}/></button>
                <button aria-label={`New folder in ${node.path}`} title="New folder" onClick={(e) => { e.stopPropagation(); startCreate(node.path, 'folder'); }} className="p-0.5 text-purple-500/50 hover:text-fuchsia-300"><FolderPlus size={11}/></button>
              </>
            )}
            <button aria-label={`Rename ${node.path}`} title="Rename (F2)" onClick={(e) => { e.stopPropagation(); setRenaming(node.path); setRenameValue(node.name); }} className="p-0.5 text-purple-500/50 hover:text-purple-200"><FileEdit size={11}/></button>
            <button aria-label={`Delete ${node.path}`} title="Delete" onClick={(e) => { e.stopPropagation(); deleteNode(node); }} className="p-0.5 text-purple-500/50 hover:text-red-400"><Trash2 size={11}/></button>
          </span>
        )}
      </div>
    );
  };

  /* ── Render the inline "new file/folder" input row under its parent ──── */
  const renderCreateRow = (parentPath, depth) => {
    if (!creating || creating.parentPath !== parentPath) return null;
    const indent = 8 + (depth + 1) * 12;
    return (
      <form
        onSubmit={(e) => { e.preventDefault(); commitCreate(); }}
        style={{ paddingLeft: indent }}
        className="flex items-center gap-1 py-1"
      >
        {creating.type === 'folder'
          ? <Folder size={13} className="text-fuchsia-400 shrink-0" />
          : <FileIcon size={12} className="text-fuchsia-400/60 shrink-0 ml-3" />}
        <input
          autoFocus
          value={createValue}
          onChange={(e) => setCreateValue(e.target.value)}
          onBlur={commitCreate}
          onKeyDown={(e) => { if (e.key === 'Escape') { setCreating(null); setCreateValue(''); } }}
          placeholder={creating.type === 'folder' ? 'folder-name' : 'filename.ext'}
          aria-label={creating.type === 'folder' ? 'New folder name' : 'New file name'}
          className="flex-1 bg-[#0a0412] border border-fuchsia-500/40 text-purple-100 text-xs px-1.5 py-0.5 rounded outline-none"
        />
      </form>
    );
  };

  /* ── Recursive render preserving create-row insertion positions ─────── */
  const renderTree = (node) => {
    if (node.type === 'file') return renderNode(node);
    const isRoot = node.path === '';
    const isOpen = isRoot ? true : !!effectiveExpanded[node.path];
    return (
      <React.Fragment key={node.path || '__root__'}>
        {!isRoot && renderNode(node)}
        {isOpen && (
          <>
            {node.children.map(renderTree)}
            {renderCreateRow(node.path, node.depth || (isRoot ? -1 : 0))}
          </>
        )}
      </React.Fragment>
    );
  };

  // Add depth info to nodes recursively for create-row indentation
  const withDepth = (node, depth = 0) => {
    if (node.type !== 'folder') return { ...node, depth };
    return { ...node, depth, children: node.children.map(c => withDepth(c, depth + 1)) };
  };
  const enrichedTree = useMemo(() => withDepth(filteredTree, 0), [filteredTree]);

  const fileCount = Object.keys(fileSystem).length;

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Header */}
      <div className="px-4 py-2.5 flex justify-between items-center text-[10px] font-bold text-fuchsia-400/70 uppercase tracking-widest shrink-0">
        <span>Explorer</span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => startCreate('', 'file')} aria-label="New file at root" title="New File" className="p-1 hover:text-fuchsia-300 transition-colors"><FilePlus size={13}/></button>
          <button onClick={() => startCreate('', 'folder')} aria-label="New folder at root" title="New Folder" className="p-1 hover:text-fuchsia-300 transition-colors"><FolderPlus size={13}/></button>
          <button onClick={() => setExpanded({})} aria-label="Collapse all folders" title="Collapse All" className="p-1 hover:text-fuchsia-300 transition-colors"><RefreshCw size={13}/></button>
          <button onClick={onImport} aria-label="Import project" title="Import Project" className="p-1 hover:text-fuchsia-300 transition-colors"><FolderOpenIcon size={13}/></button>
          <button onClick={onExport} aria-label="Export project" title="Export Project" className="p-1 hover:text-fuchsia-300 transition-colors"><Save size={13}/></button>
        </div>
      </div>

      {/* Search / filter */}
      {fileCount > 0 && (
        <div className="px-2 pb-2 shrink-0">
          <div className="flex items-center gap-2 bg-[#1a0b35] border border-fuchsia-500/20 rounded-md px-2 py-1">
            <Search size={11} className="text-purple-500/60 shrink-0" aria-hidden="true"/>
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files..."
              aria-label="Filter files"
              className="flex-1 bg-transparent text-[11px] text-purple-100 outline-none placeholder:text-purple-500/40"
            />
            {filter && (
              <button onClick={() => setFilter('')} aria-label="Clear filter" className="text-purple-500/60 hover:text-purple-300"><X size={10}/></button>
            )}
          </div>
        </div>
      )}

      {/* Project label */}
      <div className="px-2 py-1 flex items-center gap-1 text-xs font-semibold text-purple-200 mb-1 shrink-0">
        <ChevronDown size={14} />
        <span
          className="tracking-wide uppercase truncate cursor-pointer"
          title={`${projectName} — double-click to rename`}
          onDoubleClick={() => { const name = prompt('Rename project:', projectName); if (name) onProjectRename?.(name); }}
        >
          {projectName}
        </span>
      </div>

      {/* Tree */}
      <div
        ref={treeRef}
        role="tree"
        aria-label="Workspace files"
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = e.dataTransfer?.files?.length ? 'copy' : 'move';
          setDragOver('');
        }}
        onDrop={(e) => onDropFolder(e, '')}
        className="flex-1 overflow-y-auto px-1 pb-2 focus:outline-none focus:ring-1 focus:ring-fuchsia-500/40 rounded"
      >
        {fileCount === 0 && emptyFolders.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <div className="text-purple-500/50 text-xs mb-4">No files yet</div>
            <div className="space-y-2">
              <button onClick={() => startCreate('', 'file')} className="w-full text-[11px] text-purple-300 hover:text-purple-100 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-2 transition-colors flex items-center gap-2 justify-center"><FilePlus size={12}/> New File</button>
              <button onClick={() => onNewProjectTemplate?.('react')} className="w-full text-[11px] text-purple-300 hover:text-purple-100 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-2 transition-colors">⚛️ React Project</button>
              <button onClick={() => onNewProjectTemplate?.('node')} className="w-full text-[11px] text-purple-300 hover:text-purple-100 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-2 transition-colors">🟢 Node.js Project</button>
              <button onClick={() => onNewProjectTemplate?.('html')} className="w-full text-[11px] text-purple-300 hover:text-purple-100 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-2 transition-colors">🌐 HTML/CSS/JS Project</button>
              <button onClick={onImport} className="w-full text-[11px] text-purple-300 hover:text-purple-100 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-2 transition-colors flex items-center gap-2 justify-center"><FolderOpenIcon size={12}/> Import Project</button>
            </div>
          </div>
        ) : (
          <>
            {enrichedTree.children.map(renderTree)}
            {renderCreateRow('', -1)}
            {filter && visibleNodes.length === 0 && (
              <div className="px-4 py-4 text-center text-[11px] text-purple-500/50">No files match "{filter}"</div>
            )}
          </>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          role="menu"
          className="fixed z-[300] min-w-[200px] bg-[#1a0b35] border border-fuchsia-500/30 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.7)] py-1 text-xs"
          style={{ left: Math.min(ctxMenu.x, window.innerWidth - 220), top: Math.min(ctxMenu.y, window.innerHeight - 300) }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.node.type === 'folder' && (
            <>
              <MenuItem icon={FilePlus} label="New File" onClick={() => { startCreate(ctxMenu.node.path, 'file'); setCtxMenu(null); }} />
              <MenuItem icon={FolderPlus} label="New Folder" onClick={() => { startCreate(ctxMenu.node.path, 'folder'); setCtxMenu(null); }} />
              <Separator />
            </>
          )}
          {ctxMenu.node.type === 'file' && (
            <>
              <MenuItem icon={FileIcon} label="Open" onClick={() => { onFileClick?.(ctxMenu.node.path); setCtxMenu(null); }} />
              <MenuItem icon={Copy} label="Duplicate" onClick={() => { duplicateFile(ctxMenu.node.path); setCtxMenu(null); }} />
              <Separator />
              <MenuItem icon={Scissors} label="Cut" onClick={() => { setClipboard({ op: 'cut', path: ctxMenu.node.path }); setCtxMenu(null); }} />
              <MenuItem icon={Copy} label="Copy" onClick={() => { setClipboard({ op: 'copy', path: ctxMenu.node.path }); setCtxMenu(null); }} />
            </>
          )}
          {clipboard && ctxMenu.node.type === 'folder' && (
            <MenuItem icon={ClipboardPaste} label={`Paste ${clipboard.path.split('/').pop()}`} onClick={() => {
              const name = clipboard.path.split('/').pop();
              const dst = ctxMenu.node.path ? `${ctxMenu.node.path}/${name}` : name;
              if (!fileSystem[dst] && dst !== clipboard.path) {
                if (clipboard.op === 'cut') onMoveFile?.(clipboard.path, dst);
                else { const f = fileSystem[clipboard.path]; if (f) onCreateFile?.(dst, f.content, f.language); }
              }
              setClipboard(null); setCtxMenu(null);
            }} />
          )}
          <Separator />
          <MenuItem icon={FileEdit} label="Rename" shortcut="F2" onClick={() => { setRenaming(ctxMenu.node.path); setRenameValue(ctxMenu.node.name); setCtxMenu(null); }} />
          <MenuItem icon={Copy} label="Copy Path" onClick={() => { copyPath(ctxMenu.node.path); setCtxMenu(null); }} />
          <Separator />
          <MenuItem icon={Trash2} label="Delete" shortcut="Del" danger onClick={() => { deleteNode(ctxMenu.node); setCtxMenu(null); }} />
        </div>
      )}
    </div>
  );
}

/* ── Context-menu helpers ───────────────────────────────────────────────── */
function MenuItem({ icon: Icon, label, shortcut, onClick, danger }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-1.5 transition-colors ${danger ? 'text-red-300 hover:bg-red-500/15' : 'text-purple-200 hover:bg-fuchsia-500/15 hover:text-purple-50'}`}
    >
      <span className="flex items-center gap-2.5">
        {Icon ? <Icon size={12} className={danger ? 'text-red-400' : 'text-fuchsia-400/70'} /> : <span className="w-3" />}
        {label}
      </span>
      {shortcut && <span className="text-[10px] text-purple-500/55 ml-4 font-mono">{shortcut}</span>}
    </button>
  );
}
function Separator() { return <div className="my-1 border-t border-fuchsia-500/15" />; }
