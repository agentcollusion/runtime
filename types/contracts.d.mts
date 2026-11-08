export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type PermissionOperation = 'task.submit' | 'artifact.read' | 'artifact.write';
export type Permission = { operation: PermissionOperation; resource: string };

/** Private configuration obtained from the runtime owner. Do not log or publish it. */
export interface RuntimeConfig {
  url: string;
  token: string;
  ca: string;
  timeoutMs?: number;
  agentId?: string;
  fingerprint?: string;
}

export interface RuntimeInfo {
  runtimeId: string;
  fingerprint: string;
  publicKey: string;
  actor: string;
  protocol: 'agentcollusion-runtime/v1';
}

export interface AgentRecord {
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface AgentCredential extends AgentRecord {
  token: string;
}

export interface GrantInput {
  to: string;
  permissions: readonly Permission[];
  /** ISO UTC time with milliseconds; the host validates the permitted lifetime. */
  expiresAt: string;
  delegable?: boolean;
}

export interface Grant extends GrantInput {
  id: string;
  from: string;
  delegable: boolean;
  parentId: string | null;
  taskId: string | null;
  parentGeneration?: number | null;
  revokedAt: string | null;
}

export interface TaskInput extends GrantInput {
  title: string;
  input?: JsonValue;
  requiredArtifacts?: readonly string[];
  /** Required when an agent submits outside the worker's delegated submit helper. */
  authorityId?: string;
}

export type TerminalState = 'completed' | 'failed' | 'cancelled';
export type ActiveState = 'queued' | 'running';
export type TaskState = ActiveState | TerminalState;

export interface ArtifactReference {
  id: string;
  sha256: string;
}

export interface Artifact extends ArtifactReference {
  mediaType: string;
  value: JsonValue;
}

export interface TaskSummary {
  id: string;
  from: string;
  to: string;
  title: string;
  grantId: string;
  parentTaskId: string | null;
  parentGeneration: number | null;
  permissions: readonly Permission[];
  requiredArtifacts: readonly string[];
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  state: TaskState;
  attempt: number;
  generation: number;
  leaseUntil: string | null;
  artifacts: readonly ArtifactReference[];
}

export interface InboxTask extends TaskSummary {
  state: ActiveState;
  claimable: boolean;
}

export interface Task extends TaskSummary {
  input: JsonValue;
  result: JsonObject | null;
}

export interface RunningTask extends Task {
  state: 'running';
  leaseUntil: string;
  result: null;
}

export interface TerminalTask extends Task {
  state: TerminalState;
  leaseUntil: null;
  result: JsonObject;
}

export interface Submission {
  task: Task;
  replayed: boolean;
}

export interface Claim {
  task: RunningTask;
  claimToken: string;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface EvidenceHead {
  sequence: number;
  hash: string;
}

export interface AuditEvent {
  sequence: number;
  previousHash: string;
  runtimeId: string;
  at: string;
  actor: string;
  type: string;
  taskId: string | null;
  detail: JsonObject;
  hash: string;
}

interface EvidenceMetadata {
  schemaVersion: 1;
  runtimeId: string;
  exportedAt: string;
  head: EvidenceHead;
}

export interface AuditPayload extends EvidenceMetadata {
  kind: 'audit';
  events: readonly AuditEvent[];
}

export interface ReceiptPayload extends EvidenceMetadata {
  kind: 'receipt';
  task: TaskSummary & {
    state: TerminalState;
    inputSha256: string;
    resultSha256: string;
  };
  taskEvent: AuditEvent;
}

export type EvidencePayload = AuditPayload | ReceiptPayload;

export interface EvidenceEnvelope<Payload = EvidencePayload> {
  format: 'agentcollusion-evidence/v1';
  payload: Payload;
  publicKey: string;
  fingerprint: string;
  signature: string;
}

export interface VerifiedEvidence {
  valid: true;
  kind: EvidencePayload['kind'];
  runtimeId: string;
  fingerprint: string;
  head: EvidenceHead;
}

export interface AuditCheckpoint {
  format: 'agentcollusion-audit-checkpoint/v1';
  runtimeId: string;
  fingerprint: string;
  head: EvidenceHead;
}

export interface VerifiedAuditExtension extends VerifiedEvidence {
  kind: 'audit';
  previousHead: EvidenceHead;
  advanced: boolean;
}

export interface VerifiedReceiptInAudit extends VerifiedEvidence {
  kind: 'receipt';
  auditHead: EvidenceHead;
}
