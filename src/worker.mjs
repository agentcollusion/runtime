import { setTimeout as delay } from 'node:timers/promises';

// The host fences its APIs. A handler must separately constrain its own tools
// and honor signal when invoking external processes or provider SDKs.
export async function runWorker({
  client,
  handle,
  signal,
  leaseMs = 60000,
  pollMs = 500,
  onError = () => {},
}) {
  if (
    typeof handle !== 'function' ||
    !Number.isInteger(leaseMs) ||
    leaseMs < 3000 ||
    leaseMs > 300000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 50
  )
    throw new Error(
      'Provide a handler, a 3000–300000 ms lease and pollMs >=50.',
    );
  const { actor } = await client.info();
  if (actor === 'owner')
    throw new Error(
      'Workers must use an agent credential, never the owner credential.',
    );
  while (!signal?.aborted) {
    const { tasks } = await client.inbox();
    const candidate = tasks.find((task) => task.to === actor && task.claimable);
    if (!candidate) {
      try {
        await delay(pollMs, undefined, { signal });
      } catch (error) {
        if (!signal?.aborted) throw error;
      }
      continue;
    }
    let claim;
    try {
      claim = await client.claim(candidate.id, leaseMs);
    } catch (error) {
      if (
        [
          'TASK_UNAVAILABLE',
          'GRANT_INACTIVE',
          'TASK_NOT_FOUND',
          'ATTEMPTS_EXHAUSTED',
        ].includes(error.code)
      ) {
        if (error.code === 'ATTEMPTS_EXHAUSTED') onError(error);
        try {
          await delay(pollMs, undefined, { signal });
        } catch {
          if (!signal?.aborted) throw error;
        }
        continue;
      }
      throw error;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const heartbeatStop = new AbortController();
    let heartbeatFailure;
    const heartbeat = (async () => {
      while (!heartbeatStop.signal.aborted) {
        try {
          await delay(Math.floor(leaseMs / 3), undefined, {
            signal: heartbeatStop.signal,
          });
        } catch {
          break;
        }
        if (heartbeatStop.signal.aborted) break;
        try {
          await client.heartbeat(candidate.id, claim.claimToken, leaseMs);
        } catch (error) {
          heartbeatFailure = error;
          controller.abort(error);
          break;
        }
      }
    })();
    try {
      const result = await handle({
        task: claim.task,
        signal: controller.signal,
        artifact: (id, value, mediaType) =>
          client.putArtifact(
            candidate.id,
            id,
            value,
            claim.claimToken,
            mediaType,
          ),
        submit: (input, key) =>
          client.submit(
            { ...input, authorityId: claim.task.grantId },
            key,
            claim.claimToken,
          ),
        wait: (id, options) =>
          client.wait(id, { ...options, signal: controller.signal }),
        readArtifact: (id, artifactId) => client.artifact(id, artifactId),
      });
      controller.signal.throwIfAborted();
      heartbeatStop.abort();
      await heartbeat;
      if (heartbeatFailure) throw heartbeatFailure;
      await client.complete(candidate.id, result, claim.claimToken);
    } catch (error) {
      heartbeatStop.abort();
      await heartbeat;
      if (signal?.aborted) continue; // Leave the lease for deliberate recovery.
      try {
        await client.fail(
          candidate.id,
          { reason: 'handler_failed' },
          claim.claimToken,
        );
      } catch (failure) {
        if (
          !['STALE_CLAIM', 'GRANT_INACTIVE', 'UNAUTHENTICATED'].includes(
            failure.code,
          )
        )
          onError(failure);
      }
      onError(error);
    } finally {
      heartbeatStop.abort();
      await heartbeat;
      signal?.removeEventListener('abort', abort);
    }
  }
}
