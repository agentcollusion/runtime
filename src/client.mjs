import { randomUUID, X509Certificate } from 'node:crypto';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';

export class ClientError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class RuntimeClient {
  constructor({ url, token, ca, timeoutMs = 20000 }) {
    const endpoint = new URL(url);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== '/' ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error(
        'This beta client requires an exact https://127.0.0.1:PORT runtime URL.',
      );
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error('A valid runtime token is required.');
    if (typeof ca !== 'string')
      throw new Error(
        'A runtime certificate obtained from its owner configuration is required.',
      );
    const certificate = new X509Certificate(ca);
    this.ca = ca;
    this.certificateFingerprint = certificate.fingerprint256;
    this.url = endpoint.origin;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
  async request(method, endpoint, body, headers = {}) {
    return this.raw(method, `/v1/${endpoint}`, body, headers);
  }
  async raw(method, endpoint, body, headers = {}) {
    const destination = new URL(endpoint, this.url);
    if (destination.origin !== this.url)
      throw new Error('Runtime requests cannot leave the configured origin.');
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = https.request(
        destination,
        {
          method,
          agent: false,
          ca: this.ca,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
          checkServerIdentity: (_host, certificate) =>
            checkServerIdentity(destination.hostname, certificate) ||
            (certificate.fingerprint256 === this.certificateFingerprint
              ? undefined
              : new Error(
                  'Runtime TLS certificate does not match the pinned certificate.',
                )),
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(serialized === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(serialized),
                }),
            ...headers,
          },
        },
        (response) => {
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 64000000)
              response.destroy(
                new Error('Runtime response exceeded the 64 MB limit.'),
              );
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            let value;
            try {
              value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              reject(
                new ClientError(
                  response.statusCode,
                  'INVALID_RESPONSE',
                  'The runtime returned an invalid JSON response.',
                ),
              );
              return;
            }
            if (response.statusCode < 200 || response.statusCode >= 300)
              reject(
                new ClientError(
                  response.statusCode,
                  value.error?.code || 'HTTP_ERROR',
                  value.error?.message ||
                    `Runtime returned ${response.statusCode}.`,
                ),
              );
            else resolve(value);
          });
        },
      );
      request.on('error', reject);
      request.end(serialized);
    });
  }
  info() {
    return this.request('GET', 'info');
  }
  agents() {
    return this.request('GET', 'agents');
  }
  createAgent(input) {
    return this.request('POST', 'agents', input);
  }
  revokeAgent(id) {
    return this.request('DELETE', `agents/${encodeURIComponent(id)}`);
  }
  grant(input) {
    return this.request('POST', 'grants', input);
  }
  revokeGrant(id) {
    return this.request('DELETE', `grants/${encodeURIComponent(id)}`);
  }
  submit(input, idempotencyKey = randomUUID(), claimToken) {
    return this.request('POST', 'tasks', input, {
      'Idempotency-Key': idempotencyKey,
      ...(claimToken ? { 'X-Claim-Token': claimToken } : {}),
    });
  }
  tasks() {
    return this.request('GET', 'tasks');
  }
  inbox() {
    return this.request('GET', 'inbox');
  }
  task(id) {
    return this.request('GET', `tasks/${encodeURIComponent(id)}`);
  }
  claim(id, leaseMs = 60000) {
    return this.request('POST', `tasks/${encodeURIComponent(id)}/claim`, {
      leaseMs,
    });
  }
  heartbeat(id, claimToken, leaseMs = 60000) {
    return this.request(
      'POST',
      `tasks/${encodeURIComponent(id)}/heartbeat`,
      { leaseMs },
      { 'X-Claim-Token': claimToken },
    );
  }
  putArtifact(
    id,
    artifactId,
    value,
    claimToken,
    mediaType = 'application/json',
  ) {
    return this.request(
      'PUT',
      `tasks/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`,
      { value, mediaType },
      { 'X-Claim-Token': claimToken },
    );
  }
  artifact(id, artifactId) {
    return this.request(
      'GET',
      `tasks/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
  }
  complete(id, result, claimToken) {
    return this.request(
      'POST',
      `tasks/${encodeURIComponent(id)}/complete`,
      { result },
      { 'X-Claim-Token': claimToken },
    );
  }
  fail(id, result, claimToken) {
    return this.request(
      'POST',
      `tasks/${encodeURIComponent(id)}/fail`,
      { result },
      { 'X-Claim-Token': claimToken },
    );
  }
  cancel(id) {
    return this.request('POST', `tasks/${encodeURIComponent(id)}/cancel`, {});
  }
  receipt(id) {
    return this.request('GET', `tasks/${encodeURIComponent(id)}/receipt`);
  }
  audit() {
    return this.request('GET', 'audit');
  }
  async wait(id, { timeoutMs = 120000, intervalMs = 250, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const task = await this.task(id);
      if (['completed', 'failed', 'cancelled'].includes(task.state))
        return task;
      await new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, intervalMs);
        const abort = () => {
          clearTimeout(timer);
          cleanup();
          reject(signal.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    throw new ClientError(
      408,
      'WAIT_TIMEOUT',
      'The task did not reach a terminal state before the wait timeout.',
    );
  }
}
