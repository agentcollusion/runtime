import type { JsonValue } from './contracts.mjs';
import type { WorkerContext } from './worker.mjs';

export type TextProvider = 'codex' | 'claude';
export interface ProviderConfiguration {
  provider: TextProvider;
  /** Trusted operator configuration only. Never construct this from peer input. */
  command?: readonly [string, ...string[]];
}
export interface TextJob {
  format: 'agentcollusion.text-job/v1';
  title: string;
  instructions: string;
  context: JsonValue;
  acceptanceCriteria: string[];
}
export interface TextRun {
  format: 'agentcollusion.text-run/v1';
  evidenceKind: 'cli-backed-text-job';
  state: 'completed' | 'failed' | 'cancelled';
  taskId: string;
  directory: string;
  fingerprint: string;
  providers: Record<'writer' | 'reviewer', { provider: TextProvider; version: string }>;
  maxRevisions: number;
  evidenceVerified: true;
  hostStopped: true;
  files: string[];
  privateState: 'private/';
  diagnostics: Array<{role:'writer'|'reviewer';code:string;file:string}>;
  limits: string;
}
export function runTextJob(options: {
  job: TextJob;
  writer: ProviderConfiguration;
  reviewer: ProviderConfiguration;
  directory?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRevisions?: number;
}): Promise<TextRun>;
