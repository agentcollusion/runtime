import { verifyAuditExtension, verifyEvidence } from './evidence.mjs';

const MAX_ROWS = 500;
const PORTABLE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const textFields = ['code', 'reason', 'to', 'agentId', 'artifactId', 'toolId', 'invocationId', 'caller', 'disposition', 'leaseUntil', 'recordedAt', 'parentTaskId'];
const digestFields = ['inputSha256', 'resultSha256', 'evidenceSha256', 'sha256'];
const countFields = ['attempt', 'generation'];
const short = (value) => typeof value === 'string' && value.length <= 256 ? value : null;

function summaryDetail(detail) {
  const summary = {};
  if (!detail || typeof detail !== 'object') return summary;
  for (const name of textFields) {
    const value = short(detail[name]);
    if (value !== null) summary[name] = value;
  }
  for (const name of digestFields) {
    if (typeof detail[name] === 'string' && SHA256.test(detail[name])) summary[name] = detail[name];
  }
  for (const name of countFields) {
    if (Number.isSafeInteger(detail[name]) && detail[name] >= 0) summary[name] = detail[name];
  }
  if (typeof detail.grant?.id === 'string' && PORTABLE_TASK_ID.test(detail.grant.id)) {
    summary.grantId = detail.grant.id;
    if (Array.isArray(detail.grant.permissions)) summary.scopeSize = detail.grant.permissions.length;
  }
  if (Array.isArray(detail.artifacts)) summary.artifactCount = detail.artifacts.length;
  return summary;
}

/** Verify the whole signed history before presenting a bounded selection. */
export function inspectAuditTrace(audit, { trustedFingerprint, checkpoint, taskId, afterSequence, limit = 100 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS)
    throw new Error(`Trace row limit must be 1–${MAX_ROWS}.`);
  if (taskId !== undefined && (typeof taskId !== 'string' || !PORTABLE_TASK_ID.test(taskId)))
    throw new Error('Trace task ID must be an exact portable task ID.');
  if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0))
    throw new Error('Trace cursor must be a nonnegative integer sequence.');
  const verified = checkpoint === undefined
    ? verifyEvidence(audit, trustedFingerprint)
    : verifyAuditExtension(audit, trustedFingerprint, checkpoint);
  if (verified.kind !== 'audit') throw new Error('Trace inspection needs a signed audit export.');
  if (!PORTABLE_TASK_ID.test(verified.runtimeId)) throw new Error('Trace inspection needs a portable runtime ID.');
  if (afterSequence !== undefined && afterSequence > verified.head.sequence)
    throw new Error('Trace cursor is ahead of the verified audit head.');
  const eligible = audit.payload.events.filter(event =>
    (taskId === undefined || event.taskId === taskId) &&
    (afterSequence === undefined || event.sequence > afterSequence),
  );
  const forward = afterSequence !== undefined;
  const selected = forward ? eligible.slice(0, limit) : eligible.slice(-limit);
  const events = selected.map(event => ({
    sequence: event.sequence,
    at: short(event.at),
    actor: short(event.actor),
    type: short(event.type),
    taskId: short(event.taskId),
    hash: event.hash,
    detail: summaryDetail(event.detail),
  }));
  return {
    format: 'agentcollusion-audit-trace/v1',
    runtimeId: verified.runtimeId,
    fingerprint: verified.fingerprint,
    head: verified.head,
    ...(checkpoint === undefined ? {} : {
      retainedHead: verified.previousHead,
      advanced: verified.advanced,
    }),
    selection: {
      taskId: taskId ?? null,
      afterSequence: afterSequence ?? null,
      matches: eligible.length,
      shown: events.length,
      olderOmitted: forward ? 0 : eligible.length - events.length,
      newerRemaining: forward ? eligible.length - events.length : 0,
      nextAfterSequence: events.at(-1)?.sequence ?? afterSequence ?? null,
    },
    events,
  };
}
