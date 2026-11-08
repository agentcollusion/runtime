import { readFile } from 'node:fs/promises';
import { RuntimeClient } from '../src/client.mjs';

// Deterministic harness adapters, not model intelligence or production isolation.
const [role, configPath, parentTaskId] = process.argv.slice(2);
const client = new RuntimeClient(
  JSON.parse(await readFile(configPath, 'utf8')),
);
if (role === 'writer') {
  const deadline = Date.now() + 15000;
  let task;
  while (!task && Date.now() < deadline) {
    task = (await client.tasks()).tasks.find(
      (t) => t.state === 'queued' && t.to === 'demo-writer',
    );
    if (!task) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!task) throw new Error('No delegated task arrived.');
  const claimed = await client.claim(task.id);
  task = claimed.task;
  const { claimToken } = claimed;
  const draft = `# ${task.input.release} release notes\n\n${task.input.changes.map((change) => `- ${change}`).join('\n')}\n`;
  await client.putArtifact(
    task.id,
    'draft',
    draft,
    claimToken,
    'text/markdown',
  );
  await client.complete(
    task.id,
    { summary: 'Release notes drafted from the supplied change list.' },
    claimToken,
  );
  console.log('Writer delivered draft.');
} else if (role === 'coordinator') {
  const { task, claimToken } = await client.claim(parentTaskId);
  const child = await client.submit(
    {
      to: 'demo-writer',
      title: 'Draft release notes from the supplied changes',
      input: task.input,
      authorityId: task.grantId,
      permissions: [{ operation: 'artifact.write', resource: 'draft' }],
      requiredArtifacts: ['draft'],
      expiresAt: task.expiresAt,
    },
    `draft-${task.id}`,
    claimToken,
  );
  const delivered = await client.wait(child.task.id, { timeoutMs: 15000 });
  if (delivered.state !== 'completed')
    throw new Error('Writer did not deliver the draft.');
  const draft = await client.artifact(child.task.id, 'draft');
  for (const change of task.input.changes)
    if (!draft.value.includes(change))
      throw new Error('A supplied change is missing from the notes.');
  const final = `${draft.value}\n## Review\n\nAll ${task.input.changes.length} supplied changes are represented. This deterministic demo checks delivery and scope, not the factual correctness of a real release.\n`;
  await client.putArtifact(
    task.id,
    'release-notes',
    final,
    claimToken,
    'text/markdown',
  );
  await client.complete(
    task.id,
    {
      summary: 'Release notes delivered with a coverage check.',
      childTaskId: child.task.id,
    },
    claimToken,
  );
  console.log('Coordinator delivered reviewed release notes.');
} else throw new Error('Use the demo harness to launch this adapter.');
