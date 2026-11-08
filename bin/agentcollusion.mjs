#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeClient } from '../src/client.mjs';
import { createRuntime } from '../src/server.mjs';
import { verifyEvidence } from '../src/evidence.mjs';
import { protectPath, writePrivateJson, withPrivateJsonOutput } from '../src/security.mjs';
import { identifier } from '../src/errors.mjs';
import { runDemo } from '../examples/demo.mjs';

const help = `AgentCollusion Runtime 0.1.0-beta.1

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
  agentcollusion verify FILE --fingerprint TRUSTED_SHA256

Documentation: https://agentcollusion.ai/service/runtime
Do not share credential files or owner.json. A runtime grant controls its APIs;
it does not sandbox your agent's external tools or processes.
`;

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
  const save = async (file, value) => {
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(`Saved ${path.resolve(file)}`);
  };
  if (command === 'verify') {
    print(verifyEvidence(await json(action), need('fingerprint')));
    return;
  }
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
    await save(need('out'), await client.audit());
    return;
  } else throw new Error('Unknown command. Use --help.');
  print(result);
}

main().catch((error) => {
  console.error(`${error.code || 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
});
