import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { A2A_PROTOCOL_VERSION, Role, TaskState } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server';

export async function startPeer({ expectedBearer } = {}) {
  let transport;
  let messages = 0;
  let nonRpcRequests = 0;
  const seen = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/rpc') {
      nonRpcRequests++;
      response.writeHead(404).end();
      return;
    }
    if (expectedBearer && request.headers.authorization !== `Bearer ${expectedBearer}`) {
      response.writeHead(401).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ version: request.headers['a2a-version'], hasAuthorization: Boolean(request.headers.authorization), request: JSON.parse(body) });
      const reply = await transport.handle(body, new ServerCallContext({ requestedVersion: request.headers['a2a-version'] }));
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}/rpc`;
  const card = {
    name: 'Local manifest reviewer', description: 'Returns a synthetic review', version: '1.0.0',
    supportedInterfaces: [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
    capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'review', name: 'Review', description: 'Checks one input', tags: ['review'] }],
  };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), {
    async execute(context, bus) {
      messages++;
      const input = context.userMessage.parts[0]?.content?.value;
      if (input === 'task with artifact') {
        bus.publish(AgentEvent.task({
          id: context.taskId, contextId: context.contextId,
          status: { state: TaskState.TASK_STATE_COMPLETED }, history: [],
          artifacts: [{
            artifactId: randomUUID(), name: 'review', description: '', extensions: [],
            parts: [
              { content: { $case: 'text', value: 'Reviewed artifact' }, mediaType: 'text/plain', filename: '' },
              { content: { $case: 'url', value: new URL('/unread', endpoint).href }, mediaType: 'text/plain', filename: '' },
            ],
          }],
        }));
        return;
      }
      bus.publish(AgentEvent.message({
        messageId: randomUUID(), contextId: context.contextId, taskId: '', role: Role.ROLE_AGENT,
        parts: [{ content: { $case: 'text', value: `Reviewed: ${input}` }, mediaType: 'text/plain', filename: '' }],
        extensions: [], referenceTaskIds: [],
      }));
    },
    async cancelTask() {},
  });
  transport = new JsonRpcTransportHandler(handler);
  return { endpoint, seen, get messages() { return messages; }, get nonRpcRequests() { return nonRpcRequests; }, close: () => new Promise(resolve => server.close(resolve)) };
}

if (process.argv[2] === 'probe') {
  const peer = await startPeer();
  try {
    const id = randomUUID();
    const response = await fetch(peer.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'SendMessage', params: {
        message: { messageId: id, role: 'ROLE_USER', parts: [{ text: 'manifest checks passed', mediaType: 'text/plain' }] },
      } }), signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.id, id);
    assert.equal(envelope.result?.message?.parts[0]?.text, 'Reviewed: manifest checks passed', JSON.stringify(envelope));
    assert.equal(peer.messages, 1);
    console.log(JSON.stringify({ binding: 'A2A 1.0 JSON-RPC', serverSdk: '1.3.0', reply: envelope.result.message.parts[0].text, dispatches: peer.messages }));
  } finally { await peer.close(); }
}
