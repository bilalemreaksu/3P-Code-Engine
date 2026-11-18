// OS isolation (CODE_MODE_ISOLATION=docker) integration test. The untrusted
// worker runs in a disposable container; this proves the boundary from the
// outside: project files land on the host, the host loopback (approval
// broker) is unreachable from the worker, files outside the project are
// invisible, the guest shell is Linux, approvals still resolve through the
// host-side broker with a fromUi audit record, and cancelling a job removes
// its container.
//
// Without a docker engine this suite prints SKIP and exits — an unavailable
// engine is not a pass, and the line says so.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readAudit } from './approval-broker.mjs';

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
const engine = await docker(['version', '--format', '{{.Server.Version}}'], 8000);
if (engine.code !== 0) {
  console.log('SKIP: no docker engine on this machine; OS isolation test not run (not a pass)');
  process.exit(0);
}
// Build the image (always: a stale image would test old worker code). An
// engine that answers `version` but cannot build (for example a CI backend
// without pull access) cannot prove the boundary either, so report SKIP with
// the error instead of passing or failing on infrastructure.
const built = await docker(['build', '-q', '-t', '3p-code-engine-worker', '-f', path.join(process.cwd(), 'worker-image', 'Dockerfile'), process.cwd()], 420000);
if (built.code !== 0) {
  console.log(`SKIP: docker engine present but the worker image could not be built: ${tail(built)} — OS isolation test not run (not a pass)`);
  process.exit(0);
}
const dockerPs = () => docker(['ps', '-aq', '--filter', 'name=3p-worker-'], 15000).then(r => (r.code === 0 ? r.stdout : ''));
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
await writeFile(mcpConfig, JSON.stringify({ mcpServers: {} }));
await writeFile(policyPath, '{}');
await writeFile(path.join(project, 'approval-hook.mjs'), `let input = '';
for await (const part of process.stdin) input += part;
const event = JSON.parse(input || '{}');
if (event.hook_event_name === 'PreToolUse' && event.tool_name === 'Write' && String(event.tool_input?.file_path ?? '').endsWith('approval-target.txt')) {
  console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'ISOLATION_ASK_PASS' } }));
} else {
  console.log('{}');
}`);

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
      return JSON.stringify({ uname: uname.stdout.trim(), platform: process.platform, secretAttempt });`);
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
    await writeFile(policyPath, JSON.stringify({ preToolUse: [{ tool: 'Write', command: '/usr/local/bin/node', args: ['/work/approval-hook.mjs'] }] }));
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
    const before = (await dockerPs()).trim();
    const id = await start('await new Promise(resolve => setTimeout(resolve, 3600000));');
    await sleep(2500); // let the container boot
    const cancelResponse = await client.callTool({ name: 'code_cancel', arguments: { jobId: id } });
    assert.notEqual(cancelResponse.isError, true, cancelResponse.content[0].text);
    assert.equal(JSON.parse(cancelResponse.content[0].text).status, 'cancelled');
    await waitFor(async () => (await dockerPs()).trim() === before, 'container cleanup after cancel', 15000);
  }
  await stopBroker();
  console.log(`PASS: docker isolation (engine ${engine.stdout.trim()}) — project boundary, host loopback unreachable, Linux guest, broker approval with fromUi audit, container cleanup`);
} finally {
  await stopBroker();
  await client.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
