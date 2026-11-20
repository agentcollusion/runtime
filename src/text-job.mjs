import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './server.mjs';
import { RuntimeClient } from './client.mjs';
import { createAuditCheckpoint, verifyReceiptInAudit, verifyReceiptArtifact } from './evidence.mjs';
import { protectPath, writePrivateJson } from './security.mjs';
import { probeProvider } from './providers.mjs';
import { runOwnedProcess } from './owned-process.mjs';
import { validateTextJob } from './text-worker.mjs';

const workerScript=fileURLToPath(new URL('../bin/text-worker.mjs',import.meta.url));

export async function runTextJob({ job, writer, reviewer, directory, signal,
  timeoutMs=600000, maxRevisions=1 }={}) {
  validateTextJob(job);
  if (!writer || !reviewer || !['codex','claude'].includes(writer.provider) ||
      !['codex','claude'].includes(reviewer.provider) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs<10000 || timeoutMs>900000 ||
      !Number.isSafeInteger(maxRevisions) || maxRevisions<0 || maxRevisions>2)
    throw new Error('Choose writer and reviewer providers, 10000–900000 ms timeout, and 0–2 maximum revisions.');
  signal?.throwIfAborted();
  const root=directory?path.resolve(directory):await mkdtemp(path.resolve('agentcollusion-job-'));
  if(directory)await mkdir(root,{recursive:false,mode:0o700});
  protectPath(root,true);
  const privateDirectory=path.join(root,'private');
  await mkdir(privateDirectory,{mode:0o700});
  const controller=new AbortController();
  const deadline=AbortSignal.timeout(timeoutMs);
  const combined=AbortSignal.any([controller.signal,deadline,...(signal?[signal]:[])]);
  let host,owner,taskId,checkpoint,fingerprint,report,workers=[];
  const save=(name,value)=>writeFile(path.join(root,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  try {
    // Version probes do not perform inference. Missing or unsupported CLIs fail before work is submitted.
    const versions=await Promise.all([probeProvider({...writer,signal:combined}),probeProvider({...reviewer,signal:combined})]);
    await writeFile(path.join(privateDirectory,'job.json'),JSON.stringify(job,null,2),{flag:'wx',mode:0o600});
    host=await createRuntime({directory:path.join(privateDirectory,'runtime'),port:0});
    owner=new RuntimeClient({url:host.url,ca:host.certificate,token:host.store.identity.token});
    fingerprint=host.store.keyFingerprint;
    checkpoint=createAuditCheckpoint(await owner.audit(),fingerprint);
    const configurations={};
    for(const [role,provider] of [['writer',writer],['reviewer',reviewer]]) {
      const id=`job-${role}`;
      const credential=await owner.createAgent({id});
      const work=path.join(privateDirectory,role);
      await mkdir(work,{mode:0o700});
      const configFile=path.join(privateDirectory,`${role}.json`);
      writePrivateJson(configFile,{role,provider:provider.provider,command:provider.command,
        directory:work,maxRevisions,reviewerId:'job-reviewer',
        config:{url:host.url,ca:host.certificate,token:credential.token,agentId:id}});
      configurations[role]=configFile;
    }
    const submitted=await owner.submit({to:'job-writer',title:job.title,input:job,
      permissions:[{operation:'task.submit',resource:'job-reviewer'},
        {operation:'artifact.write',resource:'review'},
        {operation:'artifact.write',resource:'reviews'},
        {operation:'artifact.write',resource:'result'}],
      requiredArtifacts:['result','reviews'],delegable:true,
      expiresAt:new Date(Date.now()+timeoutMs).toISOString()},'text-job');
    taskId=submitted.task.id;
    workers=['reviewer','writer'].map(role=>runOwnedProcess([process.execPath],[workerScript,configurations[role]],
      {cwd:privateDirectory,signal:combined,timeoutMs:timeoutMs+5000,maxOutputBytes:65536}));
    // Attach immediately so a failed worker does not become an unhandled rejection.
    const stopped=workers.map(p=>p.then(()=>{throw new Error('A text worker stopped before the job was collected.');}));
    let terminal;
    try {
      terminal=await Promise.race([owner.wait(taskId,{signal:combined,timeoutMs}),...stopped]);
    } catch {
      const current=await owner.task(taskId);
      terminal=['completed','failed','cancelled'].includes(current.state)?current:await owner.cancel(taskId);
    } finally {
      controller.abort();
      await Promise.allSettled(workers);
    }
    const receipt=await owner.receipt(taskId);
    const audit=await owner.audit();
    verifyReceiptInAudit(receipt,audit,fingerprint,checkpoint);
    const exported=['audit.json','receipt.json','checkpoint.json','fingerprint.txt','run.json'];
    if(terminal.state==='completed') {
      const artifact=await owner.artifact(taskId,'result');
      const reviews=await owner.artifact(taskId,'reviews');
      verifyReceiptArtifact(receipt,fingerprint,artifact,{audit,checkpoint});
      verifyReceiptArtifact(receipt,fingerprint,reviews,{audit,checkpoint});
      await writeFile(path.join(root,'result.md'),artifact.value,{flag:'wx',mode:0o600});
      await save('reviews.json',reviews.value);
      exported.push('result.md','reviews.json');
    } else {
      try {
        const reviews=await owner.artifact(taskId,'reviews');
        await save('reviews.json',reviews.value);exported.push('reviews.json');
      } catch(error) { if(!['ARTIFACT_NOT_FOUND','NOT_FOUND'].includes(error.code))throw error; }
    }
    await save('audit.json',audit);
    await save('receipt.json',receipt);
    await save('checkpoint.json',checkpoint);
    await writeFile(path.join(root,'fingerprint.txt'),fingerprint+'\n',{flag:'wx',mode:0o600});
    const diagnostics=[];
    for(const role of ['writer','reviewer']) {
      for(const name of (await readdir(path.join(privateDirectory,role))).filter(name=>/^failure-[a-f0-9-]+\.json$/.test(name))) {
        const diagnostic=JSON.parse(await readFile(path.join(privateDirectory,role,name),'utf8'));
        diagnostics.push({role,code:diagnostic.code,file:`private/${role}/${name}`});
      }
    }
    report={format:'agentcollusion.text-run/v1',evidenceKind:'cli-backed-text-job',state:terminal.state,
      taskId,directory:root,fingerprint,providers:{writer:versions[0],reviewer:versions[1]},
      maxRevisions,evidenceVerified:true,files:exported,privateState:'private/',diagnostics,
      limits:'Two local worker processes under one operator. Provider text tools are disabled. Model review is not proof of truth, cross-owner isolation, or successful external actions.'};
    await host.close();host=undefined;
    report.hostStopped=true;
    await save('run.json',report);
    return report;
  } finally {
    controller.abort();
    await Promise.allSettled(workers);
    await host?.close();
  }
}
