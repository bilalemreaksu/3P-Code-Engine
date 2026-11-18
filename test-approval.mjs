// Tests for the local approval broker and the transcript viewer exit paths.
// The broker tests run an in-process broker in a temp data dir; the "human"
// is simulated through the broker's own HTTP API (the same API the UI page
// uses), which is exactly the human's decision surface.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startBroker, readAudit } from './approval-broker.mjs';
import { interactiveViewer, viewerKey } from './code-mode-transcript.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), '3p-approval-test-'));
const dataDir = path.join(dir, 'data');
await mkdir(dataDir, { recursive: true });
const base = { dataDir, idleMs: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = ms => new Date(Date.now() + ms).toISOString();

let handle = await startBroker(base);
assert.equal(handle.reused, false);
assert.ok(handle.port > 0);
const fetcher = () => {
  const get = p => fetch(`${handle.baseUrl}${p}`).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const post = async (p, body) => {
    const r = await fetch(`${handle.baseUrl}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const raw = p => fetch(`${handle.baseUrl}${p}`).then(async r => ({ status: r.status, text: await r.text() }));
  return { get, post, raw };
};
let api = fetcher();

// --- token gating -----------------------------------------------------------
assert.equal((await api.get('/pending')).status, 403);
assert.equal((await api.post('/requests', { jobId: 'x', tool: 'Write', deadline: deadline(60000) })).status, 403);
const tokenized = () => {
  const withToken = p => `${handle.baseUrl}${p}${p.includes('?') ? '&' : '?'}t=${handle.token}`;
  const get = p => fetch(withToken(p)).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const post = async (p, body) => {
    const res = await fetch(withToken(p), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: handle.baseUrl }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const raw = p => fetch(withToken(p)).then(async r => ({ status: r.status, text: await r.text() }));
  return { get, post, raw };
};
api = tokenized();

// --- single instance reuse --------------------------------------------------
{
  const second = await startBroker(base);
  assert.equal(second.reused, true);
  assert.equal(second.port, handle.port);
}

// --- approve flow + audit -----------------------------------------------------
{
  const created = await api.post('/requests', { jobId: 'job-a', tool: 'Write', file: 'C:\\proj\\a.txt', preview: 'const x = 1;', command: undefined, deadline: deadline(30000) });
  assert.equal(created.status, 201);
  assert.match(created.body.nonce, /^[0-9a-f]{64}$/);
  const pending = (await api.get('/pending')).body;
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].jobId, 'job-a');
  // The UI page is a static shell: untrusted previews are never interpolated
  // server-side into the HTML. They travel as JSON and the page renders them
  // with textContent, so no client-side escaping is possible to get wrong.
  const pageText = (await api.raw('/')).text;
  assert.ok(pageText.includes('İnsan Onayı'));
  assert.ok(pageText.includes('.textContent'));
  const evilPreview = '<script>alert(1)</script>';
  const evil = await api.post('/requests', { jobId: 'job-b', tool: 'Bash', command: 'echo hi', preview: evilPreview, deadline: deadline(30000) });
  const pendingAfter = (await api.get('/pending')).body;
  assert.equal(pendingAfter.find(item => item.jobId === 'job-b')?.preview, evilPreview, 'JSON transport preserves the preview');
  const pageAfter = (await api.raw('/')).text;
  assert.ok(!pageAfter.includes(evilPreview), 'untrusted preview must not appear in the served HTML');
  await api.post('/cancel', { nonce: evil.body.nonce, reason: 'cleanup' });
  // Long poll resolves when the human approves.
  const poll = api.get(`/decision?nonce=${created.body.nonce}`);
  await sleep(150);
  const decision = await api.post('/decisions', { nonce: created.body.nonce, decision: 'approve', channel: 'ui' });
  assert.equal(decision.status, 200);
  const outcome = await poll;
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.decision, 'approve');
  assert.equal(outcome.body.channel, 'ui');
  // One-time nonce: a second decision is rejected and audited.
  assert.equal((await api.post('/decisions', { nonce: created.body.nonce, decision: 'deny', channel: 'ui' })).status, 409);
  // Late polls replay the stored outcome.
  assert.equal((await api.get(`/decision?nonce=${created.body.nonce}`)).body.decision, 'approve');
  // Unknown nonces never exist (no oracle beyond 404).
  assert.equal((await api.get('/decision?nonce=' + 'f'.repeat(64))).status, 404);
  assert.equal((await api.post('/decisions', { nonce: 'f'.repeat(64), decision: 'approve' })).status, 404);
  // A worker without the token cannot even read pending requests.
  assert.equal((await fetch(`${handle.baseUrl}/pending`)).status, 403);
}

// --- deny flow ----------------------------------------------------------------
{
  const created = await api.post('/requests', { jobId: 'job-c', tool: 'Edit', file: 'C:\\proj\\c.txt', preview: 'edit', deadline: deadline(30000) });
  const poll = api.get(`/decision?nonce=${created.body.nonce}`);
  const decision = await api.post('/decisions', { nonce: created.body.nonce, decision: 'deny', reason: 'not now', channel: 'ui' });
  assert.equal(decision.status, 200);
  const outcome = await poll;
  assert.equal(outcome.body.decision, 'deny');
  assert.equal(outcome.body.reason, 'not now');
}

// --- timeout flow -------------------------------------------------------------
{
  const created = await api.post('/requests', { jobId: 'job-d', tool: 'Bash', command: 'Get-Process', deadline: deadline(300) });
  const started = Date.now();
  const outcome = (await api.get(`/decision?nonce=${created.body.nonce}`)).body;
  assert.equal(outcome.decision, 'timeout');
  assert.ok(Date.now() - started >= 250);
  // After a timeout the nonce is consumed: a human clicking late gets 409.
  assert.equal((await api.post('/decisions', { nonce: created.body.nonce, decision: 'approve' })).status, 409);
}

// --- cancel flow (client disconnect) ------------------------------------------
{
  const created = await api.post('/requests', { jobId: 'job-e', tool: 'Write', file: 'C:\\proj\\e.txt', deadline: deadline(30000) });
  const poll = api.get(`/decision?nonce=${created.body.nonce}`);
  assert.equal((await api.post('/cancel', { nonce: created.body.nonce, reason: 'client disconnected', channel: 'api' })).status, 200);
  const outcome = await poll;
  assert.equal(outcome.body.decision, 'cancelled');
  assert.equal(outcome.body.reason, 'client disconnected');
  assert.equal((await api.post('/decisions', { nonce: created.body.nonce, decision: 'approve' })).status, 409);
}

// --- origin check: holding the token is not enough to grant a decision --------
{
  const created = await api.post('/requests', { jobId: 'job-h', tool: 'Bash', command: 'whoami', deadline: deadline(30000) });
  const raw = await fetch(`${handle.baseUrl}/decisions?t=${handle.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: created.body.nonce, decision: 'approve', channel: 'ui' }),
  });
  assert.equal(raw.status, 403, 'a background fetch holding the token cannot grant a decision');
  assert.equal((await api.get('/pending')).body.length, 1, 'the request must stay pending');
  assert.equal((await api.post('/cancel', { nonce: created.body.nonce, reason: 'origin-check test' })).status, 200);
}

