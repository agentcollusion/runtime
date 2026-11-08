import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
assert.equal(manifest.name, '@agentcollusion/runtime');
assert.notEqual(manifest.private, true);
assert.deepEqual(manifest.dependencies, { selfsigned: '5.5.0' });
assert.equal(manifest.publishConfig.access, 'public');
for (const hook of [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'postpack',
])
  assert.equal(
    manifest.scripts[hook],
    undefined,
    `Unexpected package lifecycle hook: ${hook}`,
  );
if (!process.env.npm_execpath)
  throw new Error('Run this check with npm run check:package.');
const packed = spawnSync(
  process.execPath,
  [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true },
);
assert.equal(packed.status, 0, packed.stderr);
const [report] = JSON.parse(packed.stdout);
const expected = [
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'package.json',
  'bin/agentcollusion.mjs',
  'examples/demo-agent.mjs',
  'examples/demo.mjs',
  'examples/vscode/tasks.json',
  'src/client.mjs',
  'src/errors.mjs',
  'src/evidence.mjs',
  'src/security.mjs',
  'src/server.mjs',
  'src/store.mjs',
  'src/worker.mjs',
  'types/client.d.mts',
  'types/contracts.d.mts',
  'types/evidence.d.mts',
  'types/server.d.mts',
  'types/worker.d.mts',
];
assert.deepEqual(report.files.map((file) => file.path).sort(), expected.sort());
assert.equal(report.bundled.length, 0);
console.log(
  `Package allowlist verified: ${report.entryCount} files, ${report.size} bytes packed; no credentials, database, private website or bundled dependencies.`,
);
