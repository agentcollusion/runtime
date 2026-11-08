// Compile only: this consumer exercises the package's exported type conditions.
import { ClientError, RuntimeClient, type RuntimeConfig, type TaskInput } from '@agentcollusion/runtime';
import { createRuntime } from '@agentcollusion/runtime/server';
import { createAuditCheckpoint, digest, verifyAuditExtension, verifyEvidence, verifyReceiptInAudit } from '@agentcollusion/runtime/evidence';
import { runWorker } from '@agentcollusion/runtime/worker';

declare const recipientConfig: RuntimeConfig;
declare const trustedFingerprint: string;
const recipient = new RuntimeClient(recipientConfig);
const host = await createRuntime({ port: 0 });
const owner = new RuntimeClient({ url: host.url, ca: host.certificate, token: host.store.identity.token });
const input = {
  to: 'writer',
  title: 'Draft notes',
  input: { changes: ['Scoped handoffs'] },
  permissions: [{ operation: 'artifact.write', resource: 'draft' }],
  requiredArtifacts: ['draft'],
  expiresAt: new Date(Date.now() + 600000).toISOString(),
} as const satisfies TaskInput;

const { task } = await owner.submit(input, 'release-1');
const summaries = (await owner.tasks()).tasks;
summaries.map((summary) => summary.title);
const controller = new AbortController();
const worker = runWorker({
  client: recipient,
  signal: controller.signal,
  async handle({ task: running, signal, artifact }) {
    signal.throwIfAborted();
    const ref = await artifact('draft', { from: running.from, input: running.input });
    return { artifactId: ref.id, digest: ref.sha256 };
  },
  onError(error) {
    if (error instanceof ClientError) error.code.toLowerCase();
  },
});
const terminal = await owner.wait(task.id, { signal: controller.signal });
terminal.result.artifactId;
const artifact = await owner.artifact(task.id, 'draft');
digest({ mediaType: artifact.mediaType, value: artifact.value });
const receipt = await owner.receipt(task.id);
const verified = verifyEvidence(receipt, trustedFingerprint);
verified.head.sequence.toFixed();
receipt.payload.task.resultSha256.toLowerCase();
const audit = await owner.audit();
const checkpoint = createAuditCheckpoint(audit, trustedFingerprint);
verifyAuditExtension(audit, trustedFingerprint, checkpoint).advanced.valueOf();
verifyReceiptInAudit(receipt, audit, trustedFingerprint, checkpoint).auditHead.hash.toLowerCase();
controller.abort();
await worker;
await host.close();

// @ts-expect-error Unsupported operations cannot enter the typed task scope.
await owner.submit({ ...input, permissions: [{ operation: 'shell.exec', resource: 'draft' }] });
// @ts-expect-error A full body requires an explicit read; list returns summaries.
summaries[0].input;
// @ts-expect-error Completing a task requires a current claim token.
await recipient.complete(task.id, { ok: true });
// @ts-expect-error Runtime artifact values must be JSON data.
await recipient.putArtifact(task.id, 'draft', () => 'not JSON', 'claim');
const raw = await owner.raw('GET', '/health');
// @ts-expect-error The raw transport returns an unvalidated response shape.
raw.status;
