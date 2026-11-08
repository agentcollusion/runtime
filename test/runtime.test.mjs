import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, truncate } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../src/server.mjs';
import { RuntimeClient } from '../src/client.mjs';
import {
  createAuditCheckpoint,
  digest,
  verifyAuditExtension,
  verifyEvidence,
  verifyReceiptInAudit,
} from '../src/evidence.mjs';
import { runWorker } from '../src/worker.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

async function fixture(t) {
  const root = path.join(os.tmpdir(), 'agentcollusion-runtime-tests-');
  const directory = await mkdtemp(root);
  let time = Date.parse('2026-11-08T00:00:00.000Z');
  const host = await createRuntime({ directory, port: 0, now: () => time });
  t.after(async () => {
    await host.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(root)));
    await rm(directory, { recursive: true, force: true });
  });
  const owner = new RuntimeClient({
    url: host.url,
    token: host.store.identity.token,
    ca: host.certificate,
  });
  const aliceCredential = await owner.createAgent({ id: 'alice' });
  const bobCredential = await owner.createAgent({ id: 'bob' });
  const alice = new RuntimeClient({
    url: host.url,
    token: aliceCredential.token,
    ca: host.certificate,
  });
  const bob = new RuntimeClient({
    url: host.url,
    token: bobCredential.token,
    ca: host.certificate,
  });
  const expiresAt = new Date(time + 600000).toISOString();
  const scope = [{ operation: 'artifact.write', resource: 'report' }];
  const input = {
    to: 'bob',
    title: 'Prepare a release report',
    input: { release: 'v1', noSecrets: true },
    permissions: scope,
    requiredArtifacts: ['report'],
    expiresAt,
  };
  return {
    host,
    owner,
    alice,
    bob,
    input,
    expiresAt,
    scope,
    advance: (ms) => {
      time += ms;
    },
    directory,
    credentials: [aliceCredential, bobCredential],
  };
}
const rejectsCode = (promise, code) =>
  assert.rejects(promise, (error) => error.code === code);

void test('a real HTTP handoff returns an artifact and independently verified receipt', async (t) => {
  const f = await fixture(t);
  const submitted = await f.owner.submit(f.input, 'release-1');
  assert.equal(submitted.task.state, 'queued');
  assert.equal('claimHash' in submitted.task, false);
  const { task, claimToken } = await f.bob.claim(submitted.task.id);
  await rejectsCode(
    f.bob.complete(task.id, { ok: true }, claimToken),
    'ARTIFACTS_MISSING',
  );
  const content = '# v1\n\nA useful report.';
  const artifact = await f.bob.putArtifact(
    task.id,
    'report',
    content,
    claimToken,
    'text/markdown',
  );
  assert.equal(
    artifact.sha256,
    digest({ mediaType: 'text/markdown', value: content }),
  );
  const completed = await f.bob.complete(
    task.id,
    { summary: 'Report delivered.' },
    claimToken,
  );
  assert.equal(completed.state, 'completed');
  assert.equal((await f.owner.artifact(task.id, 'report')).value, content);
  const receipt = await f.owner.receipt(task.id);
  assert.equal(
    verifyEvidence(receipt, f.host.store.keyFingerprint).valid,
    true,
  );
  assert.equal(receipt.payload.task.inputSha256, digest(f.input.input));
  assert.equal('input' in receipt.payload.task, false);
  assert.equal('result' in receipt.payload.task, false);
  const audit = await f.owner.audit();
  assert.equal(verifyEvidence(audit, f.host.store.keyFingerprint).valid, true);
  const serialized = JSON.stringify(audit);
  for (const credential of f.credentials)
    assert.equal(serialized.includes(credential.token), false);
  assert.equal(serialized.includes(claimToken), false);
  assert.equal(serialized.includes(content), false);
  assert.ok(audit.payload.events.some((e) => e.type === 'operation.denied'));
  await rejectsCode(
    f.bob.complete(task.id, { summary: 'Again' }, claimToken),
    'STALE_CLAIM',
  );
});

void test('missing credentials, browser origins and rebinding hosts are rejected', async (t) => {
  const f = await fixture(t);
  await rejectsCode(
    f.owner.raw('GET', '/v1/tasks', undefined, { Authorization: '' }),
    'UNAUTHENTICATED',
  );
  await rejectsCode(
    f.owner.raw('GET', '/v1/tasks', undefined, {
      Origin: 'https://evil.example',
    }),
    'BROWSER_DENIED',
  );
  await rejectsCode(
    f.owner.raw('GET', '/health', undefined, { Host: 'evil.example' }),
    'HOST_DENIED',
  );
  await rejectsCode(f.owner.raw('GET', '/health?leak=1'), 'INVALID_URL');
  await rejectsCode(f.alice.createAgent({ id: 'intruder' }), 'OWNER_REQUIRED');
  await rejectsCode(f.alice.audit(), 'OWNER_REQUIRED');
  assert.throws(
    () =>
      new RuntimeClient({
        url: 'http://evil.example',
        token: f.credentials[0].token,
      }),
  );
});

void test('a third agent cannot list, read, cancel, claim or inspect another handoff', async (t) => {
  const f = await fixture(t);
  const { task } = await f.owner.submit(f.input, 'private-task');
  assert.equal((await f.alice.tasks()).tasks.length, 0);
  await rejectsCode(f.alice.task(task.id), 'TASK_NOT_FOUND');
  await rejectsCode(f.alice.cancel(task.id), 'TASK_NOT_FOUND');
  await rejectsCode(f.alice.claim(task.id), 'TASK_NOT_FOUND');
  await rejectsCode(f.alice.receipt(task.id), 'TASK_NOT_FOUND');
  await rejectsCode(f.alice.artifact(task.id, 'report'), 'TASK_NOT_FOUND');
});

