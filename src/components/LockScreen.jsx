import React, { useState, useCallback, useEffect } from 'react';
import { Lock } from 'lucide-react';

const SESSION_KEY = 'epicodespace_unlocked';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export default function LockScreen({ children }) {
  // Env var set at build time: VITE_ACCESS_PASSWORD_HASH (SHA-256 hex of the password).
  // If not set, the lock screen is disabled entirely (dev / local use).
  const passwordHash = (import.meta.env?.VITE_ACCESS_PASSWORD_HASH || '').trim().toLowerCase();
  const enabled = passwordHash.length === 64; // only active when a valid SHA-256 hash is provided

  const [unlocked, setUnlocked] = useState(() => {
    if (!enabled) return true;
    return sessionStorage.getItem(SESSION_KEY) === passwordHash;
  });

  const [input,   setInput]   = useState('');
  const [error,   setError]   = useState('');
  const [shaking, setShaking] = useState(false);

  const handleUnlock = useCallback(async (e) => {
    e?.preventDefault();
    if (!input.trim()) return;
    const hash = await sha256Hex(input.trim());
    if (hash === passwordHash) {
      sessionStorage.setItem(SESSION_KEY, hash);
      setUnlocked(true);
    } else {
      setError('Incorrect password.');
      setInput('');
      setShaking(true);
      setTimeout(() => setShaking(false), 500);
    }
  }, [input, passwordHash]);

  if (!enabled || unlocked) return children;

  return (
    <div className="fixed inset-0 bg-[#09070f] flex items-center justify-center" role="main">
      <div
        className={`w-[340px] max-w-[90vw] bg-[#111827] rounded-2xl p-8 flex flex-col items-center shadow-2xl ${shaking ? 'animate-shake' : ''}`}
        style={{ animation: shaking ? 'shake 0.4s ease' : undefined }}
      >
        {/* Logo */}
        <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center mb-5 shadow-lg">
          <span className="text-[#111827] font-extrabold text-sm tracking-tighter select-none">ECS</span>
        </div>

        <h1 className="text-white text-lg font-semibold mb-1">EpiCodeSpace</h1>
        <p className="text-gray-400 text-xs mb-7 text-center">Enter your access password to continue.</p>

        <form onSubmit={handleUnlock} className="w-full space-y-3">
          <input
            type="password"
            value={input}
            onChange={e => { setInput(e.target.value); setError(''); }}
            placeholder="Password"
            autoFocus
            autoComplete="current-password"
            className="w-full bg-[#1f2937] border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/30 transition-colors"
          />
          {error && (
            <p className="text-red-400 text-xs text-center">{error}</p>
          )}
          <button
            type="submit"
            className="w-full bg-white hover:bg-gray-100 text-[#111827] font-semibold text-sm py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
          >
            <Lock size={14} />
            Unlock
          </button>
        </form>
      </div>

      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
          20%      { transform: translateX(-8px); }
          40%      { transform: translateX(8px); }
          60%      { transform: translateX(-5px); }
          80%      { transform: translateX(5px); }
        }
      `}</style>
    </div>
  );
}
