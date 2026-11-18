import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseTextMessage, modelMessage } from './code-mode-model.mjs';
import { terminalOptions } from './code-mode-cli.mjs';

const dir = await mkdtemp(path.join(process.cwd(),'code-mode-portable-test-'));
process.env.CODE_MODE_DATA_DIR = path.join(dir,'data');
process.env.CODE_MODE_POLICY_PATH = path.join(dir,'policy.json');
process.env.CODE_MODE_ISOLATION = 'off';
delete process.env.CODE_MODE_PERMISSION_MODE;
delete process.env.CODE_MODE_CLASSIFIER_ENDPOINT;
delete process.env.CODE_MODE_CLASSIFIER_MODEL;
const {setProjectEnabled} = await import('./code-mode-settings.mjs');
await setProjectEnabled(process.env.CODE_MODE_DATA_DIR,dir);
const {startExecution,getJob} = await import('./execution-manager.mjs');
const {CodeModeAgent,agentTools} = await import('./code-mode-agent.mjs');
const {policyCheck,getPermissionMode} = await import('./code-mode-policy.mjs');
const agents = [];
let client;
try {
  assert.equal(getPermissionMode(),'autoApprove');
  const askHook = path.join(dir,'ask-hook.mjs');
  await writeFile(askHook,`console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask'}}));`);
  await writeFile(process.env.CODE_MODE_POLICY_PATH,JSON.stringify({ask:['Write','Bash','mcp__fixture__*'],preToolUse:[{tool:'Write',command:process.execPath,args:[askHook]}]}));
  const decision = () => {throw new Error('No permission request may leave autoApprove');};
  const jobs = await Promise.all([1,2].map(n => startExecution({cwd:dir,background:true,decide:decision,code:`await new Promise(r=>setTimeout(r,100)); await write('parallel-${n}.txt','done'); return ${n}`})));
  for (const job of jobs) {
    assert.equal((await job.promise).ok,true);
    assert.deepEqual(getJob(job.id).pendingApprovals ?? [],[]);
  }
  assert.equal(await readFile(path.join(dir,'parallel-1.txt'),'utf8'),'done');
  assert.equal(await readFile(path.join(dir,'parallel-2.txt'),'utf8'),'done');
  await assert.rejects(policyCheck({deny:['Write']},dir,undefined,'autoApprove',decision)('Write',{file_path:path.join(dir,'blocked')}),/policy denied/);
  const blockHook = path.join(dir,'block-hook.mjs');
  await writeFile(blockHook,'process.exit(2)');
  await assert.rejects(policyCheck({preToolUse:[{tool:'Write',command:process.execPath,args:[blockHook]}]},dir,undefined,'autoApprove',decision)('Write',{}),/hook refused/);

  // Actual MCP stdio default, without classifier or a human approval server.
  client = new Client({name:'unattended-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['server-code-mode.mjs'],cwd:process.cwd(),env:{...process.env,CODE_MODE_PERMISSION_MODE:'',CODE_MODE_MCP_SERVERS:JSON.stringify({fixture:{command:process.execPath,args:[path.join(process.cwd(),'test-mcp-fixture.mjs')]}})}}));
  const response = await client.callTool({name:'code_execute',arguments:{cwd:dir,code:`await write('mcp.txt','before'); await edit('mcp.txt','before','after'); const shell=await run('echo unattended'); await callMcp('fixture','write_marker',{file:${JSON.stringify(path.join(dir,'external.txt'))},text:'mcp-ok'}); return {text:await read('mcp.txt'),shell:shell.ok};`}});
  assert.notEqual(response.isError,true,response.content[0].text);
  assert.equal(await readFile(path.join(dir,'mcp.txt'),'utf8'),'after');
  assert.equal(await readFile(path.join(dir,'external.txt'),'utf8'),'mcp-ok');
  await client.close();client = undefined;
  await assert.rejects(access(path.join(process.env.CODE_MODE_DATA_DIR,'broker.json')),{code:'ENOENT'});
  await assert.rejects(access(path.join(process.env.CODE_MODE_DATA_DIR,'approvals.jsonl')),{code:'ENOENT'});
  await writeFile(process.env.CODE_MODE_POLICY_PATH,'{}');

  // Each provider goes through the real agent loop, executor, file effect,
  // result round-trip, and saved session. No paid API keys are needed.
  for (const provider of ['openai','anthropic','gemini']) {
    let requests = 0;
    const request = async (url,init) => {
      requests++;
      const body = JSON.parse(init.body);
      const history = provider === 'gemini' ? body.contents : body.messages;
      const last = history.at(-1);
      const done = JSON.stringify(last).includes('tool_result');
      if (requests === 1) {
        assert.equal(body.tools,undefined);
        assert.ok(JSON.stringify(body).includes('code_mode'));
        assert.match(url,provider === 'openai' ? /\/chat\/completions$/ : provider === 'anthropic' ? /\/messages$/ : /\/models\/any-model:generateContent$/);
        assert.equal(init.headers[provider === 'openai' ? 'authorization' : provider === 'anthropic' ? 'x-api-key' : 'x-goog-api-key'],provider === 'openai' ? 'Bearer test-key' : 'test-key');
      }
      const content = done ? JSON.stringify({code_mode:'final',text:'verified'}) : JSON.stringify({code_mode:'call',name:'REPL',arguments:{code:`await write('${provider}.txt','portable'); return await read('${provider}.txt')`}});
      return Response.json(provider === 'openai' ? {choices:[{message:{content}}]} : provider === 'anthropic' ? {content:[{type:'text',text:content}]} : {candidates:[{content:{parts:[{text:content}]},finishReason:'STOP'}]});
    };
    const agent = new CodeModeAgent({endpoint:'https://provider.invalid/v1',model:'any-model',provider,toolProtocol:provider === 'openai' ? 'text' : 'auto',apiKey:'test-key',cwd:dir,request});
    agents.push(agent);
    assert.equal(await agent.turn('Create and verify a file'),'verified');
    assert.equal(requests,2);
    assert.equal(await readFile(path.join(dir,`${provider}.txt`),'utf8'),'portable');
    const resumed = await CodeModeAgent.resume(agent.id,{endpoint:agent.endpoint,model:agent.model,request});
    agents.push(resumed);
    assert.equal(resumed.provider,provider);
    assert.equal(resumed.resolvedProtocol,'text');
    assert.equal(await resumed.turn('Continue'),'verified');
  }
  let attempts = 0;
  const fallback = new CodeModeAgent({endpoint:'https://provider.invalid/v1',model:'tool-less-model',cwd:dir,request:async (_url,init) => {
    attempts++;
    const body = JSON.parse(init.body);
    if (body.tools) return new Response('tools are not supported by this model',{status:400});
    if (JSON.stringify(body.messages.at(-1)).includes('tool_result')) return Response.json({choices:[{message:{content:'{"code_mode":"final","text":"fallback-ok"}'}}]});
    return Response.json({choices:[{message:{content:JSON.stringify({code_mode:'call',name:'REPL',arguments:{code:'await write("fallback.txt","executed-once"); return 1'}})}}]});
  }});
  agents.push(fallback);
  assert.equal(await fallback.turn('Use the text protocol'),'fallback-ok');
  assert.equal(attempts,3);
  assert.equal(fallback.jobs.length,1);
  assert.equal(await readFile(path.join(dir,'fallback.txt'),'utf8'),'executed-once');
  let failures = 0;
  const unauthorized = new CodeModeAgent({endpoint:'https://provider.invalid/v1',model:'x',cwd:dir,request:async()=>{failures++;return new Response('unauthorized',{status:401});}});
  agents.push(unauthorized);
  await assert.rejects(unauthorized.turn('Do not retry authentication errors'),/Model HTTP 401/);
  assert.equal(failures,1);
  assert.equal(unauthorized.jobs.length,0);
  assert.deepEqual(parseTextMessage('Example: ```js\nwrite("x","x")\n```'),{content:'Example: ```js\nwrite("x","x")\n```'});
  assert.throws(()=>parseTextMessage('{"code_mode":"call",broken'),/Invalid Code Mode JSON/);
  assert.throws(()=>parseTextMessage('{"code_mode":"call","name":"REPL","arguments":[]}'),/Invalid Code Mode call/);
  for (const provider of ['openai','anthropic','gemini']) {
    const result = provider === 'openai' ? {choices:[{finish_reason:'length',message:{content:'{}'}}]} : provider === 'anthropic' ? {stop_reason:'max_tokens',content:[]} : {candidates:[{finishReason:'MAX_TOKENS'}]};
    await assert.rejects(modelMessage({endpoint:'https://provider.invalid/v1',model:'x',provider,protocol:'text',messages:[],instructions:'',tools:agentTools,request:async()=>Response.json(result)}),/truncated|incomplete/);
  }
  const env = {};
  const options = await terminalOptions(['--endpoint','https://provider.invalid/v1','--model','x','--provider','gemini','--tool-protocol','text'],env);
  assert.equal(env.CODE_MODE_PERMISSION_MODE,'autoApprove');
  assert.equal(options.provider,'gemini');
  assert.equal(options.toolProtocol,'text');
  console.log('PASS: no classifier/broker in default execution, concurrent unattended writes, MCP/shell/edit effects, three provider agent round-trips, text fallback and resume');
} finally {
  await client?.close();
  await Promise.all(agents.map(agent=>agent.close()));
  await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
