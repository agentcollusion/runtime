import type {
  AgentCredential, AgentRecord, Artifact, ArtifactReference, AuditPayload, Claim,
  EvidenceEnvelope, Grant, GrantInput, InboxTask, JsonObject, JsonValue,
  ReceiptPayload, RunningTask, RuntimeConfig, RuntimeInfo, Submission, Task,
  TaskInput, TaskSummary, TerminalTask, WaitOptions,
} from './contracts.mjs';

export type * from './contracts.mjs';

export class ClientError extends Error {
  constructor(status: number | undefined, code: string, message: string);
  readonly status: number | undefined;
  readonly code: string;
}

export class RuntimeClient {
  constructor(config: RuntimeConfig);
  readonly url: string;
  readonly token: string;
  readonly ca: string;
  readonly certificateFingerprint: string;
  readonly timeoutMs: number;

  /** Advanced transport escape hatch. Validate the response shape yourself. */
  request(method: string, endpoint: string, body?: JsonValue, headers?: Record<string, string>): Promise<unknown>;
  raw(method: string, endpoint: string, body?: JsonValue, headers?: Record<string, string>): Promise<unknown>;
  info(): Promise<RuntimeInfo>;
  agents(): Promise<{ agents: AgentRecord[] }>;
  createAgent(input: { id: string; name?: string }): Promise<AgentCredential>;
  revokeAgent(id: string): Promise<AgentRecord>;
  grant(input: GrantInput): Promise<Grant>;
  revokeGrant(id: string): Promise<Grant>;
  submit(input: TaskInput, idempotencyKey?: string, claimToken?: string): Promise<Submission>;
  tasks(): Promise<{ tasks: TaskSummary[] }>;
  inbox(): Promise<{ tasks: InboxTask[] }>;
  task(id: string): Promise<Task>;
  claim(id: string, leaseMs?: number): Promise<Claim>;
  heartbeat(id: string, claimToken: string, leaseMs?: number): Promise<RunningTask>;
  putArtifact(id: string, artifactId: string, value: JsonValue, claimToken: string, mediaType?: string): Promise<ArtifactReference>;
  artifact(id: string, artifactId: string): Promise<Artifact>;
  complete(id: string, result: JsonObject, claimToken: string): Promise<TerminalTask & { state: 'completed' }>;
  fail(id: string, result: JsonObject, claimToken: string): Promise<TerminalTask & { state: 'failed' }>;
  cancel(id: string): Promise<TerminalTask & { state: 'cancelled' }>;
  receipt(id: string): Promise<EvidenceEnvelope<ReceiptPayload>>;
  audit(): Promise<EvidenceEnvelope<AuditPayload>>;
  wait(id: string, options?: WaitOptions): Promise<TerminalTask>;
}
