import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const args=process.argv.slice(2);
if(args.includes('--version')){console.log('fixture-provider 1.0 (not a real model)');process.exit(0);}
if(args.includes('--fixture-limit')){console.log(JSON.stringify({type:'result',is_error:true,api_error:'usage_limit_reached',api_error_status:429,result:'Fixture account limit'}));process.exit(1);}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
assert.ok(!args.some(x=>x.includes('INJECTED_ARGUMENT')),'Task text became an executable argument');
const review=prompt.includes('JOB AND DRAFT DATA:\n');
const marker=review?'JOB AND DRAFT DATA:\n':'JOB AND PREVIOUS REVIEW DATA:\n';
const input=JSON.parse(prompt.split(marker)[1]);
if(input.job.context.fixture==='hang') {
  await writeFile(path.join(path.dirname(process.cwd()),'provider-ready.json'),JSON.stringify({pid:process.pid}));
  setInterval(()=>{},1000);
  await new Promise(()=>{});
}
const data=review
  ? input.job.context.fixture==='reject'||input.draft.startsWith('Draft')
    ? {verdict:'revise',issues:['Include the requested start command.'],rationale:'The acceptance criterion is not met.'}
    : {verdict:'accept',issues:[],rationale:'All supplied acceptance criteria are represented.'}
  : {text:input.previous||input.job.context.fixture==='accept'
    ? '# Guide\n\nRun npm run demo.\n\nTwo agents return a useful artifact. 日本語も保持します。\n'
    : 'Draft awaiting a revision.'};
if(args.includes('--fixture-invalid')){console.log('not valid json');process.exit(0);}
if(args.includes('--output-schema')) {
  assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  const schema=JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8'));
  assert.ok(schema.required.length);
  await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(data));
  if(args.includes('--fixture-tool'))console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
} else {
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--restricted'));
  assert.equal(args[args.indexOf('--tools')+1],'');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:data,usage:{input_tokens:1,output_tokens:1}}));
}
