import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const dir = await mkdtemp(path.join(process.cwd(), 'code-mode-manager-test-'));
const dataDir = path.join(dir, 'state');
process.env.CODE_MODE_DATA_DIR = dataDir;
process.env.CODE_MODE_POLICY_PATH = path.join(dir, 'policy.json');
process.env.CODE_MODE_ISOLATION = 'off';
process.env.CODE_MODE_APPROVAL_TIMEOUT_MS = '1500';
delete process.env.CODE_MODE_PERMISSION_MODE; // env must not pin an explicit mode
await writeFile(process.env.CODE_MODE_POLICY_PATH, '{}');
const { startExecution, getJob, resetApprovalTimeouts, resumeSession } = await import('./execution-manager.mjs');
// Pre-warm the approval broker: a cold broker.json costs a take-over wait,
// which would otherwise outlive the short test countdown.
await mkdir(dataDir, { recursive: true });
await import('./approval-client.mjs').then(m => m.ensureBroker(dataDir));
// Code Mode must be enabled for this fixture project in the trusted settings.
await import('./code-mode-settings.mjs').then(m => m.setProjectEnabled(dataDir, dir));

// The "human" is simulated through the local approval broker's own HTTP API.
const brokerInfo = async () => {
  for (;;) {
    try {
      const info = JSON.parse(await readFile(path.join(dataDir, 'broker.json'), 'utf8'));
      const health = await (await fetch(`http://127.0.0.1:${info.port}/health?token=1`)).json();
      if (health.ok) return { port: info.port, token: health.token };
    } catch { /* broker starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
};
const withToken = async p => { const b = await brokerInfo(); return `http://127.0.0.1:${b.port}${p}${p.includes('?') ? '&' : '?'}t=${b.token}`; };
const pendingList = async () => (await fetch(await withToken('/pending'))).json();
const decideApproval = async nonce => {
  const b = await brokerInfo();
  const response = await fetch(`http://127.0.0.1:${b.port}/decisions?t=${b.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${b.port}` },
    body: JSON.stringify({ nonce, decision: 'approve', channel: 'ui' }) });
  return response.status;
};
const waitForPending = async (filter, what) => {
  for (let i = 0; i < 200; i++) {
    const item = (await pendingList()).find(filter);
    if (item) return item;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const stopBroker = async () => {
  try {
    const info = JSON.parse(await readFile(path.join(dataDir, 'broker.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${info.port}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: info.pid }) });
    await response.json().catch(() => null);
  } catch { /* broker never started */ }
};
const until = async (probe, what, deadlineMs = 15000) => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Timed out waiting for ${what}`);
};
try {
  // Explicit mode and event source are validated; the MCP surface default
  // source is 'mcp' because Desktop cannot report real user events.
  await assert.rejects(async () => startExecution({ cwd: dir, code: 'return 1', mode: 'yolo' }), /Invalid permission mode/);
  await assert.rejects(async () => startExecution({ cwd: dir, code: 'return 1', source: 'bogus' }), /Invalid execution source/);
  // A new session must carry its own absolute cwd; the error message points
  // the caller at both escapes: pass cwd, or continue an existing sessionId.
  await assert.rejects(async () => startExecution({ code: 'return 1' }),
    /cwd must be an absolute path: pass cwd for a new session, or pass a sessionId to continue an existing session/);
  const sourced = await startExecution({ cwd: dir, code: 'return 7', mode: 'rules', source: 'mcp' });
  assert.equal((await sourced.promise).result, '7');
  assert.equal(getJob(sourced.id).source, 'mcp');

  // The execution timeout caps are enforced by the manager itself, not the
  // caller: 10 minutes foreground, 2 hours background. A value one millisecond
  // past the cap must be rejected; the cap itself stays executable.
  await assert.rejects(async () => startExecution({ cwd: dir, code: 'return 1', timeoutMs: 600001 }), /Invalid execution timeout/);
  await assert.rejects(async () => startExecution({ cwd: dir, code: 'return 1', background: true, timeoutMs: 7200001 }), /Invalid execution timeout/);
  const capForeground = await startExecution({ cwd: dir, code: 'return 1', timeoutMs: 600000, mode: 'rules' });
  assert.equal((await capForeground.promise).result, '1');
  const capBackground = await startExecution({ cwd: dir, code: 'return 1', background: true, timeoutMs: 7200000, mode: 'rules' });
  assert.equal((await capBackground.promise).result, '1');

  // A timed-out approval stays timed out: a new execution — even a synthetic
  // poll_event one — must not re-arm it. Only a real user message does.
  const retry = await startExecution({ cwd: dir, mode: 'default', decide: () => { throw new Error('no classifier'); }, code: `const errors = [];
    for (let i = 0; i < 80; i++) {
      try { await write('timed-out.txt', 'done'); break; }
      catch (error) { errors.push(error.message.slice(0, 40)); await new Promise(r => setTimeout(r, 200)); }
    }
    errors.join('|')` });
  const first = await waitForPending(item => item.file?.endsWith('timed-out.txt'), 'timed-out approval');
  assert.ok(first.nonce, 'broker nonce');
  await new Promise(r => setTimeout(r, 2500)); // 1500 ms countdown plus margin
  assert.equal(getJob(retry.id).approvalTimedOut, true);
  const poll = await startExecution({ cwd: dir, code: 'return 42', mode: 'rules', background: true, source: 'poll_event' });
  assert.equal((await poll.promise).result, '42');
  assert.equal(getJob(poll.id).source, 'poll_event');
  assert.equal(getJob(retry.id).approvalTimedOut, true, 'a poll_event execution must not re-arm timed-out approvals');
  await new Promise(r => setTimeout(r, 1000)); // several retry cycles
  assert.equal((await pendingList()).filter(item => item.file?.endsWith('timed-out.txt')).length, 0,
    'no stray approval may appear before a real user message');
  resetApprovalTimeouts([retry.id]); // the real user message
  const requeued = await waitForPending(item => item.file?.endsWith('timed-out.txt') && item.nonce !== first.nonce, 're-armed approval');
  assert.equal(await decideApproval(requeued.nonce), 200);
  const done = await retry.promise;
  assert.equal(done.ok, true, done.error);
  assert.match(done.result, /countdown expired/);
  assert.equal(await readFile(path.join(dir, 'timed-out.txt'), 'utf8'), 'done');

  // Concurrent auto jobs: a later classification invalidates the earlier
  // review, so the earlier job's helper call now requires an approval.
  let classifications = 0;
  const autoDecide = async kind => { if (kind === 'classify') classifications++; };
  const auto1 = await startExecution({ cwd: dir, code: `while (true) {
      try { if ((await read('go.txt')).includes('1')) break; } catch (error) {}
      await new Promise(r => setTimeout(r, 50)); }
    await write('auto1.txt', 'one'); 'one-done'`, mode: 'auto', background: true, decide: autoDecide });
  await until(() => classifications >= 1, 'first classification');
  const auto2 = await startExecution({ cwd: dir, code: `await write('auto2.txt', 'two'); 'two-done'`, mode: 'auto', background: true, decide: autoDecide });
  await until(() => classifications >= 2, 'second classification');
  await writeFile(path.join(dir, 'go.txt'), '1');
  const invalidated = await waitForPending(item => item.file?.endsWith('auto1.txt'), 'invalidated auto review approval');
  assert.equal(await decideApproval(invalidated.nonce), 200);
  const r1 = await auto1.promise;
  assert.equal(r1.ok, true, r1.error);
  assert.equal(await readFile(path.join(dir, 'auto1.txt'), 'utf8'), 'one');
  const r2 = await auto2.promise;
  assert.equal(r2.ok, true, r2.error); // its own review was still valid: silent
  assert.equal(classifications, 2);
  assert.equal((await pendingList()).filter(item => item.file?.endsWith('auto2.txt')).length, 0);

  // A session saved under one mode keeps working both when the trusted caller
  // passes a new mode explicitly and when the effective (env) mode differs —
  // the mode is metadata, not a gate.
  const saved = await startExecution({ cwd: dir, code: 'state.x = 1; return 1', sessionId: 'manager-test', mode: 'rules', decide: () => {} });
  await saved.promise;
  const switched = await startExecution({ cwd: dir, code: 'return state.x', sessionId: 'manager-test', mode: 'auto', decide: autoDecide });
  const switchedResult = await switched.promise;
  assert.equal(switchedResult.ok, true, switchedResult.error);
  assert.equal(switchedResult.result, '1');
  // The same-permission-mode requirement on resume is relaxed: even an env
  // fallback that differs from the saved mode continues the session, and the
  // session re-records the effective mode.
  process.env.CODE_MODE_PERMISSION_MODE = 'plan';
  const relaxed = await startExecution({ cwd: dir, code: 'return state.x', sessionId: 'manager-test' });
  const relaxedResult = await relaxed.promise;
  assert.equal(relaxedResult.ok, true, relaxedResult.error);
  assert.equal(relaxedResult.result, '1');
  assert.equal(resumeSession('manager-test').mode, 'plan', 'session re-records the effective mode');
  process.env.CODE_MODE_PERMISSION_MODE = 'rules';
  delete process.env.CODE_MODE_PERMISSION_MODE;
  // A transient lock on the manager's own session record must not lose the
  // save: the atomic rename retries instead of throwing (observed EPERM).
  {
    const { chmodSync } = await import('node:fs');
    const { spawn } = await import('node:child_process');
    const record = path.join(dataDir, (await readdir(dataDir)).find(name => name.startsWith('session-')));
    assert.ok(record, 'session record exists');
    // The manager's retry sleeps synchronously and blocks this event loop,
    // so the lock is released from a separate process — the same shape as a
    // real OS-level lock (antivirus, another process).
    const releaser = spawn(process.execPath, ['-e', 'setTimeout(()=>{require("node:fs").chmodSync(process.argv[1],0o600)},800)', record], { stdio: 'ignore' });
    releaser.unref();
    chmodSync(record, 0o444);
    try {
      const locked = await startExecution({ cwd: dir, code: 'return state.x', sessionId: 'manager-test', mode: 'auto', decide: autoDecide });
      const done = await locked.promise;
      assert.equal(done.ok, true, done.error ?? 'a transient lock must not lose the session save');
      assert.equal(done.result, '1');
    } finally { releaser.kill(); try { chmodSync(record, 0o600); } catch {} }
  }
  console.log('PASS: execution manager separates event sources, re-arms timed-out approvals only on real user messages, invalidates auto reviews and tracks session modes');
} finally {
  await stopBroker();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
