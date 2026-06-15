import React, { useState, useEffect, useRef, useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
// Register only the languages we actually need (keeps the bundle small)
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import xml from 'highlight.js/lib/languages/xml';   // covers HTML/JSX
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('plaintext', plaintext);

// Minimal dark theme tuned to the existing purple palette
const HLJS_STYLE = `
.hljs-keyword,.hljs-selector-tag{color:#c084fc}
.hljs-string,.hljs-attr{color:#86efac}
.hljs-number,.hljs-literal{color:#fb923c}
.hljs-comment{color:#6b7280;font-style:italic}
.hljs-title,.hljs-name{color:#67e8f9}
.hljs-variable,.hljs-params{color:#ddd6fe}
.hljs-built_in,.hljs-type{color:#a78bfa}
.hljs-function,.hljs-section{color:#f472b6}
.hljs-tag{color:#60a5fa}
.hljs-attribute{color:#93c5fd}
.hljs-meta{color:#9ca3af}
`;

/**
 * Renders a syntax-highlighted code block with per-row line numbers and a copy button.
 *
 * @param {{ code: string; language?: string; filename?: string }} props
 */
export default function CodeBlock({ code, language, filename }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef(null);
  const raw = typeof code === 'string' ? code : '';
  // Strip single trailing newline that fenced blocks include
  const normalised = raw.endsWith('\n') ? raw.slice(0, -1) : raw;

  // Syntax-highlight the entire block, then split into per-line HTML strings
  const highlightedLines = useMemo(() => {
    const lang = language?.toLowerCase();
    const highlighted = lang && hljs.getLanguage(lang)
      ? hljs.highlight(normalised, { language: lang }).value
      : hljs.highlightAuto(normalised, ['javascript', 'typescript', 'python', 'html', 'css', 'json', 'bash']).value;
    return highlighted.split('\n');
  }, [normalised, language]);

  const numWidth = String(highlightedLines.length).length;

  // A6 — clean up copy-feedback timer on unmount to avoid state update on
  // an unmounted component.
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

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
      <style>{HLJS_STYLE}</style>
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
            copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
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
            {highlightedLines.map((lineHtml, i) => (
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
                <td
                  style={{ padding: '0 16px', whiteSpace: 'pre', color: '#ddd6fe', verticalAlign: 'top' }}
                  dangerouslySetInnerHTML={{ __html: lineHtml || '\u00a0' }}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
