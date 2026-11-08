#!/usr/bin/env node
import { constants } from 'node:fs';
import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import manifest from '../package.json' with { type: 'json' };
import { RuntimeClient } from '../src/client.mjs';
import { createRuntime } from '../src/server.mjs';
import { createAuditCheckpoint, verifyAuditExtension, verifyEvidence, verifyReceiptInAudit } from '../src/evidence.mjs';
import { protectPath, writePrivateJson, withPrivateJsonOutput } from '../src/security.mjs';
import { identifier } from '../src/errors.mjs';
import { runDemo } from '../examples/demo.mjs';

const help = `AgentCollusion Runtime ${manifest.version}

Connect independent agents. Keep scoped work, artifacts and receipts together.
Requires Node.js >=22.13. The server binds only to 127.0.0.1 with pinned TLS.

  agentcollusion demo [--out NEW_DIRECTORY]
  agentcollusion serve [--dir .agentcollusion] [--port 4318]
  agentcollusion info --config CLIENT_JSON
  agentcollusion agent add ID --config OWNER_JSON [--out NEW_CLIENT_JSON]
  agentcollusion agent revoke ID --config OWNER_JSON
  agentcollusion grant create --file GRANT_JSON --config OWNER_JSON
  agentcollusion grant revoke ID --config CLIENT_JSON
  agentcollusion task submit --file TASK_JSON --key UNIQUE_KEY --config CLIENT_JSON
  agentcollusion task list --config CLIENT_JSON
  agentcollusion task show ID --config CLIENT_JSON
  agentcollusion task claim ID --out NEW_CLAIM_JSON --config CLIENT_JSON
  agentcollusion task heartbeat ID --claim CLAIM_JSON --config CLIENT_JSON
  agentcollusion artifact put TASK_ID ARTIFACT_ID --file FILE --claim CLAIM_JSON --config CLIENT_JSON
  agentcollusion artifact get TASK_ID ARTIFACT_ID --config CLIENT_JSON
  agentcollusion task complete ID --file RESULT_JSON --claim CLAIM_JSON --config CLIENT_JSON
  agentcollusion task fail ID --file RESULT_JSON --claim CLAIM_JSON --config CLIENT_JSON
  agentcollusion task cancel ID --config CLIENT_JSON
  agentcollusion task receipt ID --out NEW_FILE --config CLIENT_JSON
  agentcollusion audit --out NEW_FILE --config OWNER_JSON
  agentcollusion checkpoint AUDIT_FILE --out NEW_FILE --fingerprint TRUSTED_SHA256
  agentcollusion verify FILE --fingerprint TRUSTED_SHA256 [--checkpoint RETAINED_FILE]
  agentcollusion verify RECEIPT_FILE --audit AUDIT_FILE --fingerprint TRUSTED_SHA256 [--checkpoint RETAINED_FILE]

Documentation: https://agentcollusion.ai/service/runtime
Do not share credential files or owner.json. A runtime grant controls its APIs;
it does not sandbox your agent's external tools or processes.
`;

// Legacy CLI exports indent every event. The 32 MiB on-disk audit cap does not
// include that whitespace or each event's exported hash.
async function readEvidenceJson(filename, limit = 128 * 1024 * 1024) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error(`Expected a regular evidence file of at most ${limit} bytes.`);
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error('Evidence file size changed while reading.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally {
    await handle.close();
  }
}

