import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeClient } from '../src/client.mjs';
import { createAuditCheckpoint, verifyReceiptArtifact, verifyReceiptInAudit } from '../src/evidence.mjs';
import { createRuntime } from '../src/server.mjs';
import { inspectAuditTrace } from '../src/trace.mjs';

const reportFormat = 'agentcollusion-developer-harness/v1';
const expectedCode = (code) => (error) => error?.code === code;
const artifactType = 'text/plain';
const effect = 'One synthetic delivery attempt.\n';

export async function runHarness({ directory } = {}) {
  const root = directory ? path.resolve(directory) : await mkdtemp(path.resolve('agentcollusion-harness-'));
  if (directory) await mkdir(root, { mode: 0o700 });
  const stateDirectory = path.join(root, 'runtime');
  const effectPath = path.join(root, 'synthetic-effect.txt');
  const write = (name, body) => writeFile(path.join(root, name), body, { flag: 'wx', mode: 0o600 });
  const save = (name, value) => write(name, JSON.stringify(value, null, 2) + '\n');
  const scenarios = [];
  let clock = Date.now(), host, dispatches = 0;
  const tools = {
    'record-delivery': {
      async run() {
        dispatches++;
        await write('synthetic-effect.txt', effect);
        // A handler can perform a side effect before losing its response.
        throw new Error('Synthetic missing handler result');
      },
    },
  };
  const open = () => createRuntime({ directory: stateDirectory, port: 0, now: () => clock, tools });
  const connect = (token) => new RuntimeClient({ url: host.url, ca: host.certificate, token });
  const scenario = async (id, run) => {
    try {
      scenarios.push({ id, status: 'passed', ...await run() });
    } catch (error) {
      throw new Error(`Harness scenario ${id} failed: ${error.message}`, { cause: error });
    }
  };

  try {
    host = await open();
    const fingerprint = host.store.keyFingerprint;
    const ownerToken = host.store.identity.token;
    let owner = connect(ownerToken);
    const { token: reviewerToken } = await owner.createAgent({ id: 'harness-reviewer' });
    const { token: writerToken } = await owner.createAgent({ id: 'harness-writer' });
    let reviewer = connect(reviewerToken);
    const writer = connect(writerToken);
    const checkpoint = createAuditCheckpoint(await owner.audit(), fingerprint);
    const { task } = await owner.submit({
      to: 'harness-reviewer', title: 'Review a synthetic handoff', input: { label: 'harness' },
      permissions: [
        { operation: 'task.submit', resource: 'harness-writer' },
        { operation: 'artifact.write', resource: 'draft' },
        { operation: 'artifact.write', resource: 'delivery' },
        { operation: 'tool.invoke', resource: 'record-delivery' },
      ],
      requiredArtifacts: ['delivery'], delegable: true,
      expiresAt: new Date(clock + 60000).toISOString(),
    }, 'harness-review');
    const original = await reviewer.claim(task.id, 5000);
    let current, childId, invocationId;
    const draftValue = 'A deterministic artifact from the writer.\n';

    await scenario('delegated-handoff', async () => {
      const { task: child } = await reviewer.submit({
        to: 'harness-writer', title: 'Draft a fixture', input: task.input,
        authorityId: task.grantId, permissions: [{ operation: 'artifact.write', resource: 'draft' }],
        requiredArtifacts: ['draft'], expiresAt: task.expiresAt,
      }, 'harness-draft', original.claimToken);
      childId = child.id;
      assert.ok((await writer.inbox()).tasks.some((candidate) => candidate.id === childId));
      const { claimToken } = await writer.claim(childId);
      await writer.putArtifact(childId, 'draft', draftValue, claimToken, artifactType);
      await writer.complete(childId, { drafted: true }, claimToken);
      assert.equal((await reviewer.artifact(childId, 'draft')).value, draftValue);
      return { childTaskId: childId };
    });

    await scenario('scope-denial', async () => {
      await assert.rejects(reviewer.invokeTool(task.id, 'ungranted-tool', {}, original.claimToken), expectedCode('SCOPE_DENIED'));
      assert.equal(dispatches, 0);
      return { observedCode: 'SCOPE_DENIED' };
    });

    await scenario('stale-claim-fencing', async () => {
      // Move the fixture clock so this check does not depend on sleeping or host speed.
      clock += 5001;
      current = await reviewer.claim(task.id);
      await assert.rejects(reviewer.putArtifact(task.id, 'delivery', draftValue, original.claimToken, artifactType), expectedCode('STALE_CLAIM'));
      assert.notEqual(current.claimToken, original.claimToken);
      return { observedCode: 'STALE_CLAIM' };
    });

    await scenario('uncertain-tool-replay', async () => {
      const first = await reviewer.invokeTool(task.id, 'record-delivery', {}, current.claimToken);
      assert.equal(first.state, 'uncertain');
      assert.equal(first.reason, 'handler_error');
      invocationId = first.id;
      await host.close();
      host = undefined;
      host = await open();
      assert.equal(host.store.keyFingerprint, fingerprint);
      owner = connect(ownerToken);
      reviewer = connect(reviewerToken);
      const repeat = await reviewer.invokeTool(task.id, 'record-delivery', {}, current.claimToken);
      assert.equal(repeat.id, invocationId);
      assert.equal(repeat.state, 'uncertain');
      assert.equal(repeat.replayed, true);
      assert.equal(dispatches, 1);
      const observed = await readFile(effectPath);
      assert.equal(observed.toString('utf8'), effect);
      const { reconciliation } = await owner.reconcileTool(invocationId, {
        disposition: 'effect_observed', evidenceSha256: createHash('sha256').update(observed).digest('hex'),
      });
      assert.equal(reconciliation.disposition, 'effect_observed');
      return { invocationId, state: repeat.state, dispatches, restarted: true, ownerObservation: reconciliation.disposition };
    });

    const delivery = draftValue + 'Reviewed by the synthetic fixture.\n';
    await scenario('offline-evidence', async () => {
      await reviewer.putArtifact(task.id, 'delivery', delivery, current.claimToken, artifactType);
      await reviewer.complete(task.id, { invocationId, reviewed: true }, current.claimToken);
      const audit = await owner.audit();
      const receipt = await owner.receipt(task.id);
      const trace = inspectAuditTrace(audit, { trustedFingerprint: fingerprint, checkpoint, taskId: task.id });
      assert.equal(trace.advanced, true);
      assert.equal(trace.events.filter((event) => event.type === 'tool.started').length, 1);
      assert.equal(trace.events.filter((event) => event.type === 'tool.reconciled').length, 1);
      assert.equal(verifyReceiptInAudit(receipt, audit, fingerprint, checkpoint).valid, true);
      await write('delivery.txt', delivery);
      const candidate = { id: 'delivery', mediaType: artifactType, value: await readFile(path.join(root, 'delivery.txt'), 'utf8') };
      const verified = verifyReceiptArtifact(receipt, fingerprint, candidate, { audit, checkpoint });
      assert.throws(() => verifyReceiptArtifact(receipt, fingerprint, { ...candidate, value: candidate.value + 'changed' }, { audit, checkpoint }), /does not match/);
      await save('audit.json', audit);
      await save('checkpoint.json', checkpoint);
      await save('receipt.json', receipt);
      await save('trace.json', trace);
      await write('fingerprint.txt', fingerprint + '\n');
      return { receiptInAudit: true, auditExtended: true, verifiedArtifactSha256: verified.sha256, tamperingRejected: true };
    });

    const report = {
      format: reportFormat, status: 'passed', evidenceKind: 'synthetic-loopback',
      directory: root, taskId: task.id, fingerprint, scenarios,
      files: ['audit.json', 'checkpoint.json', 'delivery.txt', 'fingerprint.txt', 'receipt.json', 'report.json', 'synthetic-effect.txt', 'trace.json'],
      privateState: 'runtime/',
    };
    await host.close();
    host = undefined;
    await save('report.json', report);
    return report;
  } finally {
    await host?.close();
  }
}
