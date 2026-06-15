import React, { Component } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { logger } from '../lib/logger.js';

/**
 * Amendment #6 — Observability.
 * Scoped ErrorBoundary so one crashed panel does not take down the whole IDE.
 *
 * @param {{ scope: string, children: React.ReactNode, fallback?: React.ReactNode, onReset?: () => void }} props
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    logger.error(this.props.scope || 'unknown', error?.message || 'Unhandled error', {
      stack: error?.stack,
      componentStack: info?.componentStack,
    });
  }

  reset = () => {
    this.setState({ error: null, info: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div
        role="alert"
        className="h-full w-full flex flex-col items-center justify-center p-6 text-center bg-[#1a0b35]/40 border border-red-500/30 rounded-md"
      >
        <AlertCircle size={28} className="text-red-400 mb-2" />
        <div className="text-xs font-semibold text-red-300 mb-1">
          {this.props.scope ? `"${this.props.scope}" panel crashed` : 'Something went wrong'}
        </div>
        <pre className="text-[10px] text-red-300/70 max-w-md max-h-32 overflow-auto whitespace-pre-wrap mb-3 font-mono">
          {this.state.error?.message}
        </pre>
        <button
          onClick={this.reset}
          className="flex items-center gap-1.5 text-[11px] text-fuchsia-300 hover:text-fuchsia-200 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 border border-fuchsia-500/30 rounded px-3 py-1.5 transition-colors"
        >
          <RotateCcw size={11} /> Try again
        </button>
      </div>
    );
  }
}
