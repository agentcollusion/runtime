import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RuntimeClient } from '../src/client.mjs';
import { createAuditCheckpoint } from '../src/evidence.mjs';
import { createRuntime } from '../src/server.mjs';
import { inspectAuditTrace } from '../src/trace.mjs';

test('trace verifies unselected events before projecting and paging a task', async (t) => {
  const prefix = path.resolve(os.tmpdir(), 'agentcollusion-trace-test-');
  const root = await mkdtemp(prefix);
  let host;
  t.after(async () => {
    await host?.close();
    assert.ok(path.resolve(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  host = await createRuntime({ directory: path.join(root, 'runtime'), port: 0 });
  const connect = (credential) => new RuntimeClient({ url: host.url, ca: host.certificate, token: credential });
  const owner = connect(host.store.identity.token);
  const { token: workerCredential } = await owner.createAgent({ id: 'writer' });
  const worker = connect(workerCredential);
  const submit = (title) => owner.submit({
    to: 'writer', title, input: { secretMarker: 'private-input-body' },
    permissions: [{ operation: 'artifact.write', resource: 'draft' }],
    requiredArtifacts: ['draft'], expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  const { task } = await submit('Trace this handoff');
  const { task: other } = await submit('Another handoff');
  const trustedFingerprint = host.store.keyFingerprint;
  const checkpoint = createAuditCheckpoint(await owner.audit(), trustedFingerprint);
  const { claimToken } = await worker.claim(task.id);
  await worker.putArtifact(task.id, 'draft', 'private-artifact-body', claimToken, 'text/plain');
  await worker.complete(task.id, { value: 'private-result-body' }, claimToken);
  const audit = await owner.audit();
  const options = { trustedFingerprint, checkpoint, taskId: task.id, afterSequence: checkpoint.head.sequence, limit: 2 };
  const page = inspectAuditTrace(audit, options);
  assert.equal(page.advanced, true);
  assert.deepEqual(page.head, audit.payload.head);
  assert.deepEqual(page.retainedHead, checkpoint.head);
  assert.deepEqual(page.events.map(event => event.type), ['task.claimed', 'artifact.created']);
  assert.equal(page.events[0].detail.generation, 1);
  assert.equal(page.events[1].detail.artifactId, 'draft');
  assert.equal(page.selection.matches, 3);
  assert.equal(page.selection.newerRemaining, 1);
  const next = inspectAuditTrace(audit, { ...options, afterSequence: page.selection.nextAfterSequence });
  assert.deepEqual(next.events.map(event => event.type), ['task.completed']);
  assert.equal(next.events[0].detail.artifactCount, 1);
  const latest = inspectAuditTrace(audit, { trustedFingerprint, taskId: task.id, limit: 1 });
  assert.deepEqual(latest.events, next.events);
  assert.equal(latest.selection.olderOmitted, 3);
  assert.doesNotMatch(JSON.stringify(page) + JSON.stringify(next), /private-(input|artifact|result)-body/);
  const altered = structuredClone(audit);
  altered.payload.events.find(event => event.taskId === other.id).detail.to = 'unexpected';
  assert.throws(() => inspectAuditTrace(altered, options), /signature/);
  assert.throws(() => inspectAuditTrace(audit, { ...options, afterSequence: audit.payload.head.sequence + 1 }), /ahead/);
  assert.throws(() => inspectAuditTrace(audit, { ...options, limit: 501 }), /1–500/);
  assert.throws(() => inspectAuditTrace(audit, { ...options, trustedFingerprint: '0'.repeat(64) }), /trusted fingerprint/);

  const cli = fileURLToPath(new URL('../bin/agentcollusion.mjs', import.meta.url));
  const auditFile = path.join(root, 'audit.json'), checkpointFile = path.join(root, 'checkpoint.json');
  await writeFile(auditFile, JSON.stringify(audit));
  await writeFile(checkpointFile, JSON.stringify(checkpoint));
  const output = await promisify(execFile)(process.execPath, [
    cli, 'trace', auditFile, '--fingerprint', trustedFingerprint, '--task', task.id,
    '--after', String(checkpoint.head.sequence), '--limit', '2', '--checkpoint', checkpointFile,
  ], { timeout: 15000 });
  assert.deepEqual(JSON.parse(output.stdout), page);
});
