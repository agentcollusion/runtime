import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RuntimeClient } from '../src/client.mjs';
import { createAuditCheckpoint, verifyAuditExtension, verifyReceiptInAudit } from '../src/evidence.mjs';
import { createRuntime } from '../src/server.mjs';
import { createA2ASendTool } from '../src/a2a.mjs';
import { startPeer } from './fixtures/a2a-sdk-peer.mjs';

test('an authorized runtime tool exchanges a message and task artifact with an A2A SDK peer', async (t) => {
  const prefix = path.resolve(os.tmpdir(), 'agentcollusion-a2a-sdk-');
  const directory = await mkdtemp(prefix);
  let peer, host;
  const peers = [];
  async function localEndpoint(handler) {
    const server = createServer(handler);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    peers.push(server);
    return `http://127.0.0.1:${server.address().port}/rpc`;
  }
  t.after(async () => {
    await host?.close();
    await peer?.close();
    await Promise.all(peers.map(server => new Promise(resolve => server.close(resolve))));
    assert.ok(path.resolve(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });

  const remoteFixtureCredential = 'fixture-a2a-only';
  peer = await startPeer({ expectedBearer: remoteFixtureCredential });
  let redirects = 0, redirectedRequests = 0, droppedResponses = 0;
  const redirectTarget = await localEndpoint((_request, response) => { redirectedRequests++; response.writeHead(500).end(); });
  const redirect = await localEndpoint((_request, response) => { redirects++; response.writeHead(307, { Location: redirectTarget }).end(); });
  const drop = await localEndpoint(async (request) => {
    for await (const _chunk of request) { /* Consume the request before dropping the reply. */ }
    droppedResponses++;
    request.socket.destroy();
  });
  const overlong = await localEndpoint((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify('x'.repeat(70000)));
  });
  const tool = (endpoint) => createA2ASendTool({ endpoint, remoteBearer: remoteFixtureCredential, allowLoopbackHttp: true });
  assert.throws(() => createA2ASendTool({ endpoint: peer.endpoint }), /exact HTTPS/);
  host = await createRuntime({ directory, port: 0, tools: {
    'send-to-peer': tool(peer.endpoint), 'send-task': tool(peer.endpoint),
    'redirect-probe': tool(redirect), 'dropped-reply-probe': tool(drop), 'overlong-probe': tool(overlong),
    'ungranted-peer': tool(peer.endpoint), 'input-probe': tool(peer.endpoint),
  } });
  const connect = (credential) => new RuntimeClient({ url: host.url, ca: host.certificate, token: credential });
  const owner = connect(host.store.identity.token);
  const { token: workerCredential } = await owner.createAgent({ id: 'review-worker' });
  const worker = connect(workerCredential);
  const { task } = await owner.submit({
    to: 'review-worker', title: 'Review a fixture using an A2A peer', input: {},
    permissions: ['send-to-peer', 'send-task', 'redirect-probe', 'dropped-reply-probe', 'overlong-probe', 'input-probe'].map(resource => ({ operation: 'tool.invoke', resource })),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  const { claimToken } = await worker.claim(task.id);
  const fingerprint = host.store.keyFingerprint;
  const checkpoint = createAuditCheckpoint(await owner.audit(), fingerprint);
  const text = { text: 'manifest checks passed' };
  await assert.rejects(worker.invokeTool(task.id, 'ungranted-peer', text, claimToken), (error) => error.code === 'SCOPE_DENIED');
  assert.equal(peer.messages, 0);
  const malformed = await worker.invokeTool(task.id, 'input-probe', { ...text, endpoint: redirectTarget }, claimToken);
  assert.equal(malformed.result.kind, 'rejected_input');
  assert.equal(peer.messages, 0);
  assert.equal(redirectedRequests, 0);
  const first = await worker.invokeTool(task.id, 'send-to-peer', text, claimToken);
  assert.equal(first.state, 'returned');
  assert.deepEqual(first.result.text, ['Reviewed: manifest checks passed']);
  const repeat = await worker.invokeTool(task.id, 'send-to-peer', text, claimToken);
  assert.equal(repeat.replayed, true);
  assert.equal(peer.messages, 1);
  assert.equal(peer.seen[0].request.params.message.messageId, first.id);
  assert.equal(peer.seen[0].version, '1.0');
  assert.equal(peer.seen[0].hasAuthorization, true);
  const taskReply = await worker.invokeTool(task.id, 'send-task', { text: 'task with artifact' }, claimToken);
  assert.equal(taskReply.state, 'returned');
  assert.equal(taskReply.result.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(taskReply.result.artifacts.map(artifact => artifact.text), [['Reviewed artifact']]);
  assert.equal(peer.nonRpcRequests, 0);
  const redirected = await worker.invokeTool(task.id, 'redirect-probe', text, claimToken);
  assert.equal(redirected.state, 'uncertain');
  assert.equal(redirects, 1);
  assert.equal(redirectedRequests, 0);
  const uncertain = await worker.invokeTool(task.id, 'dropped-reply-probe', text, claimToken);
  assert.equal(uncertain.state, 'uncertain');
  assert.equal((await worker.invokeTool(task.id, 'dropped-reply-probe', text, claimToken)).id, uncertain.id);
  assert.equal(droppedResponses, 1);
  assert.equal((await worker.invokeTool(task.id, 'overlong-probe', text, claimToken)).state, 'uncertain');
  await worker.complete(task.id, { review: first.result.text[0], invocationId: first.id }, claimToken);
  const audit = await owner.audit();
  assert.equal(verifyAuditExtension(audit, fingerprint, checkpoint).advanced, true);
  assert.equal(verifyReceiptInAudit(await owner.receipt(task.id), audit, fingerprint, checkpoint).valid, true);
  assert.doesNotMatch(JSON.stringify(audit), /manifest checks passed|fixture-a2a-only/);
});
