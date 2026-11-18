import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const argv=process.argv.slice(2);
const option=(name,fallback)=>{const index=argv.indexOf(name);return index<0 ? fallback : argv[index+1];};
const endpoint=option('--endpoint',process.env.CODE_MODE_MODEL_ENDPOINT);
const model=option('--model',process.env.CODE_MODE_MODEL_NAME);
if(!endpoint || !model)throw new Error('Pass --endpoint and --model for a real tool-calling model');
const dir=await mkdtemp(path.join(process.cwd(),'code-mode-agent-test-'));
process.env.CODE_MODE_DATA_DIR=path.join(dir,'data');
process.env.CODE_MODE_POLICY_PATH=path.join(dir,'policy.json');
process.env.CODE_MODE_PERMISSION_MODE='auto';
await import('./code-mode-settings.mjs').then(m=>m.setProjectEnabled(process.env.CODE_MODE_DATA_DIR,dir));
process.env.CODE_MODE_CLASSIFIER_ENDPOINT=endpoint;process.env.CODE_MODE_CLASSIFIER_MODEL=model;
process.env.CODE_MODE_ISOLATION=option('--isolation','docker');
await writeFile(process.env.CODE_MODE_POLICY_PATH,JSON.stringify({deny:['Bash']}));
const {CodeModeAgent}=await import('./code-mode-agent.mjs');
const agent=new CodeModeAgent({endpoint,model,cwd:dir,apiKey:process.env.CODE_MODE_MODEL_API_KEY});
const report={generatedAt:new Date().toISOString(),model,isolation:process.env.CODE_MODE_ISOLATION,passed:false,checks:{},runtimeHash:createHash('sha256').update(await readFile(new URL('./code-mode-runtime.mjs',import.meta.url))).digest('hex')};
try{
  await agent.turn('Use REPL file helpers only. Create retry.js containing exactly "export const maxAttempts = 3;\\n". Then edit 3 to 5 with edit(). Read retry.js twice concurrently with Promise.all, check that both reads match and contain maxAttempts = 5, and return a short success value. Finish by reporting success. Do not use shell commands or external MCP tools.');
  assert.equal(await readFile(path.join(dir,'retry.js'),'utf8'),'export const maxAttempts = 5;\n');
  const jobs=agent.snapshot();
  assert.ok(jobs.length>0);assert.ok(jobs.every(job=>job.status==='completed'));
  const operations=jobs.flatMap(job=>job.result.operations);
  assert.ok(operations.some(op=>op.operation==='write'));assert.ok(operations.some(op=>op.operation==='edit'));
  assert.ok(operations.filter(op=>op.operation==='read').length>=2);
  report.checks={modelSelectedREPL:true,codeExecutedInAuto:true,fileWriteAndEditVerified:true,readHelpersVerified:true};
  report.jobs=jobs.map(job=>({id:job.id,status:job.status,operations:job.result.operations.map(op=>op.operation)}));
  report.passed=true;
  console.log('PASS: real model selected REPL in the terminal agent, auto approved generated code, write/edit/read effects verified in Docker');
}catch(error){report.error=error.message;process.exitCode=1;console.error(`FAIL: terminal real-model verification: ${error.message}`);}
finally{await agent.close();report.finishedAt=new Date().toISOString();await writeFile(option('--report','live-verification/terminal-report.json'),JSON.stringify(report,null,2)+'\n');await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
