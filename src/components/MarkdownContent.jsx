import React from 'react';
import CodeBlock from './CodeBlock.jsx';

// ─── Inline markdown (bold / italic / inline-code) ────────────────────────────

/**
 * Renders a single line of text with inline markdown: `code`, **bold**, *italic*.
 * @param {{ text: string }} props
 */
export function InlineText({ text }) {
  const imageMatch = text.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (imageMatch) {
    const alt = imageMatch[1] || 'image';
    const src = imageMatch[2] || '';
    return (
      <img
        src={src}
        alt={alt}
        style={{
          display: 'block',
          margin: '6px 0',
          maxWidth: '100%',
          maxHeight: '360px',
          borderRadius: '8px',
          border: '1px solid rgba(232,121,249,0.22)',
          background: 'rgba(10,4,18,0.6)',
        }}
      />
    );
  }

  const segs = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let pos = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > pos) segs.push({ t: 'plain', v: text.slice(pos, m.index) });
    const v = m[0];
    if (v[0] === '`') segs.push({ t: 'code', v: v.slice(1, -1) });
    else if (v.startsWith('**')) segs.push({ t: 'bold', v: v.slice(2, -2) });
    else segs.push({ t: 'em', v: v.slice(1, -1) });
    pos = m.index + v.length;
  }
  if (pos < text.length) segs.push({ t: 'plain', v: text.slice(pos) });

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
  const segs = [];
  const codeRe = /```(\w*)\n?([\s\S]*?)```/g;
  let idx = 0;
  let m;
  while ((m = codeRe.exec(content)) !== null) {
    if (m.index > idx) segs.push({ t: 'text', v: content.slice(idx, m.index) });
    segs.push({ t: 'code', lang: m[1] || '', code: m[2] || '' });
    idx = m.index + m[0].length;
  }
  if (idx < content.length) segs.push({ t: 'text', v: content.slice(idx) });

  function renderLines(text) {
    return text.split('\n').map((line, li) => {
      const t = line.trim();
      if (!t) return <br key={li} />;

      // Headings
      if (/^#{1,3}\s/.test(t)) {
        const lvl = t.match(/^(#+)/)[1].length;
        const rest = t.replace(/^#+\s/, '');
        const s =
          lvl === 1
            ? { display: 'block', fontWeight: 700, fontSize: '15px', color: '#ede9fe', margin: '8px 0 3px' }
            : lvl === 2
            ? { display: 'block', fontWeight: 600, fontSize: '13px', color: '#e5d4ff', margin: '6px 0 2px' }
            : { display: 'block', fontWeight: 600, fontSize: '12px', color: '#d8b4fe', margin: '4px 0 1px' };
        return (
          <span key={li} style={s}>
            <InlineText text={rest} />
          </span>
        );
      }

      // Bullet list
      if (/^[-*]\s/.test(t)) {
        return (
          <span key={li} style={{ display: 'flex', gap: '6px', margin: '1px 0' }}>
            <span style={{ color: '#e879f9', flexShrink: 0, lineHeight: '1.65' }}>•</span>
            <span>
              <InlineText text={t.replace(/^[-*]\s/, '')} />
            </span>
          </span>
        );
      }

      // Numbered list
      const nm = t.match(/^(\d+)\.\s+(.*)/);
      if (nm) {
        return (
          <span key={li} style={{ display: 'flex', gap: '6px', margin: '1px 0' }}>
            <span style={{ color: '#e879f9', flexShrink: 0, lineHeight: '1.65', minWidth: '16px' }}>{nm[1]}.</span>
            <span>
              <InlineText text={nm[2]} />
            </span>
          </span>
        );
      }

      // Blockquote
      if (t.startsWith('> ')) {
        return (
          <span
            key={li}
            style={{
              display: 'block',
              borderLeft: '3px solid rgba(232,121,249,0.4)',
              paddingLeft: '10px',
              margin: '2px 0',
              color: 'rgba(192,132,252,0.8)',
              fontStyle: 'italic',
            }}
          >
            <InlineText text={t.slice(2)} />
          </span>
        );
      }

      // Horizontal rule
      if (/^---+$/.test(t)) {
        return (
          <span
            key={li}
            style={{ display: 'block', borderTop: '1px solid rgba(232,121,249,0.2)', margin: '8px 0' }}
          />
        );
      }

      // Plain line
      return (
        <span key={li} style={{ display: 'block' }}>
          <InlineText text={line} />
        </span>
      );
    });
  }

  return (
    <div style={{ lineHeight: '1.65' }}>
      {segs.map((seg, si) =>
        seg.t === 'code' ? (
          <CodeBlock key={si} code={seg.code} language={seg.lang} />
        ) : (
          <div key={si}>{renderLines(seg.v)}</div>
        )
      )}
    </div>
  );
}
