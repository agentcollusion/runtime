import { canonical } from './evidence.mjs';
import { identifier, requireCondition as must } from './errors.mjs';

const MAX_REGISTERED = 64;
const MAX_RUNNING = 16;
const MAX_RESULT_BYTES = 64 * 1024;

// Handler code is trusted host configuration. Only data enters from agents.
export class ToolRunner {
  #registered = new Map();
  #running = new Set();
  #shutdown = new AbortController();

  constructor(registry) {
    if (registry === undefined) return;
    must(
      registry && Object.getPrototypeOf(registry) === Object.prototype,
      400, 'INVALID_TOOLS', 'tools must be an object of named handlers.',
    );
    const entries = Object.entries(registry);
    must(entries.length <= MAX_REGISTERED, 400, 'INVALID_TOOLS', 'Register at most 64 tools.');
    for (const [name, descriptor] of entries) {
      identifier(name, 'tool ID');
      const timeoutMs = descriptor?.timeoutMs ?? 5000;
      must(
        typeof descriptor?.run === 'function' && Number.isSafeInteger(timeoutMs) &&
          timeoutMs >= 100 && timeoutMs <= 15000,
        400, 'INVALID_TOOLS', 'Each tool needs a handler and a 100–15000 ms timeout.',
      );
      this.#registered.set(name, { run: descriptor.run, timeoutMs });
    }
  }

  resolve(name) {
    const tool = this.#registered.get(name);
    must(tool, 404, 'TOOL_NOT_FOUND', 'The host has not registered this tool.');
    must(!this.#shutdown.signal.aborted, 503, 'HOST_STOPPING', 'The host is stopping.');
    must(this.#running.size < MAX_RUNNING, 429, 'TOOL_BUSY', 'The host is at its tool execution limit.');
    return tool;
  }

  running(id) {
    return this.#running.has(id);
  }

  close() {
    this.#shutdown.abort();
  }

  async run(tool, call, input, remainingLeaseMs) {
    this.#running.add(call.id);
    const budget = Math.max(1, Math.min(tool.timeoutMs, remainingLeaseMs));
    const end = performance.now() + budget;
    const deadline = AbortSignal.timeout(budget);
    const signal = AbortSignal.any([this.#shutdown.signal, deadline]);
    let onAbort;
    const interrupted = new Promise((resolve) => {
      onAbort = () => resolve({ state: 'uncertain', reason: this.#shutdown.signal.aborted ? 'shutdown' : 'timeout' });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    const handler = Promise.resolve().then(async () => {
      let value;
      try {
        signal.throwIfAborted();
        if (performance.now() >= end) return { state: 'uncertain', reason: 'timeout' };
        value = await tool.run(Object.freeze({
          input,
          signal,
          invocationId: call.id,
          taskId: call.taskId,
          agentId: call.actor,
          generation: call.generation,
        }));
      } catch {
        return { state: 'uncertain', reason: 'handler_error' };
      }
      try {
        const result = canonical(value);
        if (Buffer.byteLength(result) > MAX_RESULT_BYTES) throw new Error('oversize');
        if (performance.now() >= end) return { state: 'uncertain', reason: 'timeout' };
        return { state: 'returned', result: JSON.parse(result) };
      } catch {
        return { state: 'uncertain', reason: 'invalid_result' };
      }
    }).finally(() => this.#running.delete(call.id));
    try {
      return await Promise.race([interrupted, handler]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
