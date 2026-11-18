// OS isolation (CODE_MODE_ISOLATION=docker) integration test. The untrusted
// worker runs in a disposable container; this proves the boundary from the
// outside: project files land on the host, the host loopback (approval
// broker) is unreachable from the worker, files outside the project are
// invisible, the guest shell is Linux, approvals still resolve through the
// host-side broker with a fromUi audit record, and cancelling a job removes
// its container.
//
// Section 0 (fail-closed without a working engine, using a fake docker CLI)
// runs on every machine. Without a real docker engine the remaining sections
// print SKIP and exit — an unavailable engine is not a pass, and the line
// says so.
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readAudit } from './approval-broker.mjs';
import { workerImageTag } from './worker-image.mjs';

const requireDocker = process.argv.includes('--require-docker') || process.env.CODE_MODE_REQUIRE_DOCKER === '1';

const docker = (args, timeoutMs = 60000) => new Promise(resolve => {
  const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  const timer = setTimeout(() => { child.kill(); resolve({ code: -1, stdout: out, stderr: err + '\n(timed out)' }); }, timeoutMs);
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: err + '\n' + e.message }); });
  child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
});
const tail = r => (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-3).join(' | ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, what, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const value = await fn(); if (value) return value; } catch { /* not ready yet */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
};

const dir = await mkdtemp(path.join(process.cwd(), 'code-mode-isolation-test-'));
const project = path.join(dir, 'project');
const dataDir = path.join(dir, 'saved-state');
await mkdir(project);
await writeFile(path.join(dir, 'secret.txt'), 'host-secret\n'); // sibling of the mounted project
const policyPath = path.join(dir, 'policy.json');
const mcpConfig = path.join(dir, 'mcp.json');
await writeFile(mcpConfig, JSON.stringify({ mcpServers: {
  fixture: { command: process.execPath, args: [path.join(process.cwd(), 'test-mcp-fixture.mjs')], env: { CONFIG_SENTINEL: 'host-only-config-canary' } },
  disabled: { command: process.execPath, disabled: true },
  '3p-code-mode': { command: process.execPath },
} }));
await writeFile(policyPath, '{}');
const { setProjectEnabled } = await import('./code-mode-settings.mjs');
await setProjectEnabled(path.join(dir, 'fake-data'), project);
await setProjectEnabled(dataDir, project);
await writeFile(path.join(project, 'approval-hook.mjs'), `let input = '';
for await (const part of process.stdin) input += part;
const event = JSON.parse(input || '{}');
if (event.hook_event_name === 'PreToolUse' && event.tool_name === 'Write' && String(event.tool_input?.file_path ?? '').endsWith('approval-target.txt')) {
  console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'ISOLATION_ASK_PASS' } }));
} else {
  console.log('{}');
}`);

