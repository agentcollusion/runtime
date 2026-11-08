import type { ToolContext, ToolDefinition } from './contracts.mjs';

export interface A2ASendOptions {
  /** Exact operator-configured endpoint. HTTPS by default. */
  endpoint: string | URL;
  /** Separate peer credential. Never use a Runtime bearer here. */
  remoteBearer?: string;
  /** Permit HTTP to 127.0.0.1 only, for development fixtures. */
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
}

export type A2ASendReply =
  | { kind: 'rejected_input'; reason: 'expected_one_bounded_text_field' }
  | { kind: 'message'; messageId: string; contextId: string; text: string[] }
  | { kind: 'task'; taskId: string; contextId: string; state: string; artifacts: { id: string; text: string[] }[] };

export interface A2ASendTool extends ToolDefinition {
  run(context: ToolContext): Promise<A2ASendReply>;
}

/** An outbound A2A 1.0 JSON-RPC SendMessage binding for a trusted host. */
export function createA2ASendTool(options: A2ASendOptions): A2ASendTool;
