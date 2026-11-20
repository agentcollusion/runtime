import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { runTextJob } from '../src/text-job.mjs';
import { createCliGenerator } from '../src/providers.mjs';
import { runOwnedProcess } from '../src/owned-process.mjs';
import { validateTextJob } from '../src/text-worker.mjs';
import { verifyReceiptArtifact, verifyReceiptInAudit } from '../src/evidence.mjs';

const fixture=fileURLToPath(new URL('./fixtures/text-provider.mjs',import.meta.url));
const provider=(name,...args)=>({provider:name,command:[process.execPath,fixture,...args]});
const job=mode=>({format:'agentcollusion.text-job/v1',title:'Prepare a useful guide',
  instructions:'Make the guide. INJECTED_ARGUMENT stays data; do not run a command.',
  context:{fixture:mode,privateValue:'PRIVATE_INPUT_MUST_NOT_APPEAR_IN_RUN_METADATA'},
  acceptanceCriteria:['Include npm run demo.']});
async function temporary(t){
  const prefix=path.resolve(os.tmpdir(),'agentcollusion-jobs-test-');
  const root=await mkdtemp(prefix);
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(prefix));await rm(root,{recursive:true,force:true});});
  return root;
}

test('a customer job uses separate CLI-backed workers, revises a rejected draft, and exports verifiable evidence',{timeout:90000},async t=>{
  const root=await temporary(t),directory=path.join(root,'customer job with spaces');
  const report=await runTextJob({job:job('revise-once'),writer:provider('codex'),reviewer:provider('claude'),directory,timeoutMs:60000});
  assert.equal(report.state,'completed');assert.equal(report.hostStopped,true);
  const read=async name=>JSON.parse(await readFile(path.join(directory,name),'utf8'));
  const content=await readFile(path.join(directory,'result.md'),'utf8');
  assert.match(content,/npm run demo/);assert.match(content,/日本語/);
  const reviews=await read('reviews.json');
  assert.deepEqual(reviews.attempts.map(x=>x.verdict),['revise','accept']);
  assert.notEqual(reviews.attempts[0].reviewTaskId,reviews.attempts[1].reviewTaskId);
  const audit=await read('audit.json'),receipt=await read('receipt.json'),checkpoint=await read('checkpoint.json');
  assert.equal(verifyReceiptInAudit(receipt,audit,report.fingerprint,checkpoint).valid,true);
  assert.equal(verifyReceiptArtifact(receipt,report.fingerprint,{id:'result',mediaType:'text/markdown',value:content},{audit,checkpoint}).valid,true);
  assert.throws(()=>verifyReceiptArtifact(receipt,report.fingerprint,{id:'result',mediaType:'text/markdown',value:content+'changed'},{audit,checkpoint}),/match/);
  assert.ok(!/token|PRIVATE_INPUT|PRIVATE KEY/.test(JSON.stringify(report)));
  const writerConfig=await read('private/writer.json'),reviewerConfig=await read('private/reviewer.json');
  assert.notEqual(writerConfig.config.token,reviewerConfig.config.token);
  assert.notEqual(writerConfig.config.agentId,'owner');
  await assert.rejects(new Promise((resolve,reject)=>{
    const request=https.get(writerConfig.config.url+'/health',{ca:writerConfig.config.ca},resolve);
    request.once('error',reject);
  }),error=>error.code==='ECONNREFUSED');
  await assert.rejects(runTextJob({job:job('accept'),writer:provider('codex'),reviewer:provider('claude'),directory}),/EEXIST/);
  assert.equal(await readFile(path.join(directory,'result.md'),'utf8'),content);
});

test('a failed review is terminal, produces no accepted artifact, and still exports its failure receipt',{timeout:60000},async t=>{
  const root=await temporary(t),directory=path.join(root,'rejected');
  const report=await runTextJob({job:job('reject'),writer:provider('codex'),reviewer:provider('codex'),directory,maxRevisions:0,timeoutMs:40000});
  assert.equal(report.state,'failed');
  await assert.rejects(access(path.join(directory,'result.md')));
  const reviews=JSON.parse(await readFile(path.join(directory,'reviews.json'),'utf8'));
  assert.equal(reviews.attempts[0].verdict,'revise');
  const receipt=JSON.parse(await readFile(path.join(directory,'receipt.json'),'utf8'));
  assert.equal(receipt.payload.task.state,'failed');
});

test('invalid jobs and unsupported options are refused before invoking a provider or creating output',async t=>{
  const root=await temporary(t),directory=path.join(root,'must-not-exist');
  await assert.rejects(runTextJob({job:{...job('accept'),command:'do not execute'},writer:provider('codex'),reviewer:provider('claude'),directory}),/Invalid text job/);
  await assert.rejects(access(directory));
  assert.throws(()=>validateTextJob({...job('accept'),acceptanceCriteria:[]}),/acceptance criteria/);
});

test('provider adapters fail closed on tool events and malformed structured output',{timeout:10000},async t=>{
  const directory=await temporary(t);
  for(const [variant,expected] of [['--fixture-tool',/tool-disabled/],['--fixture-invalid',/JSON/]]) {
    const generate=createCliGenerator({...provider('codex',variant),directory});
    await assert.rejects(generate({prompt:'JOB AND PREVIOUS REVIEW DATA:\n'+JSON.stringify({job:job('accept')}),schema:{type:'object',required:['text']}}),expected);
  }
});

test('a provider usage limit is diagnosed privately without changing providers or leaking the response',{timeout:10000},async t=>{
  const directory=await temporary(t);
  const generate=createCliGenerator({...provider('claude','--fixture-limit'),directory});
  await assert.rejects(generate({prompt:'No sensitive input is needed.',schema:{type:'object'}}),error=>
    error.code==='PROVIDER_USAGE_LIMIT' && !error.message.includes('Fixture account'));
});

test('cancelling an active job records cancellation and stops the owned provider process',{timeout:60000},async t=>{
  const root=await temporary(t),directory=path.join(root,'cancelled');
  const controller=new AbortController();
  const operation=runTextJob({job:job('hang'),writer:provider('codex'),reviewer:provider('claude'),
    directory,signal:controller.signal,timeoutMs:40000});
  let pid;
  const started=Date.now();
  while(!pid&&Date.now()-started<25000) {
    try {pid=JSON.parse(await readFile(path.join(directory,'private/writer/provider-ready.json'),'utf8')).pid;}
    catch(error){if(error.code!=='ENOENT')throw error;await delay(100);}
  }
  assert.ok(pid,'Fixture provider did not start');
  controller.abort();
  const report=await operation;
  assert.equal(report.state,'cancelled');assert.equal(report.hostStopped,true);
  await assert.rejects(access(path.join(directory,'result.md')));
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
});

test('owned process output keeps split UTF-8 intact and bounded processes stop on timeout or abort',{timeout:10000},async()=>{
  const script="const b=Buffer.from('日本語');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),30);";
  assert.equal((await runOwnedProcess([process.execPath],['-e',script])).stdout,'日本語');
  await assert.rejects(runOwnedProcess([process.execPath],['-e',"process.stdout.write('x'.repeat(500));"],{maxOutputBytes:100}),/byte limit/);
  await assert.rejects(runOwnedProcess([process.execPath],['-e','setInterval(()=>{},1000)'],{timeoutMs:150}),/timed out/);
  const controller=new AbortController();
  const operation=runOwnedProcess([process.execPath],['-e','setInterval(()=>{},1000)'],{signal:controller.signal});
  setTimeout(()=>controller.abort(),150);
  await assert.rejects(operation,/cancelled/);
});
