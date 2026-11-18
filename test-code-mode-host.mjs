import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHostBridge } from './code-mode-host.mjs';

const dir = await mkdtemp(path.join(process.cwd(), 'code-mode-test-host-'));
const previous = { config: process.env.CODE_MODE_MCP_CONFIG_PATH, servers: process.env.CODE_MODE_MCP_SERVERS };
delete process.env.CODE_MODE_MCP_CONFIG_PATH;
process.env.CODE_MODE_MCP_SERVERS = JSON.stringify({ fixture: { command: process.execPath, args: [path.join(process.cwd(), 'test-mcp-fixture.mjs')] } });
const bridge = (policy = {}, options = {}) => createHostBridge({ policy, cwd: dir, code: 'the-actual-submitted-code', mode: 'rules', signal: new AbortController().signal, ...options });
try {
  const target = path.join(dir, 'marker.txt');
  const params = { server: 'fixture', tool: 'write_marker', args: { file: target, text: 'approved' }, mode: 'bypassPermissions', policy: {}, approved: true };
  await assert.rejects(bridge({ deny:['mcp__fixture__write_marker'] }).request('callMcp', params), /policy denied/);
  await assert.rejects(access(target), { code:'ENOENT' });
  await assert.rejects(bridge({}, {mode:'plan'}).request('callMcp', params), /plan mode denied/);
  await assert.rejects(access(target), { code:'ENOENT' });
  await assert.rejects(bridge().request('run', {command:'anything'}), /Unknown host request/);
  await assert.rejects(bridge().request('callMcp', {...params, args:[]}), /Invalid MCP tool arguments/);

  const approvals = [];
  await bridge({}, {mode:'default', decide:async (kind,event)=>{ approvals.push([kind,event.tool_name]); }}).request('callMcp', params);
  assert.deepEqual(approvals, [['approve','mcp__fixture__write_marker']]);
  assert.equal(await readFile(target, 'utf8'), 'approved');

  const classified = [];
  const auto = bridge({}, {mode:'auto', decide:async (kind,event)=>{ if(kind==='classify') classified.push(event.tool_input.code); }});
  await auto.request('checkTool', {tool:'REPL',input:{code:'fake-safe-code'}});
  await auto.request('listMcpServers', {});
  assert.deepEqual(classified, ['the-actual-submitted-code']);

  // A worker that skips REPL still cannot invoke host capabilities before
  // classification; the parent supplies the actual code to the classifier.
  await assert.rejects(bridge({}, {mode:'auto', decide:async()=>{throw new Error('classifier denied');}}).request('callMcp', {...params,args:{file:target,text:'must-not-land'}}), /classifier denied/);
  assert.equal(await readFile(target,'utf8'), 'approved');

  // The Docker worker reports guest /work paths; host-side file rules must
  // evaluate them against the mounted project (the host cwd).
  await assert.rejects(
    bridge({ deny: ['Write(src/**)'] }).request('checkTool', { tool: 'Write', input: { file_path: '/work/src/a.txt', content: 'x' } }),
    /policy denied/);
  const guestApprovals = [];
  const guestBridge = bridge({ allow: ['Edit(src/**)'] }, { mode: 'default', decide: async (kind, event) => { guestApprovals.push([kind, event.tool_input.file_path]); } });
  await guestBridge.request('checkTool', { tool: 'Write', input: { file_path: '/work/src/b.txt', content: 'x' } });
  await guestBridge.request('checkTool', { tool: 'Write', input: { file_path: '/work/outside.txt', content: 'x' } });
  assert.deepEqual(guestApprovals, [['approve', path.join(dir, 'outside.txt')]]);

  // Cancellation also stops trusted host hooks, even with onFailure:continue.
  const hook = path.join(dir,'late-hook.mjs'), late = path.join(dir,'late.txt');
  await writeFile(hook, `import {writeFile} from 'node:fs/promises'; for await (const part of process.stdin) {} await new Promise(r=>setTimeout(r,700)); await writeFile(${JSON.stringify(late)},'late');`);
  const controller = new AbortController();
  const cancelling = bridge({preToolUse:[{tool:'Bash',command:process.execPath,args:[hook],onFailure:'continue'}]}, {signal:controller.signal});
  const pending = cancelling.request('checkTool',{tool:'Bash',input:{command:'test'}});
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(pending, {name:'AbortError'});
  await new Promise(resolve=>setTimeout(resolve,800));
  await assert.rejects(access(late),{code:'ENOENT'});
  console.log('PASS: trusted host bridge rejects forged permissions, classifies actual code, gates MCP and cancels hooks');
} finally {
  if (previous.config === undefined) delete process.env.CODE_MODE_MCP_CONFIG_PATH; else process.env.CODE_MODE_MCP_CONFIG_PATH = previous.config;
  if (previous.servers === undefined) delete process.env.CODE_MODE_MCP_SERVERS; else process.env.CODE_MODE_MCP_SERVERS = previous.servers;
  await rm(dir,{recursive:true,force:true});
}
