import type { RuntimeClient } from './client.mjs';
import type { Artifact, ArtifactReference, JsonObject, JsonValue, RunningTask, Submission, TaskInput, TerminalTask, WaitOptions } from './contracts.mjs';

export interface WorkerContext {
  task: RunningTask;
  signal: AbortSignal;
  artifact(id: string, value: JsonValue, mediaType?: string): Promise<ArtifactReference>;
  submit(input: Omit<TaskInput, 'authorityId'>, key?: string): Promise<Submission>;
  wait(id: string, options?: Omit<WaitOptions, 'signal'>): Promise<TerminalTask>;
  readArtifact(id: string, artifactId: string): Promise<Artifact>;
}

export interface WorkerOptions {
  /** Use a recipient agent credential, not the owner configuration. */
  client: RuntimeClient;
  handle(context: WorkerContext): JsonObject | Promise<JsonObject>;
  signal?: AbortSignal;
  leaseMs?: number;
  pollMs?: number;
  onError?(error: unknown): void;
}

export function runWorker(options: WorkerOptions): Promise<void>;