// 0. Fail closed when the engine is down. The engine resolves its CLI through
//    CODE_MODE_DOCKER_BIN, so a fake engine (a node script behind a `docker`
//    batch file) stands in for a stopped daemon — no PATH or extension-
//    resolution tricks needed. Runs on every machine, including CI. With the
//    engine "down": the job must not
//    execute (no file side effects), the error must be the engine's, and the
//    snapshot must not claim isolation. Once the engine recovers, the next
//    job must re-probe instead of replaying a stale cached rejection.
{
  const fakeData = path.join(dir, 'fake-data');
  const fakeBin = path.join(dir, 'fakebin');
  const stateFile = path.join(dir, 'fake-docker-state.json');
  const fakeEngine = path.join(dir, 'fake-docker-engine.mjs');
  const bin = path.join(fakeBin, process.platform === 'win32' ? 'docker.cmd' : 'docker');
  await mkdir(fakeBin);
  await writeFile(stateFile, JSON.stringify({ down: true, runs: 0 }));
  // writeSync before exit: process.exit() does not flush piped stdout.
  await writeFile(fakeEngine, `import fs from 'node:fs';
const stateFile = process.env.FAKE_DOCKER_STATE;
let state = { down: false, runs: 0 };
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first call */ }
const finish = (code, stdout, stderr) => {
  if (stdout) fs.writeSync(1, stdout);
  if (stderr) fs.writeSync(2, stderr);
  process.exit(code);
};
const refuse = () => finish(1, '', 'Cannot connect to the Docker daemon. Is the docker daemon running?\\n');
const args = process.argv.slice(2);
if (args[0] === 'version') { if (state.down) refuse(); finish(0, '29.9.3\\n', ''); }
if (args[0] === 'image') { if (state.down) refuse(); finish(0, '[]\\n', ''); }
if (args[0] === 'build') { if (state.down) refuse(); finish(0, 'sha256:fake\\n', ''); }
if (args[0] === 'run') {
  state.runs += 1;
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch { /* best effort */ }
  finish(0, '', ''); // fake engine: the "container" exits without a worker
}
finish(0, '', '');
`);
  // The shim invokes node by absolute path; %* / "$@" pass the CLI through.
  const shimBody = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fakeEngine}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fakeEngine}" "$@"\n`;
  await writeFile(bin, shimBody);
  if (process.platform !== 'win32') await chmod(bin, 0o755);
  const fakeClient = new Client({ name: 'code-mode-isolation-fake', version: '1.0.0' });
  await fakeClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['server-code-mode.mjs'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODE_MODE_DATA_DIR: fakeData,
      CODE_MODE_POLICY_PATH: policyPath,
      CODE_MODE_MCP_CONFIG_PATH: mcpConfig,
      CODE_MODE_PERMISSION_MODE: 'rules',
      CODE_MODE_ISOLATION: 'docker',
      CODE_MODE_DOCKER_BIN: bin,
      FAKE_DOCKER_STATE: stateFile,
    },
  }));
  const downResponse = await fakeClient.callTool({ name: 'code_execute', arguments: { cwd: project, code: "await write('marker.txt', 'x');\nreturn 'reached';" } });
  assert.equal(downResponse.isError, true);
  assert.match(downResponse.content[0].text, /Docker daemon/i);
  await assert.rejects(access(path.join(project, 'marker.txt')), { code: 'ENOENT' });
  const snapshot = JSON.parse(await waitFor(() => readFile(path.join(fakeData, 'isolation.json'), 'utf8'), 'fake isolation.json'));
  assert.equal(snapshot.isolationMode, 'docker');
  assert.equal(snapshot.dockerAvailable, false);
  // Without the engine the docker term contributes nothing; only the host's
  // own environment (running in a container/WSL) may set workerIsolated.
  assert.equal(snapshot.workerIsolated, snapshot.container || snapshot.wsl);
  await writeFile(stateFile, JSON.stringify({ down: false, runs: 0 }));
  const upResponse = await fakeClient.callTool({ name: 'code_execute', arguments: { cwd: project, code: '1 + 1' } });
  // Engine recovered: the image step now passes and the (fake) run was
  // attempted — the failure moved from the engine to worker startup, which
  // proves the stale rejection was dropped.
  assert.equal(upResponse.isError, true);
  assert.match(upResponse.content[0].text, /exited without result/);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).runs, 1);
  await fakeClient.close();
  console.log('PASS: fail-closed without a working engine (no execution, honest snapshot, re-probe after recovery)');
}

const engine = await docker(['version', '--format', '{{.Server.Version}}'], 8000);
if (engine.code !== 0) {
  await rm(dir, { recursive: true, force: true });
  console.log(`${requireDocker ? 'FAIL' : 'SKIP'}: no docker engine on this machine; OS isolation test not run (not a pass)`);
  process.exit(requireDocker ? 1 : 0);
}
// Build the image (always: a stale image would test old worker code). An
// engine that answers `version` but cannot build (for example a CI backend
// without pull access) cannot prove the boundary either, so report SKIP with
// the error instead of passing or failing on infrastructure.
const image = await workerImageTag();
const built = await docker(['build', '-q', '-t', image, '-f', path.join(process.cwd(), 'worker-image', 'Dockerfile'), process.cwd()], 420000);
if (built.code !== 0) {
  await rm(dir, { recursive: true, force: true });
  console.log(`${requireDocker ? 'FAIL' : 'SKIP'}: docker engine present but the worker image could not be built: ${tail(built)} — OS isolation test not run (not a pass)`);
  process.exit(requireDocker ? 1 : 0);
}
const dockerPs = () => docker(['ps', '-aq', '--filter', 'name=3p-worker-'], 15000).then(r => (r.code === 0 ? r.stdout : ''));

const client = new Client({ name: 'code-mode-isolation-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ['server-code-mode.mjs'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODE_MODE_DATA_DIR: dataDir,
    CODE_MODE_POLICY_PATH: policyPath,
    CODE_MODE_MCP_CONFIG_PATH: mcpConfig,
    CODE_MODE_PERMISSION_MODE: 'rules',
    CODE_MODE_ISOLATION: 'docker',
  },
}));

