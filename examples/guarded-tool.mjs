import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeClient } from '../src/client.mjs';
import { createAuditCheckpoint, verifyAuditExtension, verifyReceiptInAudit } from '../src/evidence.mjs';
import { createRuntime } from '../src/server.mjs';

const prefix = path.resolve(os.tmpdir(), 'agentcollusion-tool-demo-');
const directory = await mkdtemp(prefix);
let host;
try {
  let calls = 0;
  host = await createRuntime({
    directory,
    port: 0,
    tools: {
      'check-manifest': {
        run({ input }) {
          calls++;
          const name = input?.name;
          return { valid: typeof name === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(name) };
        },
      },
    },
  });
  const connect = (credential) => new RuntimeClient({ url: host.url, ca: host.certificate, token: credential });
  const owner = connect(host.store.identity.token);
  const { token: workerCredential } = await owner.createAgent({ id: 'manifest-reviewer' });
  const reviewer = connect(workerCredential);
  const { task } = await owner.submit({
    to: 'manifest-reviewer',
    title: 'Check a local manifest',
    input: { name: 'example-project' },
    permissions: [{ operation: 'tool.invoke', resource: 'check-manifest' }],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const { claimToken } = await reviewer.claim(task.id);
  const trustedFingerprint = host.store.keyFingerprint;
  const checkpoint = createAuditCheckpoint(await owner.audit(), trustedFingerprint);
  await assert.rejects(
    reviewer.invokeTool(task.id, 'ungranted-tool', {}, claimToken),
    (error) => error.code === 'SCOPE_DENIED',
  );
  const first = await reviewer.invokeTool(task.id, 'check-manifest', { name: 'example-project' }, claimToken);
  const repeat = await reviewer.invokeTool(task.id, 'check-manifest', { name: 'example-project' }, claimToken);
  assert.equal(first.state, 'returned');
  assert.equal(first.result.valid, true);
  assert.equal(repeat.id, first.id);
  assert.equal(repeat.replayed, true);
  assert.equal(calls, 1);
  await reviewer.complete(task.id, { manifestValid: first.result.valid, invocationId: first.id }, claimToken);
  const audit = await owner.audit();
  assert.equal(verifyAuditExtension(audit, trustedFingerprint, checkpoint).advanced, true);
  assert.equal(verifyReceiptInAudit(await owner.receipt(task.id), audit, trustedFingerprint, checkpoint).valid, true);
  console.log(JSON.stringify({
    state: 'completed', invocationId: first.id, dispatches: calls,
    outOfScope: 'SCOPE_DENIED', replayed: repeat.replayed, receiptInAudit: true,
    note: 'Two credentials and the real loopback API in one process. Local validation only; no model or external side effect.',
  }, null, 2));
} finally {
  await host?.close();
  assert.ok(path.resolve(directory).startsWith(prefix));
  await rm(directory, { recursive: true, force: true });
}
