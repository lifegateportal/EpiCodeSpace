import React from 'react';
import CodeBlock from './CodeBlock.jsx';

// ─── Inline markdown (bold / italic / inline-code) ────────────────────────────

/**
 * Renders a single line of text with inline markdown: `code`, **bold**, *italic*.
 * @param {{ text: string }} props
 */
export function InlineText({ text }) {
  const safeText = typeof text === 'string' ? text : '';
  const segs = [];
  const re = /(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)|`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let pos = 0;
  let m;
  while ((m = re.exec(safeText)) !== null) {
    if (m.index > pos) segs.push({ t: 'plain', v: safeText.slice(pos, m.index) });
    const v = m[0];
    if (v.startsWith('[')) {
      const lm = v.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (lm) segs.push({ t: 'link', label: lm[1], href: lm[2] });
      else segs.push({ t: 'plain', v });
    } else if (v[0] === '`') segs.push({ t: 'code', v: v.slice(1, -1) });
    else if (v.startsWith('**')) segs.push({ t: 'bold', v: v.slice(2, -2) });
    else segs.push({ t: 'em', v: v.slice(1, -1) });
    pos = m.index + v.length;
  }
  if (pos < safeText.length) segs.push({ t: 'plain', v: safeText.slice(pos) });

  return (
    <>
      {segs.map((s, i) => {
        if (s.t === 'code')
          return (
            <code
              key={i}
              style={{
                background: 'rgba(26,11,53,0.9)',
                color: '#e879f9',
                padding: '1px 5px',
                borderRadius: '4px',
                fontSize: '11px',
                fontFamily: 'monospace',
                border: '1px solid rgba(232,121,249,0.22)',
                margin: '0 1px',
              }}
            >
              {s.v}
            </code>
          );
        if (s.t === 'link') {
          return (
            <a
              key={i}
              href={s.href}
              target="_blank"
              rel="noreferrer"
              style={{
                color: '#93c5fd',
                textDecoration: 'underline',
                textUnderlineOffset: '2px',
              }}
            >
              {s.label}
            </a>
          );
        }
        if (s.t === 'bold') return <strong key={i} style={{ color: '#ede9fe', fontWeight: 600 }}>{s.v}</strong>;
        if (s.t === 'em') return <em key={i} style={{ color: '#c4b5fd' }}>{s.v}</em>;
        return <span key={i}>{s.v}</span>;
      })}
    </>
  );
}

// ─── Full markdown renderer (GitHub-style subset) ─────────────────────────────

/**
 * Renders a Markdown string supporting:
 * - Fenced code blocks (```lang)
 * - Headings (# ## ###)
 * - Bullet lists (- or *)
 * - Numbered lists
 * - Blockquotes (>)
 * - Horizontal rules (---)
 * - Inline bold / italic / code
 *
 * @param {{ content: string }} props
 */
