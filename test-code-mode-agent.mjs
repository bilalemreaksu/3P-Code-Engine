import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { terminalOptions,runTerminal } from './code-mode-cli.mjs';

const dir=await mkdtemp(path.join(process.cwd(),'code-mode-agent-test-'));
process.env.CODE_MODE_DATA_DIR=path.join(dir,'data');
process.env.CODE_MODE_POLICY_PATH=path.join(dir,'policy.json');
process.env.CODE_MODE_PERMISSION_MODE='auto';
process.env.CODE_MODE_ISOLATION='off';
await writeFile(process.env.CODE_MODE_POLICY_PATH,'{}');
let classifications=0, action='write', modelCalls=0;
const server=createServer(async(req,res)=>{
  try {
    let body='';for await(const part of req)body+=part;
    const request=JSON.parse(body);
    res.setHeader('content-type','application/json');
    if(!request.tools){classifications++;const proposed=JSON.parse(request.messages[1].content).code;res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({decision:proposed.includes('reject-me')?'deny':'allow'})}}]}));return;}
    assert.deepEqual(request.tools.map(t=>t.function.name),['REPL','code_status','code_cancel']);
    modelCalls++;
    if(request.messages.at(-1).role==='tool'){res.end(JSON.stringify({choices:[{message:{content:'completed'}}]}));return;}
    const name=action==='illegal'?'Bash':'REPL';
    const args=action==='illegal'?{command:'must-not-run'}:action==='denied'?{code:'return "reject-me";'}:action==='background'?{code:'await new Promise(r=>setTimeout(r,400)); return "background-done";',background:true}:{code:'await write("result.txt","terminal-ok");\n({text:await read("result.txt")})'};
    res.end(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:`call-${modelCalls}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]}));
  }catch(error){res.statusCode=500;res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
process.env.CODE_MODE_CLASSIFIER_ENDPOINT=endpoint;process.env.CODE_MODE_CLASSIFIER_MODEL='fixture';
const {CodeModeAgent}=await import('./code-mode-agent.mjs');
const agent=new CodeModeAgent({endpoint,model:'fixture',cwd:dir});
let resumed;
try {
  assert.equal(await agent.turn('Create the result file'),'completed');
  assert.equal(await readFile(path.join(dir,'result.txt'),'utf8'),'terminal-ok');
  assert.equal(classifications,1);
  resumed=await CodeModeAgent.resume(agent.id,{endpoint,model:'fixture'});
  assert.equal(resumed.messages.length,agent.messages.length);
  assert.equal(resumed.cwd,dir);
  const interrupted=new CodeModeAgent({endpoint,model:'fixture',cwd:dir,id:'interrupted-session',messages:[{role:'user',content:'Interrupted action'},{role:'assistant',content:null,tool_calls:[{id:'unfinished-call',type:'function',function:{name:'REPL',arguments:'{"code":"must not replay"}'}}]}]});
  await interrupted.save();
  const recovered=await CodeModeAgent.resume(interrupted.id,{endpoint,model:'fixture'});
  assert.equal(recovered.messages.at(-1).tool_call_id,'unfinished-call');
  assert.match(recovered.messages.at(-1).content,/effects are unknown/);
  action='illegal';await resumed.turn('Try an unavailable tool');
  assert.match(resumed.messages.at(-2).content,/Unavailable tool: Bash/);
  action='denied';await resumed.turn('Reject this specimen');
  assert.match(resumed.messages.at(-2).content,/classifier denied REPL/);
  action='background';await resumed.turn('Start background work');
  const id=resumed.jobs.at(-1);assert.ok(resumed.backgroundJobs.has(id));
  assert.equal(resumed.snapshot().at(-1).status,'running');
  action='illegal';await resumed.turn('Can keep talking while it runs');
  assert.equal(resumed.active,false);
  await Promise.all([...resumed.pending]);
  await resumed.turn('Background code completed',undefined,{backgroundJobId:id});
  assert.ok((await CodeModeAgent.resume(resumed.id,{endpoint,model:'fixture'})).deliveredBackground.has(id));
  await assert.rejects(resumed.execute('code_status',{jobId:'unowned'}),/does not belong/);
  await assert.rejects(resumed.execute('REPL',{code:'1',cwd:'C:/'}),/Unknown REPL argument/);
  process.env.CODE_MODE_PERMISSION_MODE='default';
  await assert.rejects(CodeModeAgent.resume(agent.id,{endpoint,model:'fixture'}),/permission mode auto/);
  process.env.CODE_MODE_PERMISSION_MODE='auto';
  const env={};const options=await terminalOptions(['--endpoint',endpoint,'--model','fixture','--cwd',dir],env);
  assert.equal(env.CODE_MODE_PERMISSION_MODE,'auto');assert.equal(env.CODE_MODE_CLASSIFIER_ENDPOINT,endpoint);
  // Exercise the real terminal stream: Ctrl+O, expand a Code row, return,
  // and exit. No separate viewer or native app is involved.
  const input=new PassThrough(),output=new PassThrough();let rendered='';
  input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};output.isTTY=true;
  output.on('data',chunk=>{rendered+=chunk;});
  const ui=runTerminal({...options,resume:agent.id},input,output);
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{output.removeListener('data',check);reject(new Error('Terminal did not open'));},5000);
    const check=()=>{if(rendered.includes('Ctrl+O')){clearTimeout(timeout);output.removeListener('data',check);resolve();}};
    output.on('data',check);check();
  });
  input.emit('keypress','',{ctrl:true,name:'o'});input.emit('keypress','',{name:'return'});input.emit('keypress','',{ctrl:true,name:'o'});
  input.emit('keypress','/exit',{});input.emit('keypress','',{name:'return'});
  await ui;
  assert.equal(input.isRaw,false);assert.equal(input.listenerCount('keypress'),0);
  assert.match(rendered,/Code Mode/);assert.match(rendered,/Code/);assert.match(rendered,/write/);
  console.log('PASS: terminal model loop exposes only Code Mode, real auto classification, refusal, background conversation, resume and inline transcript controls');
}finally{await agent.close();await resumed?.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
