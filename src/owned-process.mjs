import { spawn } from 'node:child_process';
import path from 'node:path';

// The executable and prefix arguments are trusted operator configuration.
// Peer inputs go to stdin only. Never enable a shell for a task's text.
export function runOwnedProcess(command, args, {
  cwd, input = '', signal, timeoutMs = 120000, maxOutputBytes = 4 * 1024 * 1024,
} = {}) {
  if (!Array.isArray(command) || !command.length ||
      command.some(x => typeof x !== 'string' || !x || x.includes('\0')) ||
      !Array.isArray(args) || args.some(x => typeof x !== 'string' || x.includes('\0')) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)
    throw new Error('Provide an executable, argument array, and positive process limits.');
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command[0]))
    throw new Error('Use the native provider executable on Windows, not a shell launcher.');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    let stderr = '', bytes = 0, failure, forceTimer;
    const stop = error => {
      if (failure) return;
      failure = error;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        killer.on('error', () => child.kill('SIGKILL'));
      } else {
        // Give our worker time to cancel its separately grouped provider child.
        try {
          process.kill(-child.pid, 'SIGTERM');
          forceTimer=setTimeout(()=>{try {process.kill(-child.pid,'SIGKILL');} catch {}},1000);
        } catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => stop(new Error('Provider process was cancelled.'));
    const timer = setTimeout(() => stop(new Error('Provider process timed out.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop(new Error('Provider output exceeded its byte limit.'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-16000); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) {
        // Provider output can contain private input or credentials. Do not echo it.
        const error = new Error(`Provider process exited with code ${code}. Check the provider CLI login and supported flags separately.`);
        error.code = 'PROVIDER_EXIT';
        error.diagnostic = stderr || Buffer.concat(chunks).toString('utf8').slice(-16000);
        reject(error);
      } else resolve({ stdout:Buffer.concat(chunks).toString('utf8'), stderr, pid: child.pid });
    });
  });
}
