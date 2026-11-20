import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runOwnedProcess } from './owned-process.mjs';
import { writePrivateJson } from './security.mjs';

const providers = new Set(['codex', 'claude']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function providerCommand(provider) {
  if (!providers.has(provider)) throw new Error('Provider must be codex or claude.');
  return [provider + (process.platform === 'win32' ? '.exe' : '')];
}

export async function probeProvider({ provider, command = providerCommand(provider), signal }) {
  if (!providers.has(provider)) throw new Error('Provider must be codex or claude.');
  const { stdout } = await runOwnedProcess(command, ['--version'], { signal, timeoutMs: 10000, maxOutputBytes: 16384 });
  return { provider, version: stdout.trim().slice(0, 200) };
}

export function createCliGenerator({ provider, directory, command = providerCommand(provider), timeoutMs = 120000 }) {
  if (!providers.has(provider) || typeof directory !== 'string' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
    throw new Error('Provide a supported provider, private working directory, and 1000–300000 ms timeout.');
  return async ({ prompt, schema, signal }) => {
    if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > 240000 || !object(schema))
      throw new Error('Provider prompt or output schema is invalid.');
    signal?.throwIfAborted();
    const scratch = await mkdtemp(path.join(path.resolve(directory), 'call-'));
    const schemaPath = path.join(scratch,'schema.json');
    const resultPath = path.join(scratch,'result.json');
    let diagnostic;
    try {
      await writeFile(schemaPath, JSON.stringify(schema), { flag:'wx', mode:0o600 });
      let args;
      if (provider === 'codex') args = [
        'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--disable', 'shell_tool', '--disable', 'unified_exec',
        '--disable', 'apps', '--disable', 'plugins', '--disable', 'multi_agent',
        '-c', 'web_search="disabled"', '-c', 'approval_policy="never"',
        '--output-schema', schemaPath, '--output-last-message', resultPath, '--json', '-',
      ];
      else args = [
        '--print', '--safe-mode', '--restricted', '--tools', '', '--disable-slash-commands',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      ];
      const result = await runOwnedProcess(command, args, { cwd:scratch, input:prompt, signal, timeoutMs });
      diagnostic=result.stdout.slice(-16000);
      let data, usage = null;
      if (provider === 'codex') {
        const events = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
        if (!events.some(x=>x.type==='turn.completed') || events.some(x=>
          ['error','turn.failed'].includes(x.type) ||
          (x.item && !['reasoning','agent_message'].includes(x.item.type))))
          throw new Error('Codex did not complete a tool-disabled text generation.');
        const resultStat = await stat(resultPath);
        if (!resultStat.isFile() || resultStat.size > 128 * 1024) throw new Error('Provider result exceeded its byte limit.');
        data = JSON.parse(await readFile(resultPath,'utf8'));
        usage = events.findLast(x=>x.type==='turn.completed')?.usage ?? null;
      } else {
        const envelope = JSON.parse(result.stdout);
        if (envelope.is_error || envelope.type !== 'result' || envelope.subtype !== 'success')
          throw new Error('Claude did not complete its structured response.');
        data = envelope.structured_output ?? JSON.parse(envelope.result);
        usage = envelope.usage ?? null;
      }
      if (!object(data) || Buffer.byteLength(JSON.stringify(data)) > 128 * 1024)
        throw new Error('Provider must return a bounded JSON object.');
      // Return only data and usage, never the transcript, auth state, or CLI stderr.
      return { data, provider, usage, pid:result.pid };
    } catch(error) {
      if(provider==='claude' && error.code==='PROVIDER_EXIT') {
        try {
          const response=JSON.parse(error.diagnostic);
          if(response.api_error==='usage_limit_reached') {
            error.code='PROVIDER_USAGE_LIMIT';
            error.message='Claude usage limit reached. Wait for its reset or explicitly choose another available provider.';
          }
        } catch {}
      }
      // Diagnostics may contain input or provider error details. Keep them only
      // in the private worker directory, never in stdout or the shared report.
      const diagnosticPath=path.join(path.resolve(directory),`failure-${randomUUID()}.json`);
      writePrivateJson(diagnosticPath,{provider,code:error.code||'PROVIDER_RESPONSE',
        message:error.message,detail:error.diagnostic||diagnostic||null});
      throw error;
    } finally {
      // This is the fresh scratch directory allocated above, inside an operator-owned directory.
      if (!path.resolve(scratch).startsWith(path.resolve(directory)+path.sep))
        throw new Error('Unexpected provider scratch directory.');
      await rm(scratch,{recursive:true,force:true});
    }
  };
}