const brokerInfo = async () => {
  for (;;) {
    try {
      const info = JSON.parse(await readFile(path.join(dataDir, 'broker.json'), 'utf8'));
      const health = await (await fetch(`http://127.0.0.1:${info.port}/health?token=1`)).json();
      if (health.ok) return { port: info.port, token: health.token };
    } catch { /* broker starting */ }
    await sleep(100);
  }
};
const pendingList = async () => {
  const b = await brokerInfo();
  return (await fetch(`http://127.0.0.1:${b.port}/pending?t=${b.token}`)).json();
};
const decideApproval = async (nonce, decision) => {
  const b = await brokerInfo();
  const response = await fetch(`http://127.0.0.1:${b.port}/decisions?t=${b.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${b.port}` },
    body: JSON.stringify({ nonce, decision, channel: 'ui' }),
  });
  return response.status;
};
const stopBroker = async () => {
  try {
    const info = JSON.parse(await readFile(path.join(dataDir, 'broker.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${info.port}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: info.pid }) });
    await response.json().catch(() => null);
  } catch { /* broker never started */ }
};
const call = async code => {
  const response = await client.callTool({ name: 'code_execute', arguments: { cwd: project, code } });
  return { response, result: JSON.parse(response.content[0].text) };
};
const start = async code => {
  const response = await client.callTool({ name: 'code_start', arguments: { cwd: project, code } });
  assert.notEqual(response.isError, true, response.content[0].text);
  return JSON.parse(response.content[0].text).id;
};
const poll = async id => JSON.parse((await client.callTool({ name: 'code_status', arguments: { jobId: id } })).content[0].text);
const finished = id => waitFor(() => poll(id).then(job => (job.status !== 'running' ? job : null)), `job ${id} to finish`);

try {
  // 1. The project is the only host surface: writes land on the host, the
  //    guest shell is Linux, and files outside the mount are invisible.
  {
    const job = await call(`await write('smoke.txt', 'hello\\n');
      const back = await read('smoke.txt');
      if (back !== 'hello\\n') throw new Error('readback mismatch: ' + JSON.stringify(back));
      await edit('smoke.txt', 'hello', 'world');
      const uname = await run('uname -s');
      let secretAttempt;
      try { secretAttempt = 'LEAK:' + (await read('../secret.txt')); }
      catch (error) { secretAttempt = 'blocked(' + (error.code || error.message) + ')'; }
      return JSON.stringify({ uname: uname.stdout.trim(), platform: (await run('node -p process.platform')).stdout.trim(), secretAttempt });`);
    assert.equal(job.result.ok, true, job.result.error);
    const facts = JSON.parse(job.result.result);
    assert.equal(facts.uname, 'Linux');
    assert.equal(facts.platform, 'linux');
    assert.match(facts.secretAttempt, /^blocked/);
    assert.equal(await readFile(path.join(project, 'smoke.txt'), 'utf8'), 'world\n');
  }
  // 2. The host loopback is unreachable from the container, so the approval
  //    broker API cannot be reached by the worker.
  {
    const leak = createServer((req, res) => res.end('host-leak'));
    await new Promise(r => leak.listen(0, '127.0.0.1', r));
    const port = leak.address().port;
    try {
      const job = await call(`try {
        const response = await fetch('http://127.0.0.1:${port}/leak');
        return 'LEAK:' + (await response.text());
      } catch (error) {
        return 'unreachable(' + (error.cause?.code ?? error.name) + ')';
      }`);
      assert.equal(job.result.ok, true, job.result.error);
      assert.match(job.result.result, /^unreachable/);
    } finally {
      leak.close();
    }
  }
  // 3. The startup snapshot records real, probed isolation (the docker
  //    engine answered, not just the flag).
  {
    const snapshot = JSON.parse(await waitFor(() => readFile(path.join(dataDir, 'isolation.json'), 'utf8'), 'isolation.json'));
    assert.equal(snapshot.isolationMode, 'docker');
    assert.equal(snapshot.dockerAvailable, true);
    assert.equal(snapshot.workerIsolated, true);
  }
  // 4. Approvals still flow through the host-side broker: a hook inside the
  //    mounted project asks, the human (this test) answers on the broker UI
  //    surface, and the audited decision carries fromUi/channel.
  {
    await writeFile(policyPath, JSON.stringify({ preToolUse: [{ tool: 'Write', command: process.execPath, args: [path.join(project, 'approval-hook.mjs')] }] }));
    const id = await start(`await write('approval-target.txt', 'isolated-approved\\n');
      return 'ISOLATION_APPROVAL_PASS';`);
    const pending = await waitFor(async () => (await pendingList()).find(item => item.tool === 'Write' && String(item.file ?? '').endsWith('approval-target.txt')), 'isolated approval request');
    assert.equal(await decideApproval(pending.nonce, 'approve'), 200);
    const job = await finished(id);
    assert.equal(job.status, 'completed', JSON.stringify(job.result ?? {}));
    assert.equal(job.result.result, 'ISOLATION_APPROVAL_PASS');
    assert.equal(await readFile(path.join(project, 'approval-target.txt'), 'utf8'), 'isolated-approved\n');
    const audit = await waitFor(async () => {
      const { valid, entries } = await readAudit(path.join(dataDir, 'approvals.jsonl'));
      if (!valid) throw new Error('audit chain invalid');
      return entries.find(entry => entry.jobId === id && entry.event === 'decision' && entry.decision === 'approve');
    }, 'audited approval decision');
    assert.equal(audit.fromUi, true);
    assert.equal(audit.channel, 'ui');
    assert.equal(audit.tool, 'Write');
  }
  // 5. Cancelling a job removes its container.
  {
    await writeFile(policyPath, '{}');
    const before = (await dockerPs()).trim();
    const id = await start('await new Promise(resolve => setTimeout(resolve, 3600000));');
    await sleep(2500); // let the container boot
    const cancelResponse = await client.callTool({ name: 'code_cancel', arguments: { jobId: id } });
    assert.notEqual(cancelResponse.isError, true, cancelResponse.content[0].text);
    assert.equal(JSON.parse(cancelResponse.content[0].text).status, 'cancelled');
    await waitFor(async () => (await dockerPs()).trim() === before, 'container cleanup after cancel', 15000);
  }
  // 6. MCP servers execute on the host, without exporting configuration or
  //    credentials into the container. Deny also applies to forged raw RPCs.
  {
    const found = await call(`const servers = await listMcpServers();
      const discoveredTools = await listMcpTools('fixture');
      const echoed = await callMcp('fixture', 'echo', {message:'docker-mcp-pass'});
      return JSON.stringify({servers, tools:discoveredTools.tools.map(t=>t.name), echo:echoed.content[0].text, sentinel:typeof process==='undefined' ? null : process.env.CONFIG_SENTINEL});`);
    assert.equal(found.result.ok, true, found.result.error);
    const facts = JSON.parse(found.result.result);
    assert.deepEqual(facts.servers, ['fixture']);
    assert.ok(facts.tools.includes('echo'));
    assert.equal(facts.echo, 'docker-mcp-pass');
    assert.equal(facts.sentinel, null);
    const marker = path.join(dir, 'host-marker.txt');
    const args = JSON.stringify({ file: marker, text: 'host-bridge-approved' });
    await writeFile(policyPath, JSON.stringify({ deny: ['mcp__fixture__write_marker'] }));
    const denied = await call(`const {requestHost} = await import('/app/code-mode-rpc.mjs');
      return await requestHost('callMcp', {server:'fixture',tool:'write_marker',args:${args}});`);
    assert.equal(denied.result.ok, false);
    assert.match(denied.result.error, /module|import|loader/i);
    const helperDenied=await call(`return await callMcp('fixture','write_marker',${args});`);
    assert.match(helperDenied.result.error,/policy denied mcp__fixture__write_marker/);
    await assert.rejects(access(marker), { code: 'ENOENT' });

    await writeFile(policyPath, JSON.stringify({ ask: ['mcp__fixture__write_marker'] }));
    const id = await start(`return (await callMcp('fixture','write_marker',${args})).content[0].text;`);
    const pending = await waitFor(async () => (await pendingList()).find(item => item.jobId === id), 'bridged MCP approval');
    await assert.rejects(access(marker), { code: 'ENOENT' });
    assert.equal(await decideApproval(pending.nonce, 'approve'), 200);
    assert.equal((await finished(id)).status, 'completed');
    assert.equal(await readFile(marker, 'utf8'), 'host-bridge-approved');

    // Trusted MCP hooks run on the host and are not recursively gated.
    await writeFile(policyPath, JSON.stringify({ preToolUse: [{tool:'mcp__fixture__echo', type:'mcp_tool', server:'fixture', mcpTool:'hook_check', arguments:{mode:'error'}}] }));
    const blocked = await call("return await callMcp('fixture','echo',{message:'blocked'});");
    assert.equal(blocked.result.ok, false);
    assert.match(blocked.result.error, /hook refused/);
  }
  // 7. Background output is held and checked on the host, including raw
  //    protocol output emitted by untrusted code outside the log helper.
  {
    await writeFile(policyPath, JSON.stringify({ userPromptSubmit: [{ type:'mcp_tool', server:'fixture', mcpTool:'hook_check' }] }));
    const id = await start(`log('withheld-secret');
      await new Promise(r=>setTimeout(r,500)); state.secret='withheld-secret'; return 'withheld-secret';`);
    let job;
    do {
      job = await poll(id);
      assert.equal(job.events.length, 0);
      if (job.status === 'running') await sleep(50);
    } while (job.status === 'running');
    assert.equal(job.result.outputBlocked, true);
    const { transcript, ...visibleResult } = job.result;
    assert.equal(JSON.stringify(visibleResult).includes('withheld-secret'), false);
    assert.equal('state' in job.result, false);
    assert.equal('logs' in job.result, false);
    assert.equal('operations' in job.result, false);
    await writeFile(policyPath, '{}');
  }
  await stopBroker();
  console.log(`PASS: docker isolation (engine ${engine.stdout.trim()}) — project boundary, host loopback unreachable, Linux guest, broker approval, MCP bridge deny/ask/hooks, host output filtering, container cleanup`);
} finally {
  await stopBroker();
  await client.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
