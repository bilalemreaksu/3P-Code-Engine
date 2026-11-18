import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Terminal end-to-end flow with a real key-input TTY, a real model HTTP
// endpoint (mocked), a real classifier endpoint (mocked), the real approval
// broker and the real policy hook runner:
//   user input -> model -> REPL worker -> auto classification -> real file
//   effect -> rendered response.
// Approval denial is made through the broker's native HTTP interface
// (GET /pending, POST /decisions with the UI Origin header) — a model call
// can never grant it. Output blocking uses a real UserPromptSubmit policy
// hook on a background job: the blocked output must reach neither the
// terminal nor the model. Restart re-opens the saved session on a fresh TTY.

const root = await mkdtemp(path.join(os.tmpdir(), '3p-terminal-flow-'));
const project = path.join(root, 'project');
const dataDir = path.join(root, 'data');
await mkdir(project, { recursive: true });
await mkdir(dataDir, { recursive: true });

const servers = [];
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.url = `http://127.0.0.1:${server.address().port}`;
    servers.push(server);
    resolve();
  });
});

const classifierCalls = [];
const classifier = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const request = JSON.parse(body);
    // The classifier prompt travels as an OpenAI chat completion; the JSON
    // payload (cwd, code, optional trusted userIntent) is the user message.
    try { classifierCalls.push(JSON.parse(request.messages[1].content)); } catch { /* keep counting */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"decision":"allow"}' } }] }));
  });
});
await listen(classifier);

const modelCalls = [];
const replCall = (code, background, index) => ({
  id: `call-${index}`,
  type: 'function',
  function: { name: 'REPL', arguments: JSON.stringify({ code, background }) },
});
const model = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(body);
    modelCalls.push(payload);
    const last = payload.messages.at(-1);
    const content = typeof last?.content === 'string' ? last.content : '';
    const index = modelCalls.length;
    const message = { content: null };
    if (last?.role === 'user') {
      if (content.startsWith('Background code output (poll_event):')) {
        message.content = content.includes('outputBlocked') ? 'Background job output was blocked.' : 'Background job reported: ok';
      } else if (content.includes('TFA1')) message.tool_calls = [replCall('write(\'flow-ok.txt\', \'terminal-flow-verified\')', false, index)];
      else if (content.includes('TFB1')) message.tool_calls = [replCall("log('bg-running'); 'bg-ok'", true, index)];
      // The canary is composed at runtime: it must exist only in the
      // (blocked) output, never in the submitted code the transcript echoes.
      else if (content.includes('TFD1')) message.tool_calls = [replCall("log('canary' + '-secret-777'); 'bg-ok'", true, index)];
      else if (content.includes('TFC1')) message.tool_calls = [replCall('write(\'denied.txt\', \'nope\')', false, index)];
      else message.content = 'Restarted ok';
    } else if (last?.role === 'tool') {
      message.content = content.includes('denied') ? 'The write was denied by the user.' : 'Done.';
    } else {
      message.content = 'Done.';
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
});
await listen(model);

const hookCalls = [];
const hook = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(body);
    hookCalls.push(payload);
    const blocked = typeof payload.prompt === 'string' && payload.prompt.includes('canary-secret-777');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(blocked ? { decision: 'block', reason: 'output policy blocked this output' } : {}));
  });
});
await listen(hook);

// The data dir and classifier endpoint are read at module import time, so
// the environment is final before any project module loads.
process.env.CODE_MODE_DATA_DIR = dataDir;
process.env.CODE_MODE_CLASSIFIER_ENDPOINT = classifier.url;
process.env.CODE_MODE_CLASSIFIER_MODEL = 'mock-classifier';
process.env.CODE_MODE_CLASSIFIER_API_KEY = 'test-key';
delete process.env.CODE_MODE_PERMISSION_MODE;
delete process.env.CODE_MODE_ISOLATION;
delete process.env.CODE_MODE_POLICY_PATH;

const { setProjectEnabled } = await import('./code-mode-settings.mjs');
await setProjectEnabled(dataDir, project);
const { startBroker } = await import('./approval-broker.mjs');
const broker = await startBroker({ dataDir, idleMs: 0 });

