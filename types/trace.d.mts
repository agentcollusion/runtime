import type { EvidenceHead } from './contracts.mjs';

export interface AuditTraceOptions {
  trustedFingerprint: string;
  checkpoint?: unknown;
  taskId?: string;
  /** Return events strictly after this sequence, oldest first. */
  afterSequence?: number;
  /** 1–500 rows, default 100. Omit the cursor to see the latest rows. */
  limit?: number;
}

export interface TraceEvent {
  sequence: number;
  at: string | null;
  actor: string | null;
  type: string | null;
  taskId: string | null;
  hash: string;
  detail: Record<string, string | number>;
}

export interface AuditTrace {
  format: 'agentcollusion-audit-trace/v1';
  runtimeId: string;
  fingerprint: string;
  head: EvidenceHead;
  retainedHead?: EvidenceHead;
  advanced?: boolean;
  selection: {
    taskId: string | null;
    afterSequence: number | null;
    matches: number;
    shown: number;
    olderOmitted: number;
    newerRemaining: number;
    nextAfterSequence: number | null;
  };
  events: TraceEvent[];
}

/** Verify the whole audit before returning a derived, unsigned trace selection. */
export function inspectAuditTrace(audit: unknown, options: AuditTraceOptions): AuditTrace;
