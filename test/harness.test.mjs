import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const cli = fileURLToPath(new URL('../bin/agentcollusion.mjs', import.meta.url));
const run = (...args) => promisify(execFile)(process.execPath, [cli, ...args], {
  timeout: 45000, windowsHide: true,
});

test('the CLI harness exits, leaves replayable evidence, and refuses to reuse the output directory', { timeout: 60000 }, async (t) => {
  const prefix = path.resolve(os.tmpdir(), 'agentcollusion-harness-test-');
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  const output = path.join(directory, 'fixture with spaces');
  const { stdout } = await run('harness', '--out', output);
  const report = JSON.parse(stdout);
  const evidencePath = (name) => path.join(output, name);
  const read = (name) => readFile(evidencePath(name), 'utf8');
  assert.deepEqual(report, JSON.parse(await read('report.json')));
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.scenarios.map(({ id, status }) => [id, status]), [
    ['delegated-handoff', 'passed'], ['scope-denial', 'passed'], ['stale-claim-fencing', 'passed'],
    ['uncertain-tool-replay', 'passed'], ['offline-evidence', 'passed'],
  ]);
  assert.equal(report.scenarios[3].dispatches, 1);
  assert.equal(report.scenarios[3].state, 'uncertain');
  assert.ok(!/claimToken|ownerToken|BEGIN .*PRIVATE KEY/.test(stdout));
  const verified = await run('verify-artifact', evidencePath('receipt.json'), 'delivery',
    '--file', evidencePath('delivery.txt'), '--audit', evidencePath('audit.json'),
    '--checkpoint', evidencePath('checkpoint.json'), '--fingerprint', (await read('fingerprint.txt')).trim());
  assert.equal(JSON.parse(verified.stdout).sha256, report.scenarios[4].verifiedArtifactSha256);
  await assert.rejects(run('harness', '--out', output), /EEXIST/);
  assert.equal(await read('report.json'), stdout);
});