void test('idempotency replays the same task and rejects a colliding request, including after deadline', async (t) => {
  const f = await fixture(t);
  const first = await f.owner.submit(f.input, 'idempotent');
  const replay = await f.owner.submit({ ...f.input }, 'idempotent');
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, first.task.id);
  await rejectsCode(
    f.owner.submit({ ...f.input, title: 'Different' }, 'idempotent'),
    'IDEMPOTENCY_CONFLICT',
  );
  f.advance(600001);
  const late = await f.owner.submit(f.input, 'idempotent');
  assert.equal(late.task.id, first.task.id);
  assert.equal(late.task.state, 'cancelled');
  assert.equal((await f.owner.tasks()).tasks.length, 1);
});

void test('concurrent claims have one winner, and reclaimed work rejects stale writers', async (t) => {
  const f = await fixture(t);
  const { task } = await f.owner.submit(f.input, 'race');
  const attempts = await Promise.allSettled([
    f.bob.claim(task.id, 1000),
    f.bob.claim(task.id, 1000),
  ]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  const first = attempts.find((r) => r.status === 'fulfilled').value;
  await f.bob.putArtifact(
    task.id,
    'report',
    'partial old attempt',
    first.claimToken,
  );
  f.advance(1001);
  const next = await f.bob.claim(task.id);
  assert.equal(next.task.generation, 2);
  assert.equal(next.task.artifacts.length, 0);
  await rejectsCode(
    f.bob.putArtifact(task.id, 'report', 'stale', first.claimToken),
    'STALE_CLAIM',
  );
  await rejectsCode(f.bob.heartbeat(task.id, first.claimToken), 'STALE_CLAIM');
  await rejectsCode(
    f.bob.complete(task.id, { ok: true }, first.claimToken),
    'STALE_CLAIM',
  );
  await rejectsCode(
    f.bob.complete(task.id, { ok: true }, next.claimToken),
    'ARTIFACTS_MISSING',
  );
  await f.bob.putArtifact(task.id, 'report', 'new attempt', next.claimToken);
  await f.bob.complete(task.id, { ok: true }, next.claimToken);
  assert.equal(
    (await f.owner.artifact(task.id, 'report')).value,
    'new attempt',
  );
});

void test('the broker rejects ungranted writes, traversal IDs and artifact replacement', async (t) => {
  const f = await fixture(t);
  const { task } = await f.owner.submit(f.input, 'guarded');
  const { claimToken } = await f.bob.claim(task.id);
  await rejectsCode(
    f.bob.putArtifact(task.id, 'other', 'not allowed', claimToken),
    'SCOPE_DENIED',
  );
  await assert.rejects(
    f.bob.putArtifact(task.id, '../../owner.json', 'not a file', claimToken),
  );
  await f.bob.putArtifact(task.id, 'report', { ok: true }, claimToken);
  await f.bob.putArtifact(task.id, 'report', { ok: true }, claimToken);
  await rejectsCode(
    f.bob.putArtifact(task.id, 'report', { ok: false }, claimToken),
    'ARTIFACT_IMMUTABLE',
  );
  await rejectsCode(f.bob.artifact(task.id, 'report'), 'SCOPE_DENIED');
  assert.equal((await f.owner.artifact(task.id, 'report')).value.ok, true);
  assert.equal(
    JSON.parse(await readFile(path.join(f.directory, 'owner.json'), 'utf8'))
      .runtimeId,
    f.host.store.identity.runtimeId,
  );
});

void test('delegation narrows authority and revocation disables the entire ancestry', async (t) => {
  const f = await fixture(t);
  const root = await f.owner.grant({
    to: 'alice',
    permissions: [...f.scope, { operation: 'task.submit', resource: 'bob' }],
    expiresAt: f.expiresAt,
    delegable: true,
  });
  await rejectsCode(
    f.alice.submit(
      {
        ...f.input,
        authorityId: root.id,
        permissions: [{ operation: 'artifact.write', resource: 'secret' }],
        requiredArtifacts: [],
      },
      'escalate',
    ),
    'SCOPE_DENIED',
  );
  const { task } = await f.alice.submit(
    { ...f.input, authorityId: root.id },
    'delegated',
  );
  const { claimToken } = await f.bob.claim(task.id);
  await rejectsCode(f.bob.revokeGrant(root.id), 'GRANT_DENIED');
  await f.owner.revokeGrant(root.id);
  await rejectsCode(
    f.bob.putArtifact(task.id, 'report', 'revoked', claimToken),
    'STALE_CLAIM',
  );
  assert.equal((await f.alice.task(task.id)).state, 'cancelled');
});

void test('nondelegable grants and longer delegated lifetimes cannot grow authority', async (t) => {
  const f = await fixture(t);
  const scope = [...f.scope, { operation: 'task.submit', resource: 'bob' }];
  const root = await f.owner.grant({
    to: 'alice',
    permissions: scope,
    expiresAt: f.expiresAt,
  });
  await rejectsCode(
    f.alice.submit({ ...f.input, authorityId: root.id }, 'not-delegable'),
    'SCOPE_DENIED',
  );
  const root2 = await f.owner.grant({
    to: 'alice',
    permissions: scope,
    expiresAt: f.expiresAt,
    delegable: true,
  });
  await rejectsCode(
    f.alice.submit(
      {
        ...f.input,
        authorityId: root2.id,
        expiresAt: new Date(Date.parse(f.expiresAt) + 1000).toISOString(),
      },
      'longer',
    ),
    'SCOPE_DENIED',
  );
  f.advance(600001);
  await rejectsCode(
    f.alice.submit(
      {
        ...f.input,
        authorityId: root2.id,
        expiresAt: new Date(Date.parse(f.expiresAt) + 10000).toISOString(),
      },
      'expired-root',
    ),
    'GRANT_INACTIVE',
  );
});

void test('cancellation and agent revocation prevent late effects and terminal rewrites', async (t) => {
  const f = await fixture(t);
  const { task } = await f.owner.submit(f.input, 'cancel');
  const { claimToken } = await f.bob.claim(task.id);
  await rejectsCode(f.bob.cancel(task.id), 'ISSUER_REQUIRED');
  await f.owner.cancel(task.id);
  await rejectsCode(
    f.bob.putArtifact(task.id, 'report', 'too late', claimToken),
    'STALE_CLAIM',
  );
  await rejectsCode(f.owner.cancel(task.id), 'TASK_TERMINAL');
  const second = await f.owner.submit(f.input, 'revoked-agent');
  await f.owner.revokeAgent('bob');
  await rejectsCode(f.bob.claim(second.task.id), 'UNAUTHENTICATED');
  assert.equal((await f.owner.task(second.task.id)).state, 'cancelled');
});

void test('revocation also rejects a request whose authenticated body is still pending', async (t) => {
  const f = await fixture(t);
  const root = await f.owner.grant({
    to: 'alice', permissions: [{ operation: 'task.submit', resource: 'bob' }, ...f.scope],
    expiresAt: f.expiresAt, delegable: true,
  });
  const { task } = await f.alice.submit({ ...f.input, authorityId: root.id }, 'pending-body');
  let authenticated;
  const entered = new Promise((resolve) => { authenticated = resolve; });
  const authenticate = f.host.store.authenticate.bind(f.host.store);
  f.host.store.authenticate = (token) => {
    const actor = authenticate(token);
    if (actor === 'alice') authenticated();
    return actor;
  };
  let request;
  const response = new Promise((resolve, reject) => {
    request = https.request(`${f.host.url}/v1/tasks/${task.id}/cancel`, {
      method: 'POST', ca: f.host.certificate,
      checkServerIdentity: () => undefined, // Exact fixture certificate is the only trusted CA.
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${f.credentials[0].token}`,
        'Content-Type': 'application/json', 'Content-Length': 2,
      },
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    request.on('error', reject);
    request.flushHeaders();
  });
  try {
    await Promise.race([entered, response.then(() => { throw new Error('Request completed before its body.'); }),
      delay(5000, undefined, { ref: false }).then(() => { throw new Error('Request authentication did not start.'); })]);
    await f.owner.revokeAgent('alice');
    request.end('{}');
    const rejected = await response;
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error.code, 'UNAUTHENTICATED');
    const { payload } = await f.owner.audit();
    assert.equal(payload.events.some((event) => event.type === 'task.cancelled' && event.actor === 'alice'), false);
  } finally {
    request.destroy();
    await response.catch(() => {});
  }
});

void test('heartbeat extends only a current claim and never exceeds the task deadline', async (t) => {
  const f = await fixture(t);
  const { task } = await f.owner.submit(
    { ...f.input, expiresAt: '2026-11-08T00:00:05.000Z' },
    'heartbeat',
  );
  const first = await f.bob.claim(task.id, 1000);
  f.advance(500);
  const renewed = await f.bob.heartbeat(task.id, first.claimToken, 300000);
  assert.equal(renewed.leaseUntil, '2026-11-08T00:00:05.000Z');
  f.advance(5000);
  await rejectsCode(f.bob.heartbeat(task.id, first.claimToken), 'STALE_CLAIM');
});

// Extended by /ship Step 7.
// Value: protects=receipts bind result and artifact digests to their terminal event;
// fails_when=a valid signature bypasses receipt result or artifact consistency checks;
// why_new=existing tamper assertions exercise audit signatures and chain order only;
// seam=none; no_claim=owner honesty or artifact truth (the fixture owner signs deliberately inconsistent payloads)
void test('evidence rejects content changes, an unpinned key and a broken event sequence', async (t) => {
  const f = await fixture(t);
  const audit = await f.owner.audit();
  assert.throws(() => verifyEvidence(audit));
  assert.throws(() => verifyEvidence(audit, 'a'.repeat(64)));
  const forged = structuredClone(audit);
  forged.payload.events[0].actor = 'forged';
  assert.throws(
    () => verifyEvidence(forged, f.host.store.keyFingerprint),
    /signature/,
  );
  const malformed = f.host.store.sign({
    kind: 'audit',
    events: audit.payload.events.slice(1),
    head: audit.payload.head,
  });
  assert.throws(
    () => verifyEvidence(malformed, f.host.store.keyFingerprint),
    /chain/,
  );
  const { task } = await f.owner.submit(f.input, 'receipt-binding');
  const { claimToken } = await f.bob.claim(task.id);
  await f.bob.putArtifact(task.id, 'report', 'A delivered report.', claimToken);
  await f.bob.complete(task.id, { summary: 'Delivered.' }, claimToken);
  const receipt = await f.owner.receipt(task.id);
  for (const field of ['resultSha256', 'artifacts']) {
    const payload = structuredClone(receipt.payload);
    if (field === 'resultSha256') payload.task.resultSha256 = '0'.repeat(64);
    else payload.task.artifacts[0].sha256 = '0'.repeat(64);
    assert.throws(
      () => verifyEvidence(f.host.store.sign(payload), f.host.store.keyFingerprint),
      /result or artifacts do not match/,
    );
  }
  const mismatchedEvent = structuredClone(receipt.payload);
  mismatchedEvent.task.id = 'another-task';
  assert.throws(
    () => verifyEvidence(f.host.store.sign(mismatchedEvent), f.host.store.keyFingerprint),
    /not bound to its terminal task event/,
  );
});

void test('retained checkpoints reject owner-signed rollback and forks; receipt membership is independent', async (t) => {
  const f = await fixture(t);
  const key = f.host.store.keyFingerprint;
  const before = await f.owner.audit();
  const genesis = f.host.store.sign({
    kind: 'audit', events: [], head: { sequence: 0, hash: '0'.repeat(64) },
  });
  assert.equal(verifyAuditExtension(before, key, createAuditCheckpoint(genesis, key)).advanced, true);
  const { task } = await f.owner.submit(f.input, 'checkpoint-handoff');
  const middle = await f.owner.audit();
  const checkpoint = createAuditCheckpoint(middle, key);
  const { claimToken } = await f.bob.claim(task.id);
  await f.bob.putArtifact(task.id, 'report', 'Retain the verified head.', claimToken);
  await f.bob.complete(task.id, { delivered: true }, claimToken);
  const receipt = await f.owner.receipt(task.id);
  const latest = await f.owner.audit();

  assert.equal(verifyAuditExtension(middle, key, checkpoint).advanced, false);
  assert.deepEqual(verifyAuditExtension(latest, key, checkpoint).previousHead, middle.payload.head);
  assert.equal(verifyAuditExtension(latest, key, checkpoint).advanced, true);
  assert.throws(() => verifyAuditExtension(before, key, checkpoint), /rollback/);
  assert.throws(() => verifyAuditExtension(latest, key, { ...checkpoint, runtimeId: 'unrelated' }), /different runtime/);
  assert.throws(() => verifyAuditExtension(latest, key, { ...checkpoint, head: { ...checkpoint.head, sequence: -1 } }), /Invalid retained/);
  assert.throws(() => createAuditCheckpoint(receipt, key), /signed audit/);

  const rewrite = structuredClone(latest.payload);
  rewrite.events[0].actor = 'rewritten-by-the-signer';
  let previousHash = '0'.repeat(64);
  for (const event of rewrite.events) {
    const { hash: _old, ...record } = event;
    record.previousHash = event.previousHash = previousHash;
    previousHash = event.hash = digest(record);
  }
  rewrite.head.hash = previousHash;
  const fork = f.host.store.sign(rewrite);
  assert.equal(verifyEvidence(fork, key).valid, true);
  assert.throws(() => verifyAuditExtension(fork, key, checkpoint), /fork/);
  assert.throws(() => verifyReceiptInAudit(receipt, fork, key), /absent/);
  assert.throws(() => verifyReceiptInAudit(receipt, middle, key, checkpoint), /absent/);
  assert.deepEqual(verifyReceiptInAudit(receipt, latest, key, checkpoint).auditHead, latest.payload.head);

  const cli = fileURLToPath(new URL('../bin/agentcollusion.mjs', import.meta.url));
  const run = (...args) => promisify(execFile)(process.execPath, [cli, ...args], { timeout: 10000 });
  const file = (name) => path.join(f.directory, `${name}.json`);
  for (const [name, value] of [['middle', middle], ['latest', latest], ['receipt', receipt]])
    await writeFile(file(name), JSON.stringify(value));
  await run('checkpoint', file('middle'), '--out', file('checkpoint'), '--fingerprint', key);
  const anchored = await run('verify', file('receipt'), '--audit', file('latest'), '--checkpoint', file('checkpoint'), '--fingerprint', key);
  assert.deepEqual(JSON.parse(anchored.stdout).auditHead, latest.payload.head);
  await assert.rejects(run('verify', file('middle'), '--checkpoint', file('checkpoint'), '--fingerprint', '0'.repeat(64)), /trusted fingerprint/);
  await assert.rejects(run('checkpoint', file('latest'), '--out', file('checkpoint'), '--fingerprint', key), /EEXIST/);
  await writeFile(file('oversized'), '{}');
  await truncate(file('oversized'), 64 * 1024 * 1024 + 1);
  await assert.rejects(run('verify', file('oversized'), '--fingerprint', key), /at most 67108864 bytes/);
});

void test('one host holds the directory lock and persisted state survives a restart', async (t) => {
  const prefix = path.join(os.tmpdir(), 'agentcollusion-restart-tests-');
  const directory = await mkdtemp(prefix);
  let host = await createRuntime({ directory, port: 0 });
  t.after(async () => {
    if (host) await host.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  });
  const owner = new RuntimeClient({
    url: host.url,
    token: host.store.identity.token,
    ca: host.certificate,
  });
  await owner.createAgent({ id: 'persistent' });
  const publicKey = host.store.keyFingerprint;
  await assert.rejects(createRuntime({ directory, port: 0 }), /already in use/);
  await host.close();
  host = null;
  host = await createRuntime({ directory, port: 0 });
  assert.equal(host.store.keyFingerprint, publicKey);
  const nextOwner = new RuntimeClient({
    url: host.url,
    token: host.store.identity.token,
    ca: host.certificate,
  });
  assert.equal((await nextOwner.agents()).agents[0].id, 'persistent');
  assert.equal(verifyEvidence(await nextOwner.audit(), publicKey).valid, true);
});

// Extended by /ship Step 7.
// Value: protects=the HTTP JSON boundary rejects wrong media types, nonobjects and oversized bodies before creating work;
// fails_when=request parsing accepts a nonobject, skips content type or drops the byte limit;
// why_new=existing malformed-input cases reach validated JSON object fields only;
// seam=none; no_claim=malformed raw JSON bytes (RuntimeClient serializes its input)
void test('malformed input receives useful client errors', async (t) => {
  const f = await fixture(t);
  await rejectsCode(
    f.owner.raw('POST', '/v1/tasks', f.input, { 'Content-Type': 'text/plain' }),
    'JSON_REQUIRED',
  );
  for (const value of [null, [], 'not an object'])
    await rejectsCode(f.owner.raw('POST', '/v1/tasks', value), 'INVALID_JSON');
  await rejectsCode(
    f.owner.raw('POST', '/v1/tasks', { padding: 'a'.repeat(400001) }),
    'BODY_TOO_LARGE',
  );
  assert.equal((await f.owner.tasks()).tasks.length, 0);
  await rejectsCode(
    f.owner.submit({ ...f.input, permissions: [] }, 'bad'),
    'INVALID_INPUT',
  );
  await rejectsCode(
    f.owner.submit(
      { ...f.input, expiresAt: '2026-99-99T00:00:00.000Z' },
      'bad2',
    ),
    'INVALID_INPUT',
  );
  await rejectsCode(
    f.owner.submit({ ...f.input, input: 'a'.repeat(70000) }, 'big'),
    'VALUE_TOO_LARGE',
  );
  const { task } = await f.owner.submit(f.input, 'valid');
  const { claimToken } = await f.bob.claim(task.id);
  await rejectsCode(
    f.bob.request(
      'PUT',
      `tasks/${task.id}/artifacts/report`,
      {},
      { 'X-Claim-Token': claimToken },
    ),
    'INVALID_INPUT',
  );
  await rejectsCode(
    f.bob.request(
      'POST',
      `tasks/${task.id}/complete`,
      {},
      { 'X-Claim-Token': claimToken },
    ),
    'INVALID_INPUT',
  );
});

void test('TLS rejects a fake runtime before disclosing any credential or task input', async (t) => {
  const real = await fixture(t);
  const fake = await fixture(t);
  let credentialsObserved = false;
  const authenticate = fake.host.store.authenticate.bind(fake.host.store);
  fake.host.store.authenticate = (token) => {
    credentialsObserved = true;
    return authenticate(token);
  };
  const client = new RuntimeClient({
    url: fake.host.url,
    token: real.host.store.identity.token,
    ca: real.host.certificate,
  });
  await assert.rejects(client.info(), /self.signed|certificate/i);
  assert.equal(credentialsObserved, false);
  await assert.rejects(
    real.owner.raw('GET', `${fake.host.url}/v1/info`),
    /cannot leave/,
  );
  assert.throws(
    () =>
      new RuntimeClient({
        url: real.host.url,
        token: real.host.store.identity.token,
      }),
    /certificate/,
  );
});

void test('deep JSON and unsafe numbers fail without crashing the runtime', async (t) => {
  const f = await fixture(t);
  let deep = {};
  for (let i = 0; i < 70; i++) deep = { nested: deep };
  await rejectsCode(
    f.owner.submit({ ...f.input, input: deep }, 'deep'),
    'INVALID_JSON',
  );
  await rejectsCode(
    f.owner.submit(
      { ...f.input, input: Number.MAX_SAFE_INTEGER + 1 },
      'unsafe-number',
    ),
    'INVALID_JSON',
  );
  assert.equal((await f.owner.info()).actor, 'owner');
});

void test('the bring-your-own-agent worker renews its lease and delivers required artifacts', async (t) => {
  const f = await fixture(t);
  const { task } = await f.owner.submit(f.input, 'worker-loop');
  const controller = new AbortController();
  const failures = [];
  const worker = runWorker({
    client: f.bob,
    signal: controller.signal,
    leaseMs: 3000,
    pollMs: 50,
    onError: (error) => failures.push(error),
    async handle({ task: received, signal, artifact }) {
      assert.equal(received.id, task.id);
      f.advance(500);
      await delay(1200, undefined, { signal });
      await artifact('report', 'A worker-produced report.', 'text/plain');
      return { summary: 'Delivered by the worker adapter.' };
    },
  });
  try {
    assert.equal(
      (await f.owner.wait(task.id, { timeoutMs: 5000, intervalMs: 50 })).state,
      'completed',
    );
    assert.equal(failures.length, 0);
    assert.ok(
      (await f.owner.audit()).payload.events.some(
        (event) => event.type === 'task.heartbeat',
      ),
    );
  } finally {
    controller.abort();
    await worker;
  }
});

void test('an audit failure rolls back state changes instead of performing an unrecorded action', async (t) => {
  const f = await fixture(t);
  f.host.store.db
    .prepare(
      'INSERT INTO meta (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
    )
    .run('audit_bytes', String(32 * 1024 * 1024));
  await rejectsCode(
    f.owner.createAgent({ id: 'must-not-exist' }),
    'AUDIT_CAPACITY',
  );
  assert.equal(f.host.store.read('agents', 'must-not-exist'), null);
});

void test('a parent waits for child work and its cancellation invalidates child claims', async (t) => {
  const f = await fixture(t);
  const parent = await f.owner.submit(
    {
      ...f.input,
      to: 'alice',
      permissions: [...f.scope, { operation: 'task.submit', resource: 'bob' }],
      delegable: true,
    },
    'parent',
  );
  const parentClaim = await f.alice.claim(parent.task.id);
  const child = await f.alice.submit(
    { ...f.input, authorityId: parent.task.grantId },
    'child',
    parentClaim.claimToken,
  );
  const childClaim = await f.bob.claim(child.task.id);
  await f.alice.putArtifact(
    parent.task.id,
    'report',
    'Parent draft',
    parentClaim.claimToken,
  );
  await rejectsCode(
    f.alice.complete(parent.task.id, { ok: true }, parentClaim.claimToken),
    'CHILDREN_PENDING',
  );
  await f.owner.cancel(parent.task.id);
  await rejectsCode(
    f.bob.complete(child.task.id, { ok: true }, childClaim.claimToken),
    'STALE_CLAIM',
  );
  assert.equal((await f.owner.task(child.task.id)).state, 'cancelled');
});

void test('portable IDs reject URI delimiters before creating unreachable identities or artifacts', async (t) => {
  const f = await fixture(t);
  await rejectsCode(
    f.owner.createAgent({ id: 'unsafe:agent' }),
    'INVALID_INPUT',
  );
  await rejectsCode(
    f.owner.createAgent({ id: 'unsafe@agent' }),
    'INVALID_INPUT',
  );
  await rejectsCode(
    f.owner.submit(
      {
        ...f.input,
        permissions: [{ operation: 'artifact.write', resource: 'unsafe:name' }],
        requiredArtifacts: [],
      },
      'unsafe-artifact',
    ),
    'INVALID_INPUT',
  );
  await f.owner.createAgent({ id: 'agent-1.example' });
  assert.equal(
    (await f.owner.revokeAgent('agent-1.example')).id,
    'agent-1.example',
  );
});

void test('an owner can export a full audit even when capacity prevents an expiry transition', async (t) => {
  const f = await fixture(t);
  await f.owner.submit(f.input, 'expires-at-capacity');
  f.host.store.db
    .prepare(
      'INSERT INTO meta (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
    )
    .run('audit_bytes', String(32 * 1024 * 1024));
  f.advance(700000);
  assert.equal(
    verifyEvidence(await f.owner.audit(), f.host.store.keyFingerprint).valid,
    true,
  );
  assert.equal((await f.owner.info()).actor, 'owner');
});

void test('an expired parent claim cannot delegate and a new generation invalidates its previous child', async (t) => {
  const f = await fixture(t);
  const parent = await f.owner.submit(
    {
      ...f.input,
      to: 'alice',
      permissions: [...f.scope, { operation: 'task.submit', resource: 'bob' }],
      delegable: true,
    },
    'fenced-parent',
  );
  const first = await f.alice.claim(parent.task.id, 1000);
  const childInput = { ...f.input, authorityId: parent.task.grantId };
  const child = await f.alice.submit(
    childInput,
    'first-generation-child',
    first.claimToken,
  );
  const childClaim = await f.bob.claim(child.task.id);
  f.advance(1001);
  await rejectsCode(
    f.alice.submit(childInput, 'late-child', first.claimToken),
    'STALE_CLAIM',
  );
  await f.alice.claim(parent.task.id);
  await rejectsCode(
    f.bob.putArtifact(
      child.task.id,
      'report',
      'stale descendant',
      childClaim.claimToken,
    ),
    'STALE_CLAIM',
  );
  assert.equal((await f.owner.task(child.task.id)).state, 'cancelled');
});

void test('JSON digests distinguish typed values from their string representations', () => {
  assert.notEqual(digest(null), digest('null'));
  assert.notEqual(digest({ a: 1 }), digest('{"a":1}'));
});

// Value: protects=revoked recipient authority cannot fetch task bodies while archive summaries and receipts remain available;
// fails_when=a full task read returns input or result after its grant is revoked;
// why_new=existing revocation tests cover writes and delegation, not the full-body GET route;
// seam=none; no_claim=revoking data already copied outside the runtime
void test('revoked recipients lose full task reads but retain content-free archive evidence', async (t) => {
  const f = await fixture(t);
  const context = 'Synthetic context withheld after revocation.';
  const { task } = await f.owner.submit({ ...f.input, input: { context } }, 'revoked-body');
  assert.equal((await f.bob.task(task.id)).input.context, context);
  await f.owner.revokeGrant(task.grantId);
  await rejectsCode(f.bob.task(task.id), 'GRANT_INACTIVE');
  const summary = (await f.bob.tasks()).tasks.find((item) => item.id === task.id);
  assert.equal(summary.state, 'cancelled');
  assert.equal(Object.hasOwn(summary, 'input'), false);
  assert.equal(Object.hasOwn(summary, 'result'), false);
  const receipt = await f.bob.receipt(task.id);
  assert.equal(verifyEvidence(receipt, f.host.store.keyFingerprint).valid, true);
  assert.equal(JSON.stringify(receipt).includes(context), false);
  assert.equal((await f.owner.task(task.id)).input.context, context);
});

void test('inboxes and task lists expose bounded summaries and leave inputs for an explicit task read', async (t) => {
  const f = await fixture(t);
  const { task } = await f.owner.submit(
    { ...f.input, input: { privateContext: 'Only read when claiming.' } },
    'summaries',
  );
  const summary = (await f.bob.inbox()).tasks[0];
  assert.equal(summary.id, task.id);
  assert.equal(summary.claimable, true);
  assert.equal(Object.hasOwn(summary, 'input'), false);
  assert.equal(Object.hasOwn(summary, 'result'), false);
  assert.equal(
    (await f.bob.claim(task.id)).task.input.privateContext,
    'Only read when claiming.',
  );
  assert.equal(Object.hasOwn((await f.owner.tasks()).tasks[0], 'input'), false);
  await rejectsCode(f.alice.agents(), 'OWNER_REQUIRED');
});

void test('exhausted work becomes a recorded failure and does not poison the recipient inbox', async (t) => {
  const f = await fixture(t);
  const { token } = await f.owner.createAgent({ id: 'runtime' });
  const agentNamedRuntime = new RuntimeClient({ url: f.host.url, ca: f.host.certificate, token });
  const { task } = await f.owner.submit({ ...f.input, to: 'runtime' }, 'exhausted');
  for (let attempt = 0; attempt < 20; attempt++) {
    await agentNamedRuntime.claim(task.id, 1000);
    f.advance(1001);
  }
  const inbox = await agentNamedRuntime.inbox();
  assert.equal(inbox.tasks.length, 0);
  assert.equal((await f.owner.task(task.id)).state, 'failed');
  const receipt = await f.owner.receipt(task.id);
  assert.equal(
    verifyEvidence(receipt, f.host.store.keyFingerprint).valid,
    true,
  );
  assert.equal(receipt.payload.taskEvent.actor, '@runtime');
  assert.ok((await f.owner.audit()).payload.events.some(event => event.type === 'task.claimed' && event.actor === 'runtime'));
  const next = await f.owner.submit(f.input, 'healthy-after-exhaustion');
  assert.equal((await f.bob.inbox()).tasks[0].id, next.task.id);
});

// Generated by /ship Step 7.
// Value: protects=a worker handler error records a failed task and signed failure receipt without leaking the handler error;
// fails_when=handler exceptions leave work running or produce completion instead of failure;
// why_new=the worker integration test exercises successful delivery and heartbeat only;
// seam=none; no_claim=provider behavior or external effects (the handler deliberately throws)
void test('worker handler failures become terminal failure receipts and reach onError', async (t) => {
  const f = await fixture(t);
  const { task } = await f.owner.submit(f.input, 'worker-handler-failure');
  const controller = new AbortController();
  const failure = new Error('private provider detail');
  const observed = [];
  const worker = runWorker({
    client: f.bob,
    signal: controller.signal,
    leaseMs: 3000,
    pollMs: 50,
    handle: () => { throw failure; },
    onError: (error) => observed.push(error),
  });
  try {
    const finished = await f.owner.wait(task.id, { timeoutMs: 5000, intervalMs: 50 });
    assert.equal(finished.state, 'failed');
    assert.deepEqual(finished.result, { reason: 'handler_failed' });
    const receipt = await f.owner.receipt(task.id);
    assert.equal(verifyEvidence(receipt, f.host.store.keyFingerprint).valid, true);
    assert.equal(JSON.stringify(receipt).includes(failure.message), false);
  } finally {
    controller.abort();
    await worker;
  }
  assert.deepEqual(observed, [failure]);
});

// Generated by /ship Step 7.
// Value: protects=worker shutdown leaves its lease recoverable and never reports an aborted handler as completed or failed;
// fails_when=shutdown finalizes the task or prevents a fresh generation from reclaiming it;
// why_new=the successful worker test aborts after completion and does not exercise in-flight shutdown;
// seam=none; no_claim=external tool cancellation (the fixture handler honors AbortSignal)
void test('worker shutdown leaves in-flight work for deliberate lease recovery', async (t) => {
  const f = await fixture(t);
  const { task } = await f.owner.submit(f.input, 'worker-shutdown');
  const controller = new AbortController();
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const observed = [];
  const worker = runWorker({
    client: f.bob,
    signal: controller.signal,
    leaseMs: 3000,
    pollMs: 50,
    onError: (error) => observed.push(error),
    async handle({ signal }) {
      started();
      await delay(30000, undefined, { signal });
      return { unexpected: 'completion after shutdown' };
    },
  });
  try {
    await Promise.race([
      running,
      worker,
      delay(5000, undefined, { ref: false }).then(() => {
        throw new Error('The worker did not enter its handler within 5 seconds.');
      }),
    ]);
    controller.abort();
    await worker;
    const left = await f.owner.task(task.id);
    assert.equal(left.state, 'running');
    assert.equal(left.result, null);
    await rejectsCode(f.bob.claim(task.id), 'TASK_UNAVAILABLE');
    f.advance(3001);
    const recovered = await f.bob.claim(task.id);
    assert.equal(recovered.task.generation, left.generation + 1);
    assert.equal(observed.length, 0);
  } finally {
    controller.abort();
    await worker;
  }
});

// Generated by /ship Step 7.
// Value: protects=the CLI refuses existing credential and claim destinations before issuing credentials or claiming a task;
// fails_when=an existing output file is overwritten or a rejected CLI command still mutates runtime authority;
// why_new=HTTP tests bypass the CLI's file checks and private-output workflow;
// seam=none; no_claim=filesystem races or POSIX permissions (real CLI on the current platform)
void test('CLI existing-output refusals preserve files and leave authority unchanged', async (t) => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../bin/agentcollusion.mjs', import.meta.url));
  const config = path.join(f.directory, 'owner-client.json');
  const output = path.join(f.directory, 'existing-output.json');
  const original = '{"preserve":"caller data"}\n';
  await writeFile(config, JSON.stringify({
    url: f.host.url,
    token: f.host.store.identity.token,
    ca: f.host.certificate,
  }), { mode: 0o600 });
  await writeFile(output, original, { mode: 0o600 });
  const run = promisify(execFile);
  await assert.rejects(
    run(process.execPath, [cli, 'agent', 'add', 'unsaved-agent', '--config', config, '--out', output], { windowsHide: true, timeout: 10000 }),
    (error) => error.code === 1 && /destination already exists/.test(error.stderr),
  );
  assert.deepEqual((await f.owner.agents()).agents.map((agent) => agent.id).sort(), ['alice', 'bob']);
  const { task } = await f.owner.submit(f.input, 'cli-existing-claim');
  await writeFile(config, JSON.stringify({
    url: f.host.url,
    token: f.credentials[1].token,
    ca: f.host.certificate,
  }), { mode: 0o600 });
  await assert.rejects(
    run(process.execPath, [cli, 'task', 'claim', task.id, '--config', config, '--out', output], { windowsHide: true, timeout: 10000 }),
    (error) => error.code === 1 && /destination already exists/.test(error.stderr),
  );
  assert.equal((await f.owner.task(task.id)).state, 'queued');
  assert.equal((await f.owner.task(task.id)).generation, 0);
  assert.equal(await readFile(output, 'utf8'), original);
});

void test('CLI unsavable outputs do not issue an identity or consume a claim', async (t) => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../bin/agentcollusion.mjs', import.meta.url));
  const config = path.join(f.directory, 'owner-client.json');
  const parent = path.join(f.directory, 'clients');
  const output = path.join(parent, 'writer.json');
  await writeFile(config, JSON.stringify({ url: f.host.url, token: f.host.store.identity.token, ca: f.host.certificate }), { mode: 0o600 });
  const run = promisify(execFile);
  const options = { windowsHide: true, timeout: 10000 };
  await assert.rejects(run(process.execPath, [cli, 'agent', 'add', 'writer', '--config', config, '--out', output], options));
  assert.equal((await f.owner.agents()).agents.some((agent) => agent.id === 'writer'), false);
  const { task } = await f.owner.submit(f.input, 'cli-unsavable-claim');
  await writeFile(config, JSON.stringify({ url: f.host.url, token: f.credentials[1].token, ca: f.host.certificate }), { mode: 0o600 });
  await assert.rejects(run(process.execPath, [cli, 'task', 'claim', task.id, '--config', config, '--out', output], options));
  assert.equal((await f.owner.task(task.id)).generation, 0);
  await mkdir(parent);
  await writeFile(config, JSON.stringify({ url: f.host.url, token: f.host.store.identity.token, ca: f.host.certificate }), { mode: 0o600 });
  await run(process.execPath, [cli, 'agent', 'add', 'writer', '--config', config, '--out', output], options);
  const saved = new RuntimeClient(JSON.parse(await readFile(output, 'utf8')));
  assert.equal((await saved.info()).actor, 'writer');
});

void test('startup refuses missing identities and damaged history, and always releases its host lock', async (t) => {
  const prefix = path.join(os.tmpdir(), 'agentcollusion-recovery-tests-');
  const directory = await mkdtemp(prefix);
  let host = await createRuntime({ directory, port: 0 });
  t.after(async () => {
    if (host) await host.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  });
  await new RuntimeClient({
    url: host.url,
    token: host.store.identity.token,
    ca: host.certificate,
  }).createAgent({ id: 'before-restart' });
  const identityPath = path.join(directory, 'owner.json'),
    tlsPath = path.join(directory, 'tls.json');
  const identity = await readFile(identityPath, 'utf8'),
    tls = await readFile(tlsPath, 'utf8');
  await host.close();
  host = null;
  await rm(identityPath);
  await assert.rejects(
    createRuntime({ directory, port: 0 }),
    (error) => error.code === 'IDENTITY_MISSING',
  );
  await assert.rejects(
    readFile(identityPath),
    (error) => error.code === 'ENOENT',
  );
  await writeFile(identityPath, identity, { flag: 'wx', mode: 0o600 });
  await rm(tlsPath);
  await assert.rejects(
    createRuntime({ directory, port: 0 }),
    (error) => error.code === 'TLS_IDENTITY_MISSING',
  );
  await writeFile(tlsPath, tls, { flag: 'wx', mode: 0o600 });
  let db = new DatabaseSync(path.join(directory, 'runtime.sqlite'));
  const row = db.prepare('SELECT body FROM events WHERE sequence = 1').get();
  const changed = JSON.parse(row.body);
  changed.actor = 'forged';
  db.prepare('UPDATE events SET body = ? WHERE sequence = 1').run(
    JSON.stringify(changed),
  );
  db.close();
  await assert.rejects(
    createRuntime({ directory, port: 0 }),
    (error) => error.code === 'AUDIT_CORRUPT',
  );
  db = new DatabaseSync(path.join(directory, 'runtime.sqlite'));
  db.prepare('UPDATE events SET body = ? WHERE sequence = 1').run(row.body);
  db.close();
  host = await createRuntime({ directory, port: 0 });
  assert.equal(
    (
      await new RuntimeClient({
        url: host.url,
        token: host.store.identity.token,
        ca: host.certificate,
      }).agents()
    ).agents[0].id,
    'before-restart',
  );
});

// Value: protects=Windows runtime state stays private when existing directories or files have explicit shared access;
// fails_when=initialization retains another principal's allow ACE on the directory, keys or SQLite state;
// why_new=API isolation tests cannot inspect Windows filesystem permissions;
// seam=none; no_claim=administrators or hostile processes running as the current OS user
void test('Windows runtime storage removes pre-existing shared permissions', {
  skip: process.platform !== 'win32',
  timeout: 60000,
}, async (t) => {
  const prefix = path.join(os.tmpdir(), 'agentcollusion-acl-test-');
  const directory = await mkdtemp(prefix);
  let host;
  t.after(async () => {
    if (host) await host.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  });
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($data.operation -eq 'share') {
  if ($data.directory) { $acl = [IO.Directory]::GetAccessControl($data.path) }
  else { $acl = [IO.File]::GetAccessControl($data.path) }
  $inherit = [Security.AccessControl.InheritanceFlags]::None
  if ($data.directory) { $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
    [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inherit,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  if ($data.directory) { [IO.Directory]::SetAccessControl($data.path, $acl) }
  else { [IO.File]::SetAccessControl($data.path, $acl) }
} else {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $paths = @($data.path) + [IO.Directory]::GetFiles($data.path, '*', [IO.SearchOption]::AllDirectories)
  $unsafe = @()
  foreach ($item in $paths) {
    if ([IO.Directory]::Exists($item)) { $acl = [IO.Directory]::GetAccessControl($item) }
    else { $acl = [IO.File]::GetAccessControl($item) }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid) {
        $unsafe += [IO.Path]::GetFileName($item) + ':' + $rule.IdentityReference.Value
      }
    }
  }
  ConvertTo-Json -InputObject @($unsafe) -Compress
}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // execFile does not supply stdin; use a bounded child with a literal JSON input.
  const runAcl = (operation, target = directory, isDirectory = true) => new Promise((resolve, reject) => {
    const child = execFile(powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 10000, encoding: 'utf8' },
      (error, stdout, stderr) => error ? reject(new Error(stderr, { cause: error })) : resolve(stdout));
    child.stdin.end(JSON.stringify({ operation, path: target, directory: isDirectory }));
  });
  await runAcl('share');
  host = await createRuntime({ directory, port: 0 });
  assert.deepEqual(JSON.parse(await runAcl('inspect')), []);
  await host.close();
  host = null;
  await runAcl('share', path.join(directory, 'runtime.sqlite'), false);
  await runAcl('share', path.join(directory, 'owner.json'), false);
  host = await createRuntime({ directory, port: 0 });
  assert.deepEqual(JSON.parse(await runAcl('inspect')), []);
});