// --- validation ----------------------------------------------------------------
{
  assert.equal((await api.post('/requests', { jobId: 'job-f', tool: 'Write', deadline: deadline(-1000) })).status, 400);
  assert.equal((await api.post('/requests', { jobId: '', tool: 'Write', deadline: deadline(1000) })).status, 400);
  assert.equal((await api.post('/requests', { jobId: 'job-f', tool: 'Write', deadline: deadline(25 * 60 * 60 * 1000) })).status, 400);
  assert.equal((await api.post('/decisions', { nonce: 'e'.repeat(64), decision: 'maybe' })).status, 404);
}

// --- audit chain ----------------------------------------------------------------
{
  const { valid, entries } = await readAudit(path.join(dataDir, 'approvals.jsonl'));
  assert.equal(valid, true);
  const events = entries.map(entry => entry.event);
  assert.ok(events.includes('request'));
  assert.ok(entries.some(entry => entry.event === 'decision' && entry.decision === 'approve' && entry.channel === 'ui' && entry.jobId === 'job-a'));
  assert.ok(entries.some(entry => entry.event === 'decision' && entry.decision === 'deny' && entry.jobId === 'job-c'));
  assert.ok(entries.some(entry => entry.event === 'timeout' && entry.jobId === 'job-d'));
  assert.ok(entries.some(entry => entry.event === 'cancelled' && entry.jobId === 'job-e'));
  assert.ok(entries.some(entry => entry.event === 'rejected-decision' && entry.reason === 'origin-mismatch'));
  assert.ok(entries.some(entry => entry.event === 'decision' && entry.fromUi === true && entry.jobId === 'job-a'));
  assert.ok(entries.some(entry => entry.event === 'duplicate-decision'));
  // Tampering any line breaks the chain.
  const raw = (await readFile(path.join(dataDir, 'approvals.jsonl'), 'utf8')).trim().split('\n');
  const tampered = [...raw];
  tampered[3] = tampered[3].replace(/"jobId":\s*"[^"]+"/, '"jobId": "forged"');
  const tamperFile = path.join(dataDir, 'tampered.jsonl');
  await writeFile(tamperFile, tampered.join('\n') + '\n');
  assert.equal((await readAudit(tamperFile)).valid, false);
  await rm(tamperFile, { force: true });
}

