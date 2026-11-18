import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm,access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const argv=process.argv.slice(2);
const option=(name,fallback)=>{const index=argv.indexOf(name);return index<0 ? fallback : argv[index+1];};
const endpoint=option('--endpoint',process.env.CODE_MODE_MODEL_ENDPOINT);
const model=option('--model',process.env.CODE_MODE_MODEL_NAME);
if(!endpoint || !model)throw new Error('Pass --endpoint and --model for a real model');
const dir=await mkdtemp(path.join(process.cwd(),'code-mode-agent-test-'));
process.env.CODE_MODE_DATA_DIR=path.join(dir,'data');
process.env.CODE_MODE_POLICY_PATH=path.join(dir,'policy.json');
process.env.CODE_MODE_PERMISSION_MODE=option('--permission-mode','autoApprove');
await import('./code-mode-settings.mjs').then(m=>m.setProjectEnabled(process.env.CODE_MODE_DATA_DIR,dir));
if(process.env.CODE_MODE_PERMISSION_MODE==='auto'){
  process.env.CODE_MODE_CLASSIFIER_ENDPOINT=endpoint;process.env.CODE_MODE_CLASSIFIER_MODEL=model;
}else{
  delete process.env.CODE_MODE_CLASSIFIER_ENDPOINT;delete process.env.CODE_MODE_CLASSIFIER_MODEL;
}
process.env.CODE_MODE_ISOLATION=option('--isolation','docker');
await writeFile(process.env.CODE_MODE_POLICY_PATH,JSON.stringify({deny:['Bash']}));
const {CodeModeAgent}=await import('./code-mode-agent.mjs');
let modelRequests=0;
const agent=new CodeModeAgent({endpoint,model,cwd:dir,apiKey:process.env.CODE_MODE_MODEL_API_KEY,provider:option('--provider','openai'),toolProtocol:option('--tool-protocol','auto'),request:(...args)=>{modelRequests++;return fetch(...args);}});
const hashes=Object.fromEntries(await Promise.all(['code-mode-agent.mjs','code-mode-model.mjs','code-mode-policy.mjs','execution-manager.mjs','code-mode-runtime.mjs','code-mode-worker.mjs'].map(async file=>[file,createHash('sha256').update(await readFile(new URL(file,import.meta.url))).digest('hex')])));
const report={generatedAt:new Date().toISOString(),model,provider:agent.provider,permissionMode:agent.mode,isolation:process.env.CODE_MODE_ISOLATION,passed:false,checks:{},sourceHashes:hashes};
const started=performance.now();
try{
  await agent.turn('Use exactly one REPL invocation with file helpers only for all these steps: create retry.js containing exactly "export const maxAttempts = 3;\\n"; then edit 3 to 5 with edit(); then read retry.js twice concurrently with Promise.all; check that both reads match and contain maxAttempts = 5, and return a short success value. Finish by reporting success. Do not use shell commands or external MCP tools.');
  assert.equal(await readFile(path.join(dir,'retry.js'),'utf8'),'export const maxAttempts = 5;\n');
  const jobs=agent.snapshot();
  assert.equal(jobs.length,1,'related helper calls must be batched in one REPL');assert.ok(jobs.every(job=>job.status==='completed'));
  const operations=jobs.flatMap(job=>job.result.operations);
  assert.ok(operations.some(op=>op.operation==='write'));assert.ok(operations.some(op=>op.operation==='edit'));
  assert.ok(operations.filter(op=>op.operation==='read').length>=2);
  report.checks={modelSelectedREPL:true,batchedInOneREPL:true,fileWriteAndEditVerified:true,readHelpersVerified:true};
  if(agent.mode==='autoApprove'){
    await assert.rejects(access(path.join(process.env.CODE_MODE_DATA_DIR,'broker.json')),{code:'ENOENT'});
    await assert.rejects(access(path.join(process.env.CODE_MODE_DATA_DIR,'approvals.jsonl')),{code:'ENOENT'});
    assert.ok(jobs.every(job=>!job.pendingApprovals?.length));
    report.checks.noBrokerOrApprovalQueue=true;
    report.checks.noClassifierConfigured=true;
  }
  report.jobs=jobs.map(job=>({id:job.id,status:job.status,operations:job.result.operations.map(op=>op.operation)}));
  report.passed=true;
  console.log(`PASS: real model selected REPL; ${agent.mode}, ${agent.resolvedProtocol}, ${process.env.CODE_MODE_ISOLATION}; write/edit/read effects verified`);
}catch(error){report.error=error.message;process.exitCode=1;console.error(`FAIL: terminal real-model verification: ${error.message}`);}
finally{await agent.close();report.failures=agent.snapshot().filter(job=>job.status!=='completed').map(job=>({id:job.id,status:job.status,error:job.result?.error,code:job.result?.transcript}));report.finishedAt=new Date().toISOString();report.elapsedMs=Math.round(performance.now()-started);report.modelRequests=modelRequests;report.toolProtocol=agent.resolvedProtocol;await writeFile(option('--report','live-verification/terminal-report.json'),JSON.stringify(report,null,2)+'\n');await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
