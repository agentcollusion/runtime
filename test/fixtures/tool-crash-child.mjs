import { appendFile } from 'node:fs/promises';
import { createRuntime } from '../../src/server.mjs';

const [directory, effectFile] = process.argv.slice(2);
const host = await createRuntime({
  directory,
  port: 0,
  tools: {
    'apply-fixture': {
      timeoutMs: 15000,
      async run() {
        await appendFile(effectFile, 'effect\n');
        process.send({ phase: 'effect-written' });
        // The parent terminates this owned process before the handler responds.
        return new Promise(() => {});
      },
    },
  },
});
const ownerCredential = host.store.identity.token;
process.send({ phase: 'ready', url: host.url, ca: host.certificate, ownerCredential });
