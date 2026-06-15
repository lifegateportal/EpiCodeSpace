import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import FileExplorer from '../components/FileExplorer.jsx';

// Amendment #7 — integration coverage for the Explorer. Verifies tree
// construction, keyboard navigation, rename/delete flows, and filter.

const baseFiles = {
  'index.html': { name: 'index.html', language: 'html', content: '<html></html>' },
  'src/App.jsx': { name: 'App.jsx', language: 'javascript', content: 'x' },
  'src/components/Button.jsx': { name: 'Button.jsx', language: 'javascript', content: 'y' },
};

function setup(overrides = {}) {
  const props = {
    fileSystem: baseFiles,
    activeFile: 'index.html',
    projectName: 'demo',
    onFileClick: vi.fn(),
    onCreateFile: vi.fn(),
    onDeleteFile: vi.fn(),
    onRenameFile: vi.fn(),
    onMoveFile: vi.fn(),
    onProjectRename: vi.fn(),
    onImport: vi.fn(),
    onExport: vi.fn(),
    onNewProjectTemplate: vi.fn(),
    ...overrides,
  };
  const utils = render(<FileExplorer {...props} />);
  return { ...utils, props };
}

beforeEach(() => {
  localStorage.clear();
  // jsdom does not implement confirm; stub so deletes resolve to "yes"
  vi.stubGlobal('confirm', () => true);
});

describe('FileExplorer', () => {
  it('renders a tree with root files and nested folders', () => {
    setup();
    expect(screen.getByRole('tree', { name: /workspace files/i })).toBeInTheDocument();
    expect(screen.getByText('index.html')).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
  });

  it('calls onFileClick when a file row is clicked', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.click(screen.getByText('index.html'));
    expect(props.onFileClick).toHaveBeenCalledWith('index.html');
  });

  it('filters files using the search input', async () => {
    const user = userEvent.setup();
    setup();
    const search = screen.getByRole('searchbox', { name: /filter files/i });
    await user.type(search, 'Button');
    // "Button.jsx" should be visible; "index.html" should be pruned out
    expect(screen.getByText('Button.jsx')).toBeInTheDocument();
    expect(screen.queryByText('index.html')).not.toBeInTheDocument();
  });

  it('invokes onDeleteFile from the row delete button', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    const row = screen.getByText('index.html').closest('[role="treeitem"]');
    // Hover-only controls are visible in jsdom regardless of :hover state since
    // opacity is controlled via utility classes, not :hover media queries.
    const delBtn = within(row).getByRole('button', { name: /delete index\.html/i });
    await user.click(delBtn);
    expect(props.onDeleteFile).toHaveBeenCalledWith('index.html');
  });

  it('starts rename when F2 is pressed', async () => {
    const user = userEvent.setup();
    setup();
    const tree = screen.getByRole('tree');
    tree.focus();
    // Select index.html first (already active per props, but force key path)
    await user.click(screen.getByText('index.html'));
    fireEvent.keyDown(tree, { key: 'F2' });
    expect(await screen.findByRole('textbox', { name: /rename index\.html/i })).toBeInTheDocument();
  });

  it('shows empty state when there are no files', () => {
    setup({ fileSystem: {}, activeFile: null });
    expect(screen.getByText(/no files yet/i)).toBeInTheDocument();
  });
});