export default function MarkdownContent({ content }) {
  const src = typeof content === 'string' ? content : '';
  const segs = [];
  const codeRe = /```(\w*)\n?([\s\S]*?)```/g;
  let idx = 0;
  let m;
  while ((m = codeRe.exec(src)) !== null) {
    if (m.index > idx) segs.push({ t: 'text', v: src.slice(idx, m.index) });
    segs.push({ t: 'code', lang: m[1] || '', code: m[2] || '' });
    idx = m.index + m[0].length;
  }
  if (idx < src.length) segs.push({ t: 'text', v: src.slice(idx) });

  function isTableDivider(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function splitTableRow(line) {
    let raw = line.trim();
    if (raw.startsWith('|')) raw = raw.slice(1);
    if (raw.endsWith('|')) raw = raw.slice(0, -1);
    return raw.split('|').map(c => c.trim());
  }

  function parseTextBlocks(text) {
    const lines = text.split('\n');
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();

      if (!t) {
        i += 1;
        continue;
      }

      if (/^#{1,3}\s/.test(t)) {
        const lvl = t.match(/^(#+)/)[1].length;
        blocks.push({ type: 'heading', level: lvl, text: t.replace(/^#+\s/, '') });
        i += 1;
        continue;
      }

      if (/^---+$/.test(t)) {
        blocks.push({ type: 'hr' });
        i += 1;
        continue;
      }

      if (t.startsWith('>')) {
        const quote = [];
        while (i < lines.length && lines[i].trim().startsWith('>')) {
          quote.push(lines[i].trim().replace(/^>\s?/, ''));
          i += 1;
        }
        blocks.push({ type: 'quote', lines: quote });
        continue;
      }

      if (t.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        const headers = splitTableRow(lines[i]);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim().includes('|')) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        blocks.push({ type: 'table', headers, rows });
        continue;
      }

      const taskMatch = t.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/);
      if (taskMatch) {
        const items = [];
        while (i < lines.length) {
          const mm = lines[i].trim().match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/);
          if (!mm) break;
          items.push({ checked: mm[1].toLowerCase() === 'x', text: mm[2] });
          i += 1;
        }
        blocks.push({ type: 'tasks', items });
        continue;
      }

      if (/^[-*]\s+/.test(t)) {
        const items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
          i += 1;
        }
        blocks.push({ type: 'ul', items });
        continue;
      }

      if (/^\d+\.\s+/.test(t)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          const mm = lines[i].trim().match(/^(\d+)\.\s+(.*)$/);
          items.push({ n: mm[1], text: mm[2] });
          i += 1;
        }
        blocks.push({ type: 'ol', items });
        continue;
      }

      const para = [line];
      i += 1;
      while (i < lines.length) {
        const nt = lines[i].trim();
        if (
          !nt ||
          /^#{1,3}\s/.test(nt) ||
          /^[-*]\s+/.test(nt) ||
          /^\d+\.\s+/.test(nt) ||
          nt.startsWith('>') ||
          /^---+$/.test(nt) ||
          (nt.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]))
        ) {
          break;
        }
        para.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'p', text: para.join(' ').trim() });
    }

    return blocks;
  }

  function renderTextBlocks(text) {
    const blocks = parseTextBlocks(text);
    return blocks.map((b, i) => {
      if (b.type === 'heading') {
        const s =
          b.level === 1
            ? { display: 'block', fontWeight: 700, fontSize: '15px', color: '#ede9fe', margin: '10px 0 4px' }
            : b.level === 2
            ? { display: 'block', fontWeight: 600, fontSize: '13px', color: '#e5d4ff', margin: '8px 0 4px' }
            : { display: 'block', fontWeight: 600, fontSize: '12px', color: '#d8b4fe', margin: '6px 0 3px' };
        return (
          <span key={i} style={s}>
            <InlineText text={b.text} />
          </span>
        );
      }

      if (b.type === 'hr') {
        return <span key={i} style={{ display: 'block', borderTop: '1px solid rgba(232,121,249,0.2)', margin: '10px 0' }} />;
      }

      if (b.type === 'quote') {
        return (
          <div
            key={i}
            style={{
              borderLeft: '3px solid rgba(232,121,249,0.4)',
              paddingLeft: '10px',
              margin: '6px 0',
              color: 'rgba(192,132,252,0.85)',
              fontStyle: 'italic',
            }}
          >
            {b.lines.map((q, qi) => (
              <div key={qi}><InlineText text={q} /></div>
            ))}
          </div>
        );
      }

      if (b.type === 'table') {
        return (
          <div key={i} style={{ overflowX: 'auto', margin: '8px 0' }}>
            <table style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: '12px' }}>
              <thead>
                <tr>
                  {b.headers.map((h, hi) => (
                    <th key={hi} style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid rgba(232,121,249,0.2)', color: '#ede9fe', background: 'rgba(255,255,255,0.02)' }}>
                      <InlineText text={h} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, ci) => (
                      <td key={ci} style={{ padding: '6px 8px', border: '1px solid rgba(232,121,249,0.15)', color: '#ddd6fe' }}>
                        <InlineText text={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }

      if (b.type === 'tasks') {
        return (
          <div key={i} style={{ margin: '6px 0' }}>
            {b.items.map((it, ti) => (
              <div key={ti} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', margin: '2px 0' }}>
                <span style={{ color: it.checked ? '#86efac' : 'rgba(232,121,249,0.8)', lineHeight: '1.5' }}>{it.checked ? '✓' : '○'}</span>
                <span style={{ textDecoration: it.checked ? 'line-through' : 'none', opacity: it.checked ? 0.75 : 1 }}>
                  <InlineText text={it.text} />
                </span>
              </div>
            ))}
          </div>
        );
      }

      if (b.type === 'ul') {
        return (
          <div key={i} style={{ margin: '6px 0' }}>
            {b.items.map((item, bi) => (
              <div key={bi} style={{ display: 'flex', gap: '6px', margin: '1px 0' }}>
                <span style={{ color: '#e879f9', flexShrink: 0, lineHeight: '1.65' }}>•</span>
                <span><InlineText text={item} /></span>
              </div>
            ))}
          </div>
        );
      }

      if (b.type === 'ol') {
        return (
          <div key={i} style={{ margin: '6px 0' }}>
            {b.items.map((item, oi) => (
              <div key={oi} style={{ display: 'flex', gap: '6px', margin: '1px 0' }}>
                <span style={{ color: '#e879f9', flexShrink: 0, lineHeight: '1.65', minWidth: '16px' }}>{item.n}.</span>
                <span><InlineText text={item.text} /></span>
              </div>
            ))}
          </div>
        );
      }

      return (
        <p key={i} style={{ margin: '7px 0', color: '#e9ddff' }}>
          <InlineText text={b.text} />
        </p>
      );
    });
  }

  return (
    <div style={{ lineHeight: '1.65', letterSpacing: '0.01em' }}>
      {segs.map((seg, si) =>
        seg.t === 'code' ? (
          <CodeBlock key={si} code={seg.code} language={seg.lang} />
        ) : (
          <div key={si}>{renderTextBlocks(seg.v)}</div>
        )
      )}
    </div>
  );
}
