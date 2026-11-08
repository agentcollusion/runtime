import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RuntimeClient } from '../src/client.mjs';
import { digest, verifyEvidence } from '../src/evidence.mjs';
import { createRuntime } from '../src/server.mjs';

async function fixture(t, tools) {
  const prefix = path.resolve(os.tmpdir(), 'agentcollusion-guarded-tools-');
  const directory = await mkdtemp(prefix);
  let clock = Date.now();
  let host;
  const start = async () => host = await createRuntime({ directory: path.join(directory, 'runtime'), port: 0, now: () => clock, tools });
  const stop = async () => {
    if (host) await host.close();
    host = undefined;
  };
  t.after(async () => {
    await stop();
    assert.ok(path.resolve(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  await start();
  const connect = (credential) => new RuntimeClient({ url: host.url, ca: host.certificate, token: credential });
  const owner = connect(host.store.identity.token);
  const { token: agentCredential } = await owner.createAgent({ id: 'worker' });
  const agent = connect(agentCredential);
  const submit = (scope) => owner.submit({
    to: 'worker', title: 'Verify the manifest', input: { test: true },
    permissions: scope.map(resource => ({ operation: 'tool.invoke', resource })),
    expiresAt: new Date(clock + 120000).toISOString(),
  });
  return {
    directory, owner, agent, submit, start, stop, connect, agentCredential,
    get host() { return host; },
    advance(ms) { clock += ms; },
  };
}

const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('the live grant and claim fence one durable tool invocation across generations', async (t) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let dispatches = 0;
  const f = await fixture(t, {
    'manifest-check': { async run({ input, generation }) {
      dispatches++;
      entered.resolve();
      await release.promise;
      return { ok: input.kind === 'owned-manifest', originGeneration: generation, internalMarker: 'private-result-body' };
    } },
  });
  const { task } = await f.submit(['manifest-check']);
  const first = await f.agent.claim(task.id, 10000);
  const input = { kind: 'owned-manifest', note: 'private-tool-input' };
  await rejectsCode(f.agent.invokeTool(task.id, 'not-granted', input, first.claimToken), 'SCOPE_DENIED');
  await rejectsCode(f.agent.invokeTool(task.id, 'manifest-check', input, 'stale'), 'STALE_CLAIM');
  assert.equal(dispatches, 0);
  const firstResult = f.agent.invokeTool(task.id, 'manifest-check', input, first.claimToken);
  // Attach rejection handling before invalidating the first claim.
  const rejected = rejectsCode(firstResult, 'STALE_CLAIM');
  rejected.catch(() => {});
  try {
    await Promise.race([entered.promise, firstResult.then(() => { throw new Error('Tool returned before dispatch.'); })]);
    const auditDuring = await f.owner.audit();
    const started = auditDuring.payload.events.find(event => event.type === 'tool.started');
    assert.equal(started.actor, 'worker');
    assert.equal(started.detail.inputSha256, digest(input));
    const concurrent = await f.agent.invokeTool(task.id, 'manifest-check', input, first.claimToken);
    assert.equal(concurrent.state, 'running');
    assert.equal(concurrent.id, started.detail.invocationId);
    assert.equal(concurrent.replayed, true);
    f.advance(10001);
    const later = await f.agent.claim(task.id, 30000);
    release.resolve();
    await rejected;
    const replay = await f.agent.invokeTool(task.id, 'manifest-check', input, later.claimToken);
    assert.equal(replay.id, concurrent.id);
    assert.equal(replay.state, 'returned');
    assert.equal(replay.result.originGeneration, first.task.generation);
    assert.equal(replay.result.ok, true);
    assert.equal(replay.resultSha256, digest(replay.result));
    await rejectsCode(f.agent.invokeTool(task.id, 'manifest-check', { changed: true }, later.claimToken), 'TOOL_INPUT_CONFLICT');
    await rejectsCode(f.agent.inspectTool(replay.id), 'OWNER_REQUIRED');
    const inspected = await f.owner.inspectTool(replay.id);
    assert.equal(inspected.resultSha256, replay.resultSha256);
    assert.equal(dispatches, 1);
    const audit = await f.owner.audit();
    assert.equal(verifyEvidence(audit, f.host.store.keyFingerprint).valid, true);
    assert.equal(audit.payload.events.filter(event => event.type === 'tool.started').length, 1);
    assert.equal(audit.payload.events.find(event => event.type === 'tool.returned').actor, '@runtime');
    assert.doesNotMatch(JSON.stringify(audit), /private-result-body|private-tool-input/);
  } finally {
    release.resolve();
    await rejected.catch(() => {});
  }
});

test('a local effect followed by a timeout remains uncertain across restart and is never repeated', async (t) => {
  let pathToEffect;
  const settle = Promise.withResolvers();
  const f = await fixture(t, {
    'write-fixture': { timeoutMs: 1000, async run() {
      await appendFile(pathToEffect, 'effect\n');
      // Deliberately ignore the advisory abort to model a late effect response.
      await settle.promise;
      return { ok: true };
    } },
  });
  try {
    pathToEffect = path.join(f.directory, 'owned-effect.txt');
    const { task } = await f.submit(['write-fixture']);
    const { claimToken } = await f.agent.claim(task.id, 30000);
    const first = await f.agent.invokeTool(task.id, 'write-fixture', {}, claimToken);
    assert.equal(first.state, 'uncertain');
    assert.equal(first.reason, 'timeout');
    assert.equal(await readFile(pathToEffect, 'utf8'), 'effect\n');
    assert.equal((await f.agent.invokeTool(task.id, 'write-fixture', {}, claimToken)).id, first.id);
    const observation = { disposition: 'effect_observed', evidenceSha256: digest({ fixture: 'effect' }) };
    await rejectsCode(f.owner.reconcileTool(first.id, observation), 'TOOL_STILL_RUNNING');
    settle.resolve();
    await f.stop();
    await f.start();
    const agent = f.connect(f.agentCredential);
    const replay = await agent.invokeTool(task.id, 'write-fixture', {}, claimToken);
    assert.equal(replay.id, first.id);
    assert.equal(replay.state, 'uncertain');
    assert.equal(replay.replayed, true);
    assert.equal(await readFile(pathToEffect, 'utf8'), 'effect\n');
    await rejectsCode(agent.reconcileTool(first.id, observation), 'OWNER_REQUIRED');
    const owner = f.connect(f.owner.token);
    const resolved = await owner.reconcileTool(first.id, observation);
    assert.equal(resolved.state, 'uncertain');
    assert.equal(resolved.reconciliation.disposition, 'effect_observed');
    assert.equal((await owner.reconcileTool(first.id, observation)).replayed, true);
    await rejectsCode(owner.reconcileTool(first.id, { ...observation, disposition: 'effect_not_observed' }), 'RECONCILIATION_CONFLICT');
    const audit = await owner.audit();
    assert.equal(audit.payload.events.filter(event => event.type === 'tool.reconciled').length, 1);
    assert.equal(verifyEvidence(audit, f.host.store.keyFingerprint).valid, true);
  } finally {
    settle.resolve();
  }
});

test('an interrupted durable start is uncertain and an audit failure prevents dispatch', async (t) => {
  let calls = 0;
  const f = await fixture(t, { check: { run() { calls++; return { ok: true }; } } });
  const { task } = await f.submit(['check']);
  const { claimToken } = await f.agent.claim(task.id, 30000);
  const current = f.host.store.toolContext('worker', task.id, 'check', claimToken);
  const originalEvent = f.host.store.event.bind(f.host.store);
  f.host.store.event = (...args) => {
    if (args[1] === 'tool.started') throw new Error('fixture cannot persist intent');
    return originalEvent(...args);
  };
  await rejectsCode(f.agent.invokeTool(task.id, 'check', {}, claimToken), 'INTERNAL_ERROR');
  assert.equal(f.host.store.findToolCall(task.id, 'check'), null);
  assert.equal(calls, 0);
  f.host.store.event = originalEvent;
  // Model process loss after the atomic intent write and before a final write.
  const abandoned = f.host.store.startToolCall('worker', current, 'check', digest({}));
  await f.stop();
  await f.start();
  const replay = await f.connect(f.agentCredential).invokeTool(task.id, 'check', {}, claimToken);
  assert.equal(replay.id, abandoned.id);
  assert.equal(replay.state, 'uncertain');
  assert.equal(replay.reason, 'interrupted');
  assert.equal(calls, 0);
  // A damaged materialized row must not erase the durable invocation identity.
  f.host.store.db.prepare('DELETE FROM tool_calls WHERE id = ?').run(abandoned.id);
  await rejectsCode(f.connect(f.agentCredential).invokeTool(task.id, 'check', {}, claimToken), 'TOOL_STATE');
  assert.equal(calls, 0);
  const second = await f.connect(f.owner.token).submit({
    to: 'worker', title: 'Return a result', input: {},
    permissions: [{ operation: 'tool.invoke', resource: 'check' }],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const worker = f.connect(f.agentCredential);
  const claim = await worker.claim(second.task.id);
  const emit = f.host.store.event.bind(f.host.store);
  f.host.store.event = (...args) => {
    if (args[1] === 'tool.returned') throw new Error('fixture cannot persist outcome');
    return emit(...args);
  };
  await rejectsCode(worker.invokeTool(second.task.id, 'check', {}, claim.claimToken), 'TOOL_OUTCOME_UNRECORDED');
  f.host.store.event = emit;
  assert.equal(calls, 1);
  assert.equal((await worker.invokeTool(second.task.id, 'check', {}, claim.claimToken)).state, 'uncertain');
  assert.equal(calls, 1);
});

test('process loss after an effect leaves one durable invocation and no automatic re-dispatch', { timeout: 45000 }, async (t) => {
  const prefix = path.resolve(os.tmpdir(), 'agentcollusion-tool-crash-');
  const root = await mkdtemp(prefix);
  const directory = path.join(root, 'runtime');
  const effectFile = path.join(root, 'effect.txt');
  const child = fork(fileURLToPath(new URL('fixtures/tool-crash-child.mjs', import.meta.url)), [directory, effectFile], {
    execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  exited.catch(() => {});
  let recovered;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => {});
    await recovered?.close();
    assert.ok(path.resolve(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(20000) });
  assert.equal(ready.phase, 'ready');
  const { url, ca } = ready;
  const owner = new RuntimeClient({ url, ca, token: ready.ownerCredential });
  const { token: agentCredential } = await owner.createAgent({ id: 'fixture-agent' });
  const worker = new RuntimeClient({ url, ca, token: agentCredential });
  const { task } = await owner.submit({
    to: 'fixture-agent', title: 'Apply a fixture once', input: {},
    permissions: [{ operation: 'tool.invoke', resource: 'apply-fixture' }],
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  const { claimToken } = await worker.claim(task.id, 60000);
  const effectWritten = once(child, 'message', { signal: AbortSignal.timeout(12000) });
  const response = worker.invokeTool(task.id, 'apply-fixture', { fixture: 1 }, claimToken)
    .then(value => ({ returned: true, value }), error => ({ returned: false, error }));
  const [effect] = await effectWritten;
  assert.equal(effect.phase, 'effect-written');
  const audit = await owner.audit();
  const started = audit.payload.events.find(event => event.type === 'tool.started');
  assert.equal(started.taskId, task.id);
  assert.equal(child.kill('SIGKILL'), true);
  await exited;
  assert.equal((await response).returned, false);
  let reexecuted = 0;
  recovered = await createRuntime({ directory, port: 0, tools: {
    'apply-fixture': { async run() { reexecuted++; await appendFile(effectFile, 'effect\n'); return { applied: true }; } },
  } });
  const after = new RuntimeClient({ url: recovered.url, ca: recovered.certificate, token: agentCredential });
  const replay = await after.invokeTool(task.id, 'apply-fixture', { fixture: 1 }, claimToken);
  assert.equal(replay.id, started.detail.invocationId);
  assert.equal(replay.state, 'uncertain');
  assert.equal(replay.reason, 'interrupted');
  assert.equal(reexecuted, 0);
  assert.equal(await readFile(effectFile, 'utf8'), 'effect\n');
});
