const MAX_TEXT_BYTES = 16384;
const MAX_RESPONSE_BYTES = 65536;
const PORTABLE_TOKEN = /^[A-Za-z0-9._~+/-]+={0,2}$/;

function id(value, name) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Invalid A2A ${name}.`);
  return value;
}

async function boundedResponse(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`A2A endpoint returned HTTP ${response.status}.`);
  }
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (!['application/json', 'application/a2a+json'].includes(type) || !response.body) {
    await response.body?.cancel();
    throw new Error('Expected an A2A JSON response.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('A2A response exceeded its byte limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
}

const textParts = (parts) => Array.isArray(parts)
  ? parts.filter(part => typeof part?.text === 'string').map(part => part.text)
  : [];

/** Narrow A2A 1.0 JSON-RPC SendMessage binding, configured by the host owner. */
export function createA2ASendTool({ endpoint, remoteBearer, allowLoopbackHttp = false, timeoutMs = 5000 }) {
  const target = new URL(endpoint);
  if (
    target.username || target.password || target.search || target.hash ||
    !(target.protocol === 'https:' || (allowLoopbackHttp && target.protocol === 'http:' && target.hostname === '127.0.0.1'))
  ) throw new Error('Configure an exact HTTPS A2A endpoint (or explicit IPv4 loopback HTTP for tests).');
  if (remoteBearer !== undefined && (typeof remoteBearer !== 'string' || remoteBearer.length > 4096 || !PORTABLE_TOKEN.test(remoteBearer)))
    throw new Error('Expected a valid, separately configured A2A bearer credential.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000)
    throw new Error('A2A tool timeout must be 100–15000 ms.');
  return {
    timeoutMs,
    async run({ input, invocationId, signal }) {
      const requestId = id(invocationId, 'request ID');
      if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).length !== 1 ||
        typeof input.text !== 'string' || !input.text || Buffer.byteLength(input.text) > MAX_TEXT_BYTES)
        return { kind: 'rejected_input', reason: 'expected_one_bounded_text_field' };
      const deadline = AbortSignal.timeout(timeoutMs);
      const response = await fetch(target, {
        method: 'POST', redirect: 'error', credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json', 'A2A-Version': '1.0',
          ...(remoteBearer ? { Authorization: `Bearer ${remoteBearer}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'SendMessage', params: {
          message: { messageId: requestId, role: 'ROLE_USER', parts: [{ text: input.text, mediaType: 'text/plain' }] },
          configuration: { acceptedOutputModes: ['text/plain'] },
        } }),
      });
      const envelope = await boundedResponse(response);
      if (envelope?.jsonrpc !== '2.0' || envelope.id !== requestId || Object.hasOwn(envelope, 'error'))
        throw new Error('A2A endpoint did not return a successful matching response.');
      const result = envelope.result;
      if (!result || typeof result !== 'object' || Number(Object.hasOwn(result, 'message')) + Number(Object.hasOwn(result, 'task')) !== 1)
        throw new Error('Expected one A2A message or task.');
      if (result.message) {
        const message = result.message;
        if (message.role !== 'ROLE_AGENT') throw new Error('Expected an A2A agent response.');
        return { kind: 'message', messageId: id(message.messageId, 'message ID'), contextId: id(message.contextId, 'context ID'), text: textParts(message.parts) };
      }
      const task = result.task;
      if (!task || !['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED'].includes(task.status?.state))
        throw new Error('Expected a recognized A2A task state.');
      return {
        kind: 'task', taskId: id(task.id, 'task ID'), contextId: id(task.contextId, 'context ID'), state: task.status.state,
        artifacts: Array.isArray(task.artifacts) ? task.artifacts.map(artifact => ({
          id: id(artifact.artifactId, 'artifact ID'), text: textParts(artifact.parts),
        })) : [],
      };
    },
  };
}
