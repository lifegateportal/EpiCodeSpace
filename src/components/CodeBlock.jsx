import React, { useState } from 'react';

/**
 * Renders a syntax-highlighted code block with per-row line numbers and a copy button.
 *
 * @param {{ code: string; language?: string; filename?: string }} props
 */
export default function CodeBlock({ code, language, filename }) {
  const [copied, setCopied] = useState(false);
  const raw = typeof code === 'string' ? code : '';
  // Strip single trailing newline that fenced blocks include
  const lines = (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n');
  const numWidth = String(lines.length).length;

  return (
    <div
      style={{
        margin: '6px 0',
        borderRadius: '8px',
        overflow: 'hidden',
        border: '1px solid rgba(232,121,249,0.22)',
        background: '#080314',
        fontSize: '12px',
        fontFamily: 'monospace',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 12px',
          background: '#130728',
          borderBottom: '1px solid rgba(232,121,249,0.12)',
        }}
      >
        <span style={{ fontSize: '10px', color: 'rgba(192,132,252,0.55)' }}>{filename || language || 'code'}</span>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(raw).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          style={{
            fontSize: '10px',
            color: copied ? '#86efac' : 'rgba(192,132,252,0.5)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
          }}
        >
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>

      {/* Line-numbered body — table guarantees alignment for any number width */}
      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '480px' }}>
        <table style={{ borderCollapse: 'collapse', minWidth: '100%', lineHeight: '1.65' }}>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} style={{ background: 'transparent' }}>
                <td
                  style={{
                    userSelect: 'none',
                    textAlign: 'right',
                    padding: '0 10px 0 12px',
                    minWidth: `${numWidth * 8 + 20}px`,
                    color: 'rgba(139,92,246,0.4)',
                    borderRight: '1px solid rgba(232,121,249,0.08)',
                    whiteSpace: 'nowrap',
                    verticalAlign: 'top',
                  }}
                >
                  {i + 1}
                </td>
                <td style={{ padding: '0 16px', whiteSpace: 'pre', color: '#ddd6fe', verticalAlign: 'top' }}>
                  {line || '\u00a0'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
