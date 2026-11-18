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
await import('./code-mode-settings.mjs').then(m => m.setProjectEnabled(process.env.CODE_MODE_DATA_DIR, dir));
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
const {CodeModeAgent,cyclePermissionMode}=await import('./code-mode-agent.mjs');
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
  assert.equal(resumed.snapshot().at(-1).source,'user','jobs started in a real user turn carry that source');
  action='illegal';await resumed.turn('Can keep talking while it runs');
  assert.equal(resumed.active,false);
  await Promise.all([...resumed.pending]);
  // Background completion is a synthetic poll_event, never a user message.
  await resumed.turn('Background code completed',undefined,{backgroundJobId:id,source:'poll_event'});
  await assert.rejects(resumed.turn('nope',undefined,{source:'bogus'}),/Invalid turn source/);
  assert.ok((await CodeModeAgent.resume(resumed.id,{endpoint,model:'fixture'})).deliveredBackground.has(id));
  await assert.rejects(resumed.execute('code_status',{jobId:'unowned'}),/does not belong/);
  await assert.rejects(resumed.execute('REPL',{code:'1',cwd:'C:/'}),/Unknown REPL argument/);
  // The env variable no longer pins a resumed session: the session carries
  // its own mode. An explicit --permission-mode is a trusted choice that
  // moves the session, not a mismatch error.
  process.env.CODE_MODE_PERMISSION_MODE='default';
  const envFree=await CodeModeAgent.resume(agent.id,{endpoint,model:'fixture'});
  assert.equal(envFree.mode,'auto');
  await envFree.close();
  const moved=await CodeModeAgent.resume(agent.id,{endpoint,model:'fixture',permissionMode:'plan'});
  assert.equal(moved.mode,'plan','explicit --permission-mode moves the session');
  await moved.close();
  process.env.CODE_MODE_PERMISSION_MODE='auto';
  // Initial mode, current mode and background eligibility are tracked apart.
  assert.equal(resumed.initialMode,'auto');
  assert.equal(resumed.backgroundEligible,true);
  resumed.setMode('plan');
  assert.equal(resumed.mode,'plan');
  assert.equal(resumed.backgroundEligible,false);
  await assert.rejects(resumed.execute('REPL',{code:'return 1',background:true}),/Background code requires rules, auto or bypassPermissions mode/);
  resumed.setMode('auto');
  assert.equal(resumed.backgroundEligible,true);
  assert.throws(()=>resumed.setMode('yolo'),/Invalid permission mode/);
  assert.equal(cyclePermissionMode('plan'),'auto');
  assert.equal(cyclePermissionMode('bypassPermissions'),'rules');
  // No model-callable tool can change the permission mode.
  await assert.rejects(resumed.execute('set_permission_mode',{mode:'bypassPermissions'}),/Unavailable tool/);
  // A transient lock on the session file must not lose the save: the atomic
  // rename retries briefly (on Windows this is the observed EPERM -4048).
  {
    const { chmodSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const target = path.join(process.env.CODE_MODE_DATA_DIR, `chat-${createHash('sha256').update(resumed.id).digest('hex')}.json`);
    const released = setTimeout(() => chmodSync(target, 0o600), 800);
    chmodSync(target, 0o444);
    try { await resumed.save(); }
    finally { clearTimeout(released); try { chmodSync(target, 0o600); } catch {} }
    assert.ok((await readFile(target, 'utf8')).includes('"codeMode":true'));
  }
  // A process that deletes the save's temp file (observed on Windows: the
  // rename hit ENOENT -4058) must not lose the conversation: each retry uses
  // a fresh temp within the bounded budget, and the last attempt lands after
  // the killer stops.
  {
    const { spawn } = await import('node:child_process');
    const killer = spawn(process.execPath, ['-e', `const {readdirSync,unlinkSync}=require('node:fs');const p=require('node:path');const d=process.argv[1];const end=Date.now()+1500;while(Date.now()<end){try{for(const n of readdirSync(d))if(n.startsWith('chat-')&&n.endsWith('.tmp'))unlinkSync(p.join(d,n));}catch{}}`, process.env.CODE_MODE_DATA_DIR], { stdio: 'ignore' });
    killer.unref();
    try { await resumed.save(); }
    finally { killer.kill(); }
    const { createHash } = await import('node:crypto');
    const saved = await readFile(path.join(process.env.CODE_MODE_DATA_DIR, `chat-${createHash('sha256').update(resumed.id).digest('hex')}.json`), 'utf8');
    assert.ok(saved.includes('"codeMode":true'));
  }
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
  // Shift+Tab and an explicit /mode command change the session mode live.
  const untilRendered=async text=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(rendered.includes(text))return;await new Promise(r=>setTimeout(r,50));}throw new Error(`Terminal never rendered: ${text}`);};
  input.emit('keypress','',{name:'tab',shift:true});
  await untilRendered('İzin modu: auto → bypassPermissions');
  input.emit('keypress','/mode plan');input.emit('keypress','',{name:'return'});
  await untilRendered('İzin modu: bypassPermissions → plan');
  // A background save that stays blocked past its retry budget (the session
  // file stuck read-only) must surface as a visible error — never crash the
  // interactive terminal with an unhandled rejection.
  {
    const { chmodSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const target = path.join(process.env.CODE_MODE_DATA_DIR, `chat-${createHash('sha256').update(agent.id).digest('hex')}.json`);
    chmodSync(target, 0o444);
    try {
      input.emit('keypress','',{name:'tab',shift:true}); // setMode → fire-and-forget save
      await untilRendered('Oturum kaydedilemedi');
    } finally { chmodSync(target, 0o600); }
  }
  input.emit('keypress','/exit',{});input.emit('keypress','',{name:'return'});
  await ui;
  assert.equal(input.isRaw,false);assert.equal(input.listenerCount('keypress'),0);
  assert.match(rendered,/Code Mode/);assert.match(rendered,/Code/);assert.match(rendered,/write/);
  console.log('PASS: terminal model loop exposes only Code Mode, real auto classification, refusal, background conversation, resume and inline transcript controls');
}finally{await agent.close();await resumed?.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
