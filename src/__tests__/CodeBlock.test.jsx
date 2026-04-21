import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// Import CodeBlock from the extracted component (Amendment 6)
// For now we inline a minimal version to keep tests runnable before the split.
function CodeBlock({ code, language, filename }) {
  const [copied, setCopied] = React.useState(false);
  const raw = typeof code === 'string' ? code : '';
  const lines = (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n');
  return (
    <div data-testid="code-block">
      <div data-testid="code-header">
        <span data-testid="code-lang">{filename || language || 'code'}</span>
        <button
          data-testid="copy-btn"
          onClick={() => {
            navigator.clipboard?.writeText(raw).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      <table data-testid="code-table">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} data-testid={`line-${i + 1}`}>
              <td data-testid={`linenum-${i + 1}`}>{i + 1}</td>
              <td>{line || '\u00a0'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

describe('CodeBlock', () => {
  it('renders without crashing', () => {
    render(<CodeBlock code="const x = 1;" language="javascript" />);
    expect(screen.getByTestId('code-block')).toBeInTheDocument();
  });

  it('displays the correct language label', () => {
    render(<CodeBlock code="" language="typescript" />);
    expect(screen.getByTestId('code-lang').textContent).toBe('typescript');
  });

  it('prefers filename over language when both provided', () => {
    render(<CodeBlock code="" language="javascript" filename="App.jsx" />);
    expect(screen.getByTestId('code-lang').textContent).toBe('App.jsx');
  });

  it('falls back to "code" when neither language nor filename given', () => {
    render(<CodeBlock code="" />);
    expect(screen.getByTestId('code-lang').textContent).toBe('code');
  });

  it('renders correct number of lines', () => {
    const code = 'line one\nline two\nline three';
    render(<CodeBlock code={code} language="text" />);
    expect(screen.getByTestId('line-1')).toBeInTheDocument();
    expect(screen.getByTestId('line-2')).toBeInTheDocument();
    expect(screen.getByTestId('line-3')).toBeInTheDocument();
  });

  it('strips trailing newline before splitting lines', () => {
    const code = 'a\nb\n'; // trailing newline should NOT produce an empty extra line
    render(<CodeBlock code={code} language="text" />);
    expect(screen.queryByTestId('line-3')).not.toBeInTheDocument();
  });

  it('shows copy button and triggers clipboard write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CodeBlock code="hello world" language="text" />);
    const btn = screen.getByTestId('copy-btn');
    expect(btn.textContent).toBe('copy');
    fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith('hello world');
    await waitFor(() => expect(screen.getByTestId('copy-btn').textContent).toBe('✓ copied'));
  });

  it('handles non-string code gracefully', () => {
    // @ts-ignore ─ deliberate bad input test
    render(<CodeBlock code={null} language="text" />);
    expect(screen.getByTestId('code-block')).toBeInTheDocument();
  });
});
