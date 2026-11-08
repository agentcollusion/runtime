import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/server.mjs';
import { RuntimeClient } from '../src/client.mjs';
import { verifyEvidence } from '../src/evidence.mjs';
import { writePrivateJson } from '../src/security.mjs';

const agentScript = fileURLToPath(new URL('./demo-agent.mjs', import.meta.url));

function agent(role, configPath, taskId, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [agentScript, role, configPath, taskId],
      {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      },
    );
    let output = '';
    const collect = (chunk) => {
      output = (output + chunk.toString()).slice(-16000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`${role} adapter failed (${code}): ${output}`)),
    );
  });
}

export async function runDemo({ directory } = {}) {
  const root = directory
    ? path.resolve(directory)
    : await mkdtemp(path.resolve('agentcollusion-demo-'));
  if (directory) await mkdir(root, { recursive: false, mode: 0o700 });
  const host = await createRuntime({
    directory: path.join(root, 'runtime'),
    port: 0,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let workers = [];
  try {
    const owner = new RuntimeClient({
      url: host.url,
      token: host.store.identity.token,
      ca: host.certificate,
    });
    const files = {};
    for (const id of ['demo-coordinator', 'demo-writer']) {
      const credential = await owner.createAgent({ id });
      const destination = path.join(host.store.directory, 'clients');
      await mkdir(destination, { recursive: true, mode: 0o700 });
      files[id] = path.join(destination, `${id}.json`);
      writePrivateJson(files[id], {
        url: host.url,
        token: credential.token,
        ca: host.certificate,
        agentId: id,
        fingerprint: host.store.keyFingerprint,
      });
    }
    const submitted = await owner.submit(
      {
        to: 'demo-coordinator',
        title: 'Produce reviewed release notes',
        input: {
          release: 'Example v1',
          changes: [
            'Add scoped task delegation',
            'Persist artifact hashes',
            'Reject stale claims',
          ],
        },
        permissions: [
          { operation: 'task.submit', resource: 'demo-writer' },
          { operation: 'artifact.write', resource: 'draft' },
          { operation: 'artifact.write', resource: 'release-notes' },
        ],
        requiredArtifacts: ['release-notes'],
        delegable: true,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      },
      'demo-release-notes',
    );
    workers = [
      agent(
        'writer',
        files['demo-writer'],
        submitted.task.id,
        controller.signal,
      ),
      agent(
        'coordinator',
        files['demo-coordinator'],
        submitted.task.id,
        controller.signal,
      ),
    ];
    const messages = await Promise.all(workers);
    const final = await owner.task(submitted.task.id);
    if (final.state !== 'completed')
      throw new Error(`Demo ended in ${final.state}.`);
    const artifact = await owner.artifact(final.id, 'release-notes');
    const receipt = await owner.receipt(final.id),
      audit = await owner.audit();
    verifyEvidence(receipt, host.store.keyFingerprint);
    verifyEvidence(audit, host.store.keyFingerprint);
    await writeFile(path.join(root, 'release-notes.md'), artifact.value, {
      flag: 'wx',
    });
    await writeFile(
      path.join(root, 'receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      { flag: 'wx' },
    );
    await writeFile(
      path.join(root, 'audit.json'),
      JSON.stringify(audit, null, 2) + '\n',
      { flag: 'wx' },
    );
    await writeFile(
      path.join(root, 'trusted-fingerprint.txt'),
      host.store.keyFingerprint + '\n',
      { flag: 'wx' },
    );
    return {
      evidenceKind: 'deterministic-multiprocess-harness',
      state: final.state,
      taskId: final.id,
      directory: root,
      fingerprint: host.store.keyFingerprint,
      messages,
      files: [
        'release-notes.md',
        'receipt.json',
        'audit.json',
        'trusted-fingerprint.txt',
      ],
      note: 'Two independent Node.js processes used the real pinned-TLS API. No model inference ran. The host has stopped; private credentials remain in runtime/.',
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await Promise.allSettled(workers);
    await host.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runDemo()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