const brokerJson = async p => (await fetch(`${broker.baseUrl}${p}?t=${broker.token}`).then(response => response.json()));
const waitForPending = async (filter, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const items = await brokerJson('/pending');
    const item = Array.isArray(items) ? items.find(filter) : undefined;
    if (item) return item;
    if (Date.now() > deadline) throw new Error('No pending approval appeared in the broker');
    await new Promise(resolve => { setTimeout(resolve, 100); });
  }
};
const uiDecision = async (nonce, decision, reason) => (await fetch(`${broker.baseUrl}/decisions?t=${broker.token}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: broker.baseUrl },
  body: JSON.stringify({ nonce, decision, reason, channel: 'ui' }),
})).status;

const makeTty = () => {
  const input = new PassThrough(), output = new PassThrough();
  let out = '';
  input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  output.isTTY = true;
  output.on('data', chunk => { out += chunk.toString(); });
  const press = (text, key = {}) => input.emit('keypress', text, key);
  const typeLine = text => { for (const char of text) press(char); press('', { name: 'return' }); };
  const until = async (needle, since = 0, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (!out.slice(since).includes(needle)) {
      if (Date.now() > deadline) throw new Error(`Terminal never rendered: ${JSON.stringify(needle)}\n--- output tail ---\n${out.slice(-2000)}`);
      await new Promise(resolve => { setTimeout(resolve, 50); });
    }
  };
  return { input, output, press, typeLine, until, get: () => out };
};

const { runTerminal } = await import('./code-mode-cli.mjs');
const openSession = async options => {
  const tty = makeTty();
  const done = runTerminal({ endpoint: model.url, model: 'mock-model', cwd: project, ...options }, tty.input, tty.output);
  await tty.until('Code Mode (experimental)');
  return { tty, done };
};

let agentId;
try {
  // --- Session 1: auto mode ------------------------------------------------
  const { tty, done } = await openSession({ mode: 'auto' });

  // S1: user input -> model -> REPL -> auto classification -> real file ->
  // rendered response.
  let mark = tty.get().length;
  tty.typeLine('Create the flow file TFA1');
  await tty.until('Done.', mark);
  assert.equal(await readFile(path.join(project, 'flow-ok.txt'), 'utf8'), 'terminal-flow-verified');
  assert.equal(classifierCalls.length, 1, 'one REPL execution gets exactly one classification');
  assert.equal(classifierCalls.at(-1).userIntent, 'Create the flow file TFA1');

  // S2: background completion is delivered to the terminal and reaches the
  // model as a poll_event turn.
  mark = tty.get().length;
  tty.typeLine('Run the background job TFB1');
  await tty.until('Arka plan ', mark);
  await tty.until('Background job reported: ok', mark);
  const jobId = tty.get().match(/Arka plan ([0-9a-f-]{8,})/)?.[1];
  assert.ok(jobId, 'the terminal must render the background job id');
  assert.equal(classifierCalls.length, 2);
  const pollCall = modelCalls.at(-1);
  assert.ok(String(pollCall.messages.at(-1).content).startsWith('Background code output (poll_event):'), 'background completion must reach the model as a poll_event');
  assert.ok(JSON.stringify(pollCall).includes('bg-ok'));

  // S3: Ctrl+O opens the transcript viewer (jobs with ids and status) and
  // toggles back to the conversation.
  mark = tty.get().length;
  tty.press('', { ctrl: true, name: 'o' });
  await tty.until(jobId, mark);
  mark = tty.get().length;
  tty.press('', { ctrl: true, name: 'o' });
  await tty.until('Background job reported: ok', mark);

  // S4: a UserPromptSubmit policy hook blocks the background output; the
  // canary must reach neither the terminal nor the model.
  const policyPath = path.join(root, 'policy.json');
  await writeFile(policyPath, JSON.stringify({ userPromptSubmit: [{ type: 'http', url: hook.url }] }));
  process.env.CODE_MODE_POLICY_PATH = policyPath;
  mark = tty.get().length;
  tty.typeLine('Log the canary TFD1');
  await tty.until('Background job output was blocked.', mark);
  delete process.env.CODE_MODE_POLICY_PATH;
  const lastHook = hookCalls.at(-1);
  assert.ok(typeof lastHook?.prompt === 'string' && lastHook.prompt.includes('canary-secret-777'), 'the output hook must receive the output');
  assert.ok(!tty.get().includes('canary-secret-777'), 'blocked output must not reach the terminal');
  const blockedPoll = modelCalls.at(-1);
  // The poll_event message is the new information the model receives; the
  // rest of the conversation legitimately echoes the model's own code.
  const pollEvent = String(blockedPoll.messages.at(-1).content);
  assert.ok(pollEvent.includes('outputBlocked'));
  assert.ok(!pollEvent.includes('canary-secret-777'), 'blocked output must not be delivered to the model');

  // S5: /exit renders the resume banner.
  tty.typeLine('/exit');
  await done;
  await tty.until('Devam: node code-mode-cli.mjs --resume');
  agentId = tty.get().match(/--resume ([0-9a-f-]{36})/)?.[1];
  assert.ok(agentId, 'the exit banner must offer --resume <session id>');

  // --- Session 2: restart on a fresh TTY ------------------------------------
  {
    const { tty: next, done: nextDone } = await openSession({ resume: agentId });
    mark = next.get().length;
    next.typeLine('Say hello TFE1');
    await next.until('Restarted ok', mark);
    const restartCall = modelCalls.at(-1);
    assert.ok(restartCall.messages.some(m => m.role === 'user' && String(m.content).includes('Create the flow file TFA1')), 'the restarted session must carry the previous conversation');
    next.typeLine('/exit');
    await nextDone;
  }

  // --- Session 3: default mode, denial through the native broker UI ----------
  {
    const { tty: gated, done: gatedDone } = await openSession({ mode: 'default' });
    gated.typeLine('Write the file TFC1');
    await gated.until('Onay gerekiyor: Write');
    const pending = await waitForPending(item => item.tool === 'Write');
    assert.equal(await uiDecision(pending.nonce, 'deny', 'denied by the user'), 200);
    await gated.until('The write was denied by the user.');
    assert.ok(!existsSync(path.join(project, 'denied.txt')), 'a denied approval must not produce the file effect');
    const recent = await brokerJson('/recent');
    assert.ok(recent.some(e => e.event === 'decision' && e.decision === 'deny' && e.tool === 'Write'), 'the broker audit must record the UI denial');
    gated.typeLine('/exit');
    await gatedDone;
  }

  console.log('PASS: terminal flow (input→model→REPL→auto→real file→response, background poll_event, Ctrl+O, native-broker denial, output blocking, restart)');
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); })));
  await broker.close('test').catch(() => {});
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