// --- recent decisions feed -------------------------------------------------------
{
  const recent = (await api.get('/recent')).body;
  assert.ok(recent.some(entry => entry.decision === 'approve' && entry.jobId === 'job-a'));
}

// --- restart: pending approvals are memory-only and audited as lost ------------
{
  const created = await api.post('/requests', { jobId: 'job-g', tool: 'Write', file: 'C:\\proj\\g.txt', deadline: deadline(60000) });
  assert.equal((await api.get('/pending')).body.length, 1);
  await handle.close('test');
  const lost = (await readAudit(path.join(dataDir, 'approvals.jsonl'))).entries;
  assert.ok(lost.some(entry => entry.event === 'lost' && entry.nonce === created.body.nonce));
  assert.equal((await readFile(path.join(dataDir, 'broker.json'), 'utf8').catch(() => null)), null, 'broker.json removed on clean shutdown');
  handle = await startBroker(base);
  api = tokenized();
  assert.notEqual(handle.port, 0);
  assert.equal((await api.get('/pending')).body.length, 0, 'pending approvals do not survive a broker restart');
  assert.equal((await api.get(`/decision?nonce=${created.body.nonce}`)).status, 404);
}

// --- health ---------------------------------------------------------------------
assert.equal((await api.get('/health')).body.ok, true);

// ---------------------------------------------------------------------------
// Transcript viewer: Q (upper or lower), Ctrl+C and Escape all exit cleanly;
// raw mode is restored and the input handle is released so the process exits.
// ---------------------------------------------------------------------------
function fakeTty() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.destroyed = false;
  input.setRawMode = value => { input.isRaw = value; };
  input.resume = () => {};
  input.pause = () => {};
  input.unref = () => {};
  input.destroy = () => { input.destroyed = true; };
  const output = { isTTY: true, frames: [], write(text) { this.frames.push(String(text)); return true; } };
  return { input, output };
}
const loadJobs = () => [{ id: 'job-1', status: 'completed', result: { transcript: 'const x = 1;\nreturn x;' } }];
for (const press of [{ name: 'Q' }, { name: 'q' }, { name: 'c', ctrl: true }, { name: 'escape' }]) {
  const { input, output } = fakeTty();
  const viewer = interactiveViewer(loadJobs, input, output);
  await sleep(50);
  assert.ok(output.frames.length > 0, 'viewer should draw before key press');
  input.emit('keypress', String(press.name), press);
  await viewer;
  assert.equal(input.isRaw, false, 'raw mode restored');
  assert.equal(input.destroyed, true, 'input handle released for clean process exit');
}
{
  const { input } = fakeTty();
  const state = { jobs: loadJobs(), selected: 0, expanded: new Set(), transcript: false };
  assert.equal(viewerKey(state, { name: 'R' }), true, 'capital R must refresh, not quit');
  assert.equal(viewerKey(state, { name: 'o', ctrl: true }), true);
  assert.equal(state.transcript, true);
  assert.equal(viewerKey(state, { name: 'up' }), true);
  assert.equal(viewerKey(state, { name: 'down' }), true);
  assert.equal(viewerKey(state, { name: 'return' }), true);
}

// Process level: the CLI must exit promptly even without a TTY.
{
  const root = path.dirname(fileURLToPath(import.meta.url));
  const run = (args, timeoutMs = 10000) => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'code-mode-transcript.mjs'), ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); resolve({ timedOut: true, stdout, stderr }); }, timeoutMs);
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('close', code => { clearTimeout(timer); resolve({ timedOut: false, code, stdout, stderr }); });
  });
  const noTty = await run(['job', 'nonexistent', '--interactive']);
  assert.equal(noTty.timedOut, false, '--interactive without TTY must exit, not hang');
  assert.match(noTty.stderr, /etkileşimli terminal gerekli/);
  const plain = await run(['job', 'nonexistent']);
  assert.equal(plain.timedOut, false);
  assert.equal(plain.code, 1);
}

await handle.close('test-end');
await rm(dir, { recursive: true, force: true });
console.log('PASS: approval broker (approve/deny/timeout/cancel/nonce/audit/restart) and transcript exit');
