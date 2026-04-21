import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import EpiCodeSpaceApp from './EpiCodeSpaceComplete.jsx';

try {
  const root = createRoot(document.getElementById('root'));
  root.render(<EpiCodeSpaceApp />);
} catch (err) {
  // Build error UI with safe DOM construction — never use innerHTML with error details (XSS risk)
  const container = document.getElementById('root');
  const wrap = document.createElement('div');
  Object.assign(wrap.style, { background: '#0a0412', color: '#e879f9', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', fontFamily: 'monospace' });

  const heading = document.createElement('h1');
  heading.textContent = '⚡ EpiCodeSpace failed to start';

  const pre = document.createElement('pre');
  Object.assign(pre.style, { background: '#1a0b35', padding: '1.5rem', borderRadius: '0.75rem', maxWidth: '90vw', overflow: 'auto', fontSize: '0.85rem', color: '#f87171', border: '1px solid rgba(232,121,249,0.3)', marginTop: '1rem' });
  pre.textContent = `${err.message}\n${err.stack}`;

  const btn = document.createElement('button');
  btn.textContent = 'Clear Data & Reload';
  Object.assign(btn.style, { marginTop: '1.5rem', padding: '0.75rem 2rem', background: '#a21caf', color: 'white', border: 'none', borderRadius: '0.5rem', cursor: 'pointer', fontSize: '0.9rem' });
  btn.addEventListener('click', () => { try { localStorage.clear(); } catch {} location.reload(); });

  wrap.appendChild(heading);
  wrap.appendChild(pre);
  wrap.appendChild(btn);
  container.appendChild(wrap);
}
