import { createHash, createPublicKey, sign, verify } from 'node:crypto';

// Sorted, restricted JSON, used identically by the host and offline verifier.
export function canonical(value, depth = 0) {
  if (depth > 64) throw new Error('JSON nesting exceeds 64 levels.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k], depth + 1)}`)
      .join(',')}}`;
  }
  throw new Error('Expected a finite JSON value.');
}

export const digest = (value) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export function fingerprint(publicKey) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519')
    throw new Error('Evidence requires an Ed25519 public key.');
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

export function signedEnvelope(payload, privateKey, publicKey) {
  return {
    format: 'agentcollusion-evidence/v1',
    payload,
    publicKey,
    fingerprint: fingerprint(publicKey),
    signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString(
      'base64',
    ),
  };
}

export function verifyEvidence(envelope, trustedFingerprint) {
  if (
    typeof trustedFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(trustedFingerprint)
  )
    throw new Error(
      'An independently trusted SHA-256 public-key fingerprint is required.',
    );
  if (
    envelope?.format !== 'agentcollusion-evidence/v1' ||
    fingerprint(envelope.publicKey) !== trustedFingerprint ||
    envelope.fingerprint !== trustedFingerprint
  )
    throw new Error(
      'Evidence signing key does not match the trusted fingerprint.',
    );
  if (
    !verify(
      null,
      Buffer.from(canonical(envelope.payload)),
      envelope.publicKey,
      Buffer.from(envelope.signature, 'base64'),
    )
  )
    throw new Error('Invalid evidence signature.');
  const payload = envelope.payload;
  if (
    !['audit', 'receipt'].includes(payload?.kind) ||
    payload.schemaVersion !== 1 ||
    typeof payload.runtimeId !== 'string'
  )
    throw new Error('Unsupported evidence payload.');
  if (payload.kind === 'audit') {
    if (!Array.isArray(payload.events))
      throw new Error('Missing audit events.');
    let previousHash = '0'.repeat(64);
    for (const [index, event] of payload.events.entries()) {
      const { hash, ...record } = event;
      if (
        record.sequence !== index + 1 ||
        record.previousHash !== previousHash ||
        record.runtimeId !== payload.runtimeId ||
        digest(record) !== hash
      )
        throw new Error(`Invalid audit chain at event ${index + 1}.`);
      previousHash = hash;
    }
    if (
      payload.head.sequence !== payload.events.length ||
      payload.head.hash !== previousHash
    )
      throw new Error('Audit head does not match its events.');
  } else {
    if (!['completed', 'failed', 'cancelled'].includes(payload.task?.state))
      throw new Error('A receipt requires a terminal task.');
    const { hash, ...record } = payload.taskEvent || {};
    if (
      digest(record) !== hash ||
      record.taskId !== payload.task.id ||
      record.runtimeId !== payload.runtimeId ||
      record.type !== `task.${payload.task.state}` ||
      payload.head.sequence !== record.sequence ||
      payload.head.hash !== hash
    )
      throw new Error('Receipt is not bound to its terminal task event.');
    if (
      payload.task.state !== 'cancelled' &&
      (record.detail.resultSha256 !== payload.task.resultSha256 ||
        canonical(record.detail.artifacts) !==
          canonical(payload.task.artifacts))
    )
      throw new Error(
        'Receipt result or artifacts do not match the terminal task event.',
      );
  }
  return {
    valid: true,
    kind: payload.kind,
    runtimeId: payload.runtimeId,
    fingerprint: trustedFingerprint,
    head: payload.head,
  };
}
