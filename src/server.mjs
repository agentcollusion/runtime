import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import manifest from '../package.json' with { type: 'json' };
import selfsigned from 'selfsigned';
import { createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { RuntimeStore } from './store.mjs';
import { RuntimeError, requireCondition as must } from './errors.mjs';
import { canonical } from './evidence.mjs';
import { prepareDirectory, writePrivateJson } from './security.mjs';

async function readJson(request) {
  must(
    request.headers['content-type']?.split(';')[0].trim().toLowerCase() ===
      'application/json',
    415,
    'JSON_REQUIRED',
    'Use Content-Type: application/json.',
  );
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    must(
      bytes <= 400000,
      413,
      'BODY_TOO_LARGE',
      'Request body exceeds 400000 bytes.',
    );
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RuntimeError(
      400,
      'INVALID_JSON',
      'Request body must be valid JSON.',
    );
  }
  must(
    value && typeof value === 'object' && !Array.isArray(value),
    400,
    'INVALID_JSON',
    'Request body must be a JSON object.',
  );
  try {
    canonical(value);
  } catch {
    throw new RuntimeError(
      400,
      'INVALID_JSON',
      'JSON values must have at most 64 nesting levels and use finite, safe numbers.',
    );
  }
  return value;
}

export async function createRuntime({
  directory = '.agentcollusion',
  port = 4318,
  now,
} = {}) {
  must(
    Number.isSafeInteger(port) && port >= 0 && port <= 65535,
    400,
    'INVALID_PORT',
    'port must be 0–65535.',
  );
  const absoluteDirectory = prepareDirectory(directory);
  const hadStore = existsSync(path.join(absoluteDirectory, 'runtime.sqlite'));
  const store = new RuntimeStore(absoluteDirectory, { now });
  let tls;
  try {
    const tlsPath = path.join(absoluteDirectory, 'tls.json');
    try {
      tls = JSON.parse(readFileSync(tlsPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      must(
        !hadStore,
        500,
        'TLS_IDENTITY_MISSING',
        'tls.json is missing from an existing runtime. Restore it from the matching backup to retain client certificate pins.',
      );
      const generated = await selfsigned.generate(
        [{ name: 'commonName', value: 'localhost' }],
        {
          keyType: 'ec',
          algorithm: 'sha256',
          notBeforeDate: new Date(Date.now() - 60000),
        },
      );
      tls = { key: generated.private, cert: generated.cert };
      writePrivateJson(tlsPath, tls);
    }
    createSecureContext({
      key: tls.key,
      cert: tls.cert,
      minVersion: 'TLSv1.3',
    });
    must(
      Date.parse(new X509Certificate(tls.cert).validTo) > Date.now(),
      500,
      'TLS_EXPIRED',
      'The runtime TLS certificate expired. Retain this runtime and initialize a new identity with new client configurations.',
    );
  } catch (error) {
    store.close();
    throw error;
  }
  let expectedHost;
  const server = https.createServer(
    {
      key: tls.key,
      cert: tls.cert,
      minVersion: 'TLSv1.3',
      maxHeaderSize: 8192,
    },
    async (request, response) => {
      const reply = (status, body) => {
        response.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy':
            "default-src 'none'; frame-ancestors 'none'",
          Connection: 'close',
        });
        response.end(JSON.stringify(body));
      };
      let actor;
      try {
        must(
          request.headers.host === expectedHost,
          403,
          'HOST_DENIED',
          'Use the exact loopback runtime address.',
        );
        must(
          !request.headers.origin && !request.headers['sec-fetch-site'],
          403,
          'BROWSER_DENIED',
          'The runtime accepts authenticated non-browser clients only.',
        );
        const url = new URL(request.url, `https://${expectedHost}`);
        must(
          !url.search && !url.hash,
          400,
          'INVALID_URL',
          'Query parameters are not supported.',
        );
        if (request.method === 'GET' && url.pathname === '/health') {
          reply(200, {
            status: 'ok',
            service: 'agentcollusion-runtime',
            version: manifest.version,
          });
          return;
        }
        const auth = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
          request.headers.authorization || '',
        );
        actor = store.authenticate(auth?.[1]);
        const segments = url.pathname.split('/').slice(1);
        must(segments[0] === 'v1', 404, 'NOT_FOUND', 'Unknown endpoint.');
        const [, resource, id, action, artifactId] = segments;
        const method = request.method;
        // Body reads yield to other requests. Recheck the principal after the
        // final await so a completed revocation governs pending mutations too.
        const input = ['POST', 'PUT'].includes(method) ? await readJson(request) : undefined;
        actor = store.authenticate(auth?.[1]);
        // Recovery exports and identity inspection must remain available when
        // audit capacity prevents an expiry transition from being recorded.
        if (
          !(
            method === 'GET' &&
            (['audit', 'info'].includes(resource) || action === 'receipt')
          )
        )
          store.sweep();
        let value;
        let status = 200;
        if (segments.length === 2 && resource === 'info' && method === 'GET') {
          value = {
            runtimeId: store.identity.runtimeId,
            fingerprint: store.keyFingerprint,
            publicKey: store.identity.publicKey,
            actor,
            protocol: 'agentcollusion-runtime/v1',
          };
        } else if (
          resource === 'agents' &&
          segments.length === 2 &&
          method === 'POST'
        ) {
          value = store.createAgent(actor, input);
          status = 201;
        } else if (
          resource === 'agents' &&
          segments.length === 2 &&
          method === 'GET'
        ) {
          store.owner(actor);
          value = { agents: store.all('agents').filter((a) => !a.revokedAt) };
        } else if (
          resource === 'agents' &&
          segments.length === 3 &&
          method === 'DELETE'
        ) {
          value = store.revokeAgent(actor, id);
        } else if (
          resource === 'grants' &&
          segments.length === 2 &&
          method === 'POST'
        ) {
          value = store.createGrant(actor, input);
          status = 201;
        } else if (
          resource === 'grants' &&
          segments.length === 3 &&
          method === 'DELETE'
        ) {
          value = store.revokeGrant(actor, id);
        } else if (
          resource === 'tasks' &&
          segments.length === 2 &&
          method === 'POST'
        ) {
          value = store.submit(
            actor,
            input,
            request.headers['idempotency-key'],
            request.headers['x-claim-token'],
          );
          status = value.replayed ? 200 : 201;
        } else if (
          resource === 'inbox' &&
          segments.length === 2 &&
          method === 'GET'
        ) {
          must(
            actor !== 'owner',
            403,
            'AGENT_REQUIRED',
            'The inbox requires an agent credential.',
          );
          value = { tasks: store.listTasks(actor, true) };
        } else if (
          resource === 'tasks' &&
          segments.length === 2 &&
          method === 'GET'
        ) {
          value = { tasks: store.listTasks(actor) };
        } else if (
          resource === 'tasks' &&
          segments.length === 3 &&
          method === 'GET'
        ) {
          value = store.readTask(actor, id);
        } else if (
          resource === 'tasks' &&
          segments.length === 4 &&
          action === 'claim' &&
          method === 'POST'
        ) {
          value = store.claim(actor, id, input);
        } else if (
          resource === 'tasks' &&
          segments.length === 4 &&
          action === 'heartbeat' &&
          method === 'POST'
        ) {
          value = store.heartbeat(
            actor,
            id,
            input,
            request.headers['x-claim-token'],
          );
        } else if (
          resource === 'tasks' &&
          segments.length === 4 &&
          ['complete', 'fail'].includes(action) &&
          method === 'POST'
        ) {
          value = store.finish(
            actor,
            id,
            action === 'complete' ? 'completed' : 'failed',
            input,
            request.headers['x-claim-token'],
          );
        } else if (
          resource === 'tasks' &&
          segments.length === 4 &&
          action === 'cancel' &&
          method === 'POST'
        ) {
          value = store.cancel(actor, id);
        } else if (
          resource === 'tasks' &&
          segments.length === 4 &&
          action === 'receipt' &&
          method === 'GET'
        ) {
          value = store.receipt(actor, id);
        } else if (
          resource === 'tasks' &&
          segments.length === 5 &&
          action === 'artifacts' &&
          method === 'PUT'
        ) {
          value = store.putArtifact(
            actor,
            id,
            artifactId,
            input,
            request.headers['x-claim-token'],
          );
        } else if (
          resource === 'tasks' &&
          segments.length === 5 &&
          action === 'artifacts' &&
          method === 'GET'
        ) {
          value = store.getArtifact(actor, id, artifactId);
        } else if (
          resource === 'audit' &&
          segments.length === 2 &&
          method === 'GET'
        ) {
          value = store.audit(actor);
        } else
          throw new RuntimeError(
            404,
            'NOT_FOUND',
            'Unknown endpoint or method.',
          );
        reply(status, value);
      } catch (error) {
        const known = error instanceof RuntimeError;
        if (actor && known && [403, 409].includes(error.status)) {
          try {
            store.denial(actor, error.code);
          } catch {
            reply(503, {
              error: {
                code: 'AUDIT_UNAVAILABLE',
                message: 'The runtime cannot durably record this operation.',
              },
            });
            return;
          }
        }
        if (!response.headersSent)
          reply(known ? error.status : 500, {
            error: {
              code: known ? error.code : 'INTERNAL_ERROR',
              message: known
                ? error.message
                : 'The runtime could not complete this operation.',
            },
          });
      }
    },
  );
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.timeout = 20000;
  server.maxConnections = 64;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    expectedHost = `127.0.0.1:${server.address().port}`;
  } catch (error) {
    store.close();
    throw error;
  }
  return {
    url: `https://${expectedHost}`,
    certificate: tls.cert,
    store,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
    },
  };
}
