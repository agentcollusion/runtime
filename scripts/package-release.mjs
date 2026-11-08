import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = new URL('..', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('package.json', root), 'utf8'),
);
const tag = process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${manifest.version}`)
  throw new Error('Release tag must exactly match package.json version.');
if (!process.env.npm_execpath)
  throw new Error('Run with npm run package:release.');
const sourceState = spawnSync(
  'git',
  ['status', '--porcelain=v1', '--untracked-files=all', '--', '.'],
  { cwd: root, encoding: 'utf8', windowsHide: true },
);
if (sourceState.status !== 0 || sourceState.stdout.trim())
  throw new Error('Release provenance requires clean, committed package source.');
const output = new URL('release/', root);
mkdirSync(output, { recursive: true });
const packed = spawnSync(
  process.execPath,
  [
    process.env.npm_execpath,
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    'release',
  ],
  { cwd: root, encoding: 'utf8', windowsHide: true },
);
if (packed.status !== 0)
  throw new Error(packed.stderr || 'Package creation failed.');
const [report] = JSON.parse(packed.stdout);
const filename = `agentcollusion-runtime-${manifest.version}.tgz`;
if (report.filename !== filename || path.basename(filename) !== filename)
  throw new Error('Unexpected release filename.');
const sha256 = createHash('sha256')
  .update(readFileSync(new URL(filename, output)))
  .digest('hex');
const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});
if (commit.status !== 0)
  throw new Error(
    'A committed source revision is required for release provenance.',
  );
const provenance = {
  format: 'agentcollusion-package-provenance/v1',
  name: manifest.name,
  version: manifest.version,
  tag: tag || null,
  sourceCommit: commit.stdout.trim(),
  archive: filename,
  sha256,
  files: report.files.map((file) => file.path),
  note: 'Build metadata and checksum. This file is not an independent signature or reproducible-build attestation.',
};
writeFileSync(new URL('SHA256SUMS', output), `${sha256}  ${filename}\n`);
writeFileSync(
  new URL('provenance.json', output),
  JSON.stringify(provenance, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    archive: filename,
    sha256,
    sourceCommit: provenance.sourceCommit,
  }),
);