async function main() {
  const positionals = [],
    flags = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(help);
      return;
    }
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (
        ![
          'out',
          'dir',
          'port',
          'config',
          'file',
          'key',
          'claim',
          'fingerprint',
          'checkpoint',
          'audit',
        ].includes(key) ||
        flags[key] !== undefined ||
        !args[i + 1] ||
        args[i + 1].startsWith('--')
      )
        throw new Error(`Unknown, duplicate or incomplete flag: ${args[i]}`);
      flags[key] = args[++i];
    } else positionals.push(args[i]);
  }
  const [command, action, id, artifactId] = positionals;
  if (!command || command === 'help') {
    console.log(help);
    return;
  }
  if (positionals.length > 4)
    throw new Error('Unexpected positional arguments. Use --help.');
  const need = (key) => {
    if (!flags[key]) throw new Error(`--${key} is required.`);
    return flags[key];
  };
  const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  const save = async (file, value, indent = 2) => {
    await writeFile(file, JSON.stringify(value, null, indent) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(`Saved ${path.resolve(file)}`);
  };
  if (command === 'verify' || command === 'checkpoint') {
    if (!action || positionals.length !== 2) throw new Error('Specify exactly one evidence file.');
    const allowed = command === 'verify' ? ['fingerprint', 'audit', 'checkpoint'] : ['fingerprint', 'out'];
    if (Object.keys(flags).some(flag => !allowed.includes(flag)))
      throw new Error(`Unexpected flag for ${command}. Use --help.`);
    const fingerprint = need('fingerprint');
    const evidence = await readEvidenceJson(action);
    if (command === 'checkpoint') {
      await save(need('out'), createAuditCheckpoint(evidence, fingerprint));
      return;
    }
    const checkpoint = flags.checkpoint === undefined ? undefined : await readEvidenceJson(flags.checkpoint, 4096);
    if (flags.audit) print(verifyReceiptInAudit(evidence, await readEvidenceJson(flags.audit), fingerprint, checkpoint));
    else if (checkpoint !== undefined) print(verifyAuditExtension(evidence, fingerprint, checkpoint));
    else print(verifyEvidence(evidence, fingerprint));
    return;
  }
  if (flags.checkpoint || flags.audit) throw new Error('--checkpoint and --audit are verify options.');
  if (command === 'demo') {
    print(await runDemo({ directory: flags.out }));
    return;
  }
  if (command === 'serve') {
    const host = await createRuntime({
      directory: flags.dir,
      port: flags.port === undefined ? 4318 : Number(flags.port),
    });
    try {
      const clients = path.join(host.store.directory, 'clients');
      await mkdir(clients, { recursive: true, mode: 0o700 });
      protectPath(clients, true);
      const ownerConfig = path.join(
        clients,
        `owner-${new URL(host.url).port}.json`,
      );
      const config = {
        url: host.url,
        token: host.store.identity.token,
        ca: host.certificate,
        agentId: 'owner',
        fingerprint: host.store.keyFingerprint,
      };
      try {
        writePrivateJson(ownerConfig, config);
      } catch (error) {
        if (
          error.code !== 'EEXIST' ||
          JSON.stringify(await json(ownerConfig)) !== JSON.stringify(config)
        ) {
          throw error;
        }
      }
      console.log(
        `AgentCollusion Runtime listening at ${host.url}\nOwner client config: ${ownerConfig}\nEvidence key fingerprint: ${host.store.keyFingerprint}\nKeep this process running. Ctrl+C stops this host.`,
      );
      await new Promise((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
    } finally {
      await host.close();
    }
    return;
  }
  const configPath = need('config');
  const config = await json(configPath);
  const client = new RuntimeClient(config);
  const claim = async () => {
    const value = await json(need('claim'));
    if (value.task.id !== id)
      throw new Error('Claim file belongs to another task.');
    return value.claimToken;
  };
  let result;
  if (command === 'info') result = await client.info();
  else if (command === 'agent' && action === 'add') {
    if (!id) throw new Error('An agent ID is required.');
    identifier(id, 'agent ID');
    const output =
      flags.out || path.join(path.dirname(configPath), `agent-${id}.json`);
    // Refuse existing destinations before creating a credential that cannot be saved.
    try {
      await readFile(output);
      throw new Error(
        'The client destination already exists. Choose a new path.',
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let agent;
    try {
      await withPrivateJsonOutput(output, async () => {
        agent = await client.createAgent({ id });
        return {
          url: client.url, token: agent.token, ca: config.ca,
          agentId: agent.id, fingerprint: config.fingerprint,
        };
      });
    } catch (error) {
      if (agent) {
        try {
          await client.revokeAgent(agent.id);
        } catch {
          throw new Error(`Credential output failed and automatic revocation could not be confirmed. Inspect and revoke agent ${id} using the owner configuration. ${error.message}`, { cause: error });
        }
        throw new Error(`Credential output failed; agent ${id} was revoked. Its ID stays reserved; choose a new ID. ${error.message}`, { cause: error });
      }
      throw error;
    }
    console.log(
      `Created ${id}. Private client config: ${path.resolve(output)}`,
    );
    return;
  } else if (command === 'agent' && action === 'revoke')
    result = await client.revokeAgent(id);
  else if (command === 'grant' && action === 'create')
    result = await client.grant(await json(need('file')));
  else if (command === 'grant' && action === 'revoke')
    result = await client.revokeGrant(id);
  else if (command === 'task' && action === 'submit')
    result = await client.submit(
      await json(need('file')),
      need('key'),
      flags.claim ? (await json(flags.claim)).claimToken : undefined,
    );
  else if (command === 'task' && action === 'list')
    result = await client.tasks();
  else if (command === 'task' && action === 'show')
    result = await client.task(id);
  else if (command === 'task' && action === 'claim') {
    const output = need('out');
    try {
      await readFile(output);
      throw new Error(
        'The claim destination already exists. Choose a new path.',
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await withPrivateJsonOutput(output, () => client.claim(id));
    console.log(`Private claim saved to ${path.resolve(output)}`);
    return;
  } else if (command === 'task' && action === 'heartbeat')
    result = await client.heartbeat(id, await claim());
  else if (command === 'task' && action === 'complete')
    result = await client.complete(id, await json(need('file')), await claim());
  else if (command === 'task' && action === 'fail')
    result = await client.fail(id, await json(need('file')), await claim());
  else if (command === 'task' && action === 'cancel')
    result = await client.cancel(id);
  else if (command === 'task' && action === 'receipt') {
    await save(need('out'), await client.receipt(id));
    return;
  } else if (command === 'artifact' && action === 'put') {
    const file = need('file');
    const isJson = file.endsWith('.json');
    result = await client.putArtifact(
      id,
      artifactId,
      isJson ? await json(file) : await readFile(file, 'utf8'),
      await claim(),
      isJson ? 'application/json' : 'text/plain',
    );
  } else if (command === 'artifact' && action === 'get')
    result = await client.artifact(id, artifactId);
  else if (command === 'audit') {
    await save(need('out'), await client.audit(), 0);
    return;
  } else throw new Error('Unknown command. Use --help.');
  print(result);
}

main().catch((error) => {
  console.error(`${error.code || 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
});
