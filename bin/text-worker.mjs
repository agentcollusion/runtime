import { readFile } from 'node:fs/promises';
import { runTextWorker } from '../src/text-worker.mjs';

// This file is started only with a trusted local config from the job runner.
const controller=new AbortController();
process.once('SIGINT',()=>controller.abort());
process.once('SIGTERM',()=>controller.abort());
try {
  const source=await readFile(process.argv[2],'utf8');
  if(Buffer.byteLength(source)>20000)throw new Error('Worker configuration is too large.');
  const options=JSON.parse(source);
  await runTextWorker({...options,signal:controller.signal});
} catch(error) {
  process.stderr.write(`${error.code || 'WORKER_FAILED'}: Text worker stopped. Check the local provider configuration.\n`);
  process.exitCode=1;
}
