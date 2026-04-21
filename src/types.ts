/**
 * Core domain types for EpiCodeSpace.
 *
 * These interfaces document the shape of data flowing through the app.
 * JSX files can import them via JSDoc @type annotations:
 *
 *   /** @type {import('./types').FileEntry} *\/
 *
 * or you can gradually migrate files to .tsx and use them directly.
 */

// ─── Virtual File System ─────────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  language: string;
  content: string;
}

export type FileSystem = Record<string, FileEntry>;

// ─── Chat & Messaging ─────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant';
export type ChatMode = 'ask' | 'agent' | 'plan';

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  agent: string;
  agentName?: string;
  toolCalls?: ToolCall[];
  steps?: string[];
  mode?: ChatMode;
  timestamp: number;
  /** Indicates a transient progress message — not persisted */
  _progress?: boolean;
}

// ─── Conversation ─────────────────────────────────────────────────────────────

export interface Conversation {
  id: number;
  name: string;
  messages: ChatMessage[];
  agent: string;
  createdAt: number;
  lastOpenedAt?: number;
}

// ─── Agent Registry ───────────────────────────────────────────────────────────

export type AgentCapability =
  | 'code_gen'
  | 'refactor'
  | 'explain'
  | 'debug'
  | 'file_ops'
  | 'review'
  | 'test_gen'
  | 'docs'
  | 'architecture';

export interface AgentDefinition {
  id: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  capabilities: AgentCapability[];
}

export type AgentRegistry = Record<string, AgentDefinition>;

// ─── Static Analysis ──────────────────────────────────────────────────────────

export type IssueSeverity = 'error' | 'warning' | 'info';
export type IssueCategory =
  | 'quality'
  | 'async'
  | 'react'
  | 'safety'
  | 'security'
  | 'perf'
  | 'runtime'
  | 'debug';

export interface AnalysisIssue {
  line: number;
  type: IssueSeverity;
  category: IssueCategory;
  msg: string;
}

export interface AnalysisResult {
  ok: boolean;
  file?: string;
  language?: string;
  lines?: number;
  chars?: number;
  issueCount?: number;
  issues?: AnalysisIssue[];
  summary?: string;
  error?: string;
}

// ─── Terminal ─────────────────────────────────────────────────────────────────

export interface PortEntry {
  port: number;
  protocol: string;
  state: 'running' | 'stopped';
  label: string;
  visibility: 'private' | 'public';
  pid: number;
}

export interface DebugLogEntry {
  type: 'log' | 'info' | 'warn' | 'error';
  text: string;
  ts: number;
}

// ─── Problems Panel ───────────────────────────────────────────────────────────

export interface ProblemEntry {
  severity: IssueSeverity;
  file: string;
  line: number;
  msg: string;
}

// ─── User Preferences ─────────────────────────────────────────────────────────

export interface UserPreferences {
  fontSize: number;
  wordWrap: boolean;
}
