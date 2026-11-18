import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';

const dir = await mkdtemp(path.join(process.cwd(), 'code-mode-test-'));
let client = new Client({ name: 'code-mode-integration-test', version: '1.0.0' });
const policyPath = path.join(dir, 'policy.json');
const makeTransport = (mode = 'rules', env = {}) => new StdioClientTransport({ command: process.execPath, args: ['server-code-mode.mjs'], cwd: process.cwd(), env: { ...process.env, CODE_MODE_DATA_DIR: path.join(dir, 'saved-state'), CODE_MODE_MCP_CONFIG_PATH: path.join(dir, 'desktop-fixture.json'), CODE_MODE_POLICY_PATH: policyPath, CODE_MODE_PERMISSION_MODE: mode, ...env } });
// The "human" is simulated through the local approval broker's own HTTP
// API — the same surface the approval UI page uses. Every MCP client in
// this test declares NO elicitation capability, mirroring real clients
// such as Claude Desktop 3P: no MCP tool can grant an approval.
const brokerDir = path.join(dir, 'saved-state');
const brokerInfo = async () => {
  for (;;) {
    try {
      const info = JSON.parse(await readFile(path.join(brokerDir, 'broker.json'), 'utf8'));
      const health = await (await fetch(`http://127.0.0.1:${info.port}/health?token=1`)).json();
      if (health.ok) return { port: info.port, token: health.token };
    } catch { /* broker starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
};
const withToken = async p => { const b = await brokerInfo(); return `http://127.0.0.1:${b.port}${p}${p.includes('?') ? '&' : '?'}t=${b.token}`; };
const pendingList = async () => (await fetch(await withToken('/pending'))).json();
const decideApproval = async (nonce, decision, channel = 'ui') => {
  const b = await brokerInfo();
  const response = await fetch(`http://127.0.0.1:${b.port}/decisions?t=${b.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${b.port}` },
    body: JSON.stringify({ nonce, decision, channel }),
  });
  return response.status;
};
const waitForPending = async (filter, what) => {
  for (let i = 0; i < 200; i++) {
    const item = (await pendingList()).find(filter);
    if (item) return item;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what} approval request`);
};
const stopBroker = async () => {
  try {
    const info = JSON.parse(await readFile(path.join(brokerDir, 'broker.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${info.port}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: info.pid }) });
    await response.json().catch(() => null);
  } catch { /* broker never started */ }
};
try {
  await writeFile(policyPath, '{}');
  await writeFile(path.join(dir, 'sample.txt'), 'before\n');
  await writeFile(path.join(dir, 'desktop-fixture.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [path.join(process.cwd(), 'test-mcp-fixture.mjs')] }, disabledServer: { command: process.execPath, disabled: true }, '3p-code-mode': { command: process.execPath } } }));
  const { setProjectEnabled } = await import('./code-mode-settings.mjs');
  await setProjectEnabled(path.join(dir, 'saved-state'), dir);
  await setProjectEnabled(path.join(dir, 'saved-state'), os.tmpdir()); // the reviewAfter case runs there
  await client.connect(makeTransport());
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['code_cancel', 'code_execute', 'code_job_delete', 'code_session_delete', 'code_session_resume', 'code_start', 'code_status', 'review_and_fix', 'review_changes']);
  const call = async (code, extra = {}) => {
    const response = await client.callTool({ name: 'code_execute', arguments: { cwd: dir, code, ...extra } });
    return { response, result: JSON.parse(response.content[0].text) };
  };
  const start = async (code, extra = {}) => {
    const result = await client.callTool({ name: 'code_start', arguments: { cwd: dir, code, ...extra } });
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text).id;
  };
  const poll = async id => JSON.parse((await client.callTool({ name: 'code_status', arguments: { jobId: id } })).content[0].text);
  const until = async (action, matches) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await action(); if (matches(value)) return value; await new Promise(r => setTimeout(r, 30)); }
    throw new Error('Timed out waiting for job condition');
  };
  const finished = id => until(() => poll(id), value => value.status !== 'running');
  const success = await call(`const [first, second] = await Promise.all([read('sample.txt'), read('sample.txt')]);
    await edit('sample.txt', 'before', 'after');
    await write('created.txt', first + second);
    const test = await run('Write-Output code-mode-ok');
    return {text: await read('sample.txt'), exit: test.exitCode, version: test.stdout, error: test.stderr};`);
  assert.equal(success.result.ok, true);
  assert.match(success.result.result, /after/);
  assert.match(success.result.result, /exit: 0/);
  assert.equal(await readFile(path.join(dir, 'created.txt'), 'utf8'), 'before\nbefore\n');
  assert.ok(success.result.operations.some(item => item.operation === 'edit'));
  assert.match(success.response.content[1].text, /Yürütülen kod/);
  assert.match(success.response.content[1].text, /Önce/);
  const syntax = await call('const v = await $`Write-Output syntax-ok`.text(); ({value: v.trim(), check: $`Write-Output pass`.nothrow()});');
  assert.equal(syntax.result.ok, true); assert.match(syntax.result.result, /syntax-ok/); assert.match(syntax.result.result, /exitCode: 0/);
  const argument = await call('const item = "a; b"; const output = await $`Write-Output ${item}`.text(); output.trim();');
  assert.equal(argument.result.result, 'a; b');
  assert.equal((await call('await $`exit 7`.text();')).result.ok, false);
  assert.match((await call('await $`exit 7`.nothrow();')).result.result, /exitCode: 7/);
  assert.equal((await call('1 + 2')).result.result, '3');
  assert.equal((await call(`state.count = 7; return state.count;`, { sessionId: 'test-session' })).result.ok, true);
  assert.equal((await call(`return state.count;`, { sessionId: 'test-session' })).result.result, '7');
  const mcp = await call(`const result = await callMcp('fixture', 'echo', {message: 'bridge-ok'}); return result.content[0].text;`);
  assert.equal(mcp.result.result, 'bridge-ok'); assert.equal(mcp.result.operations[0].operation, 'mcp');
  const hook = path.join(dir, 'hook.mjs');
  await writeFile(hook, `let json = '';
    for await (const chunk of process.stdin) json += chunk;
    const event = JSON.parse(json);
    if (event.tool_name !== 'Bash' || event.session_id !== 'policy-test' ||
      event.tool_input.command.includes('hook-blocked')) process.exitCode = 2;`);
  await writeFile(policyPath, JSON.stringify({
    deny: ['Write', 'mcp__fixture__echo'],
    ask: ['Edit'],
    preToolUse: [{ tool: 'Bash', command: process.execPath, args: [hook] }],
  }));
  assert.match((await call("await write('created.txt', 'blocked');")).result.error, /policy denied Write/);
  assert.equal(await readFile(path.join(dir, 'created.txt'), 'utf8'), 'before\nbefore\n');
  {
    // An 'ask' entry in rules mode now resolves through the broker: the call
    // blocks until the human decides, and a denial leaves the file untouched.
    const askCall = call("await edit('sample.txt', 'after', 'blocked');");
    const askItem = await waitForPending(x => x.tool === 'Edit' && x.file?.endsWith('sample.txt'), 'asked Edit');
    assert.equal(await decideApproval(askItem.nonce, 'deny', 'ui'), 200);
    assert.match((await askCall).result.error, /Approval denied for Edit/);
  }
  assert.equal(await readFile(path.join(dir, 'sample.txt'), 'utf8'), 'after\n');
  assert.match((await call("await callMcp('fixture', 'echo');")).result.error, /policy denied mcp__fixture__echo/);
  assert.match((await call('await $`Write-Output hook-blocked`.nothrow();', { sessionId: 'policy-test' })).result.error, /hook refused Bash/);
  assert.equal((await call('await run("Write-Output permitted");', { sessionId: 'policy-test' })).result.ok, true);
  {
    // Hook contract end to end: the updatedInput is the executed input —
    // file, record and model result all use it — and additionalContext
    // reaches the model with the result.
    const updateHook = path.join(dir, 'update-hook.mjs');
    await writeFile(updateHook, `let body = ''; for await (const part of process.stdin) body += part;
      const event = JSON.parse(body);
      if (event.tool_name !== 'Write') process.exit(0);
      console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { file_path: event.tool_input.file_path.replace(/\\.txt$/, '-hooked.txt'), content: 'HOOK' }, additionalContext: 'hook-says-production' } }));`);
    await writeFile(policyPath, JSON.stringify({ preToolUse: [{ tool: 'Write', command: process.execPath, args: [updateHook] }] }));
    const hooked = await call(`await write('hook-target.txt', 'original'); return 'done';`);
    assert.equal(hooked.result.ok, true, hooked.result.error);
    assert.equal(hooked.result.result, 'done');
    assert.equal(hooked.result.additionalContext, 'hook-says-production');
    const written = hooked.result.operations.find(item => item.operation === 'write');
    assert.equal(written.file, path.join(dir, 'hook-target-hooked.txt'));
    assert.equal(await readFile(path.join(dir, 'hook-target-hooked.txt'), 'utf8'), 'HOOK');
    await assert.rejects(readFile(path.join(dir, 'hook-target.txt')), { code: 'ENOENT' });
    await writeFile(policyPath, '{}');
  }
  await writeFile(policyPath, '{"deny":["REPL"]}');
  assert.match((await call('1 + 2')).result.error, /policy denied REPL/);
  await writeFile(policyPath, '{}');
  assert.match((await call(`return await listMcpServers();`)).result.result, /fixture/);
  assert.match((await call(`return (await listMcpTools('fixture')).tools;`)).result.result, /echo/);
  const started = await client.callTool({ name: 'code_start', arguments: { cwd: dir, code: `log('live-before-completion'); await run('Write-Output output-first; Start-Sleep -Milliseconds 1200; Write-Output output-last'); return 'background-ok';` } });
  const jobId = JSON.parse(started.content[0].text).id;
  let job, sawLive = false, sawStdout = false, sequence = 0;
  for (let i = 0; i < 100; i++) {
    job = JSON.parse((await client.callTool({ name: 'code_status', arguments: { jobId, afterSequence: sequence } })).content[0].text);
    if (job.status === 'running' && job.events.some(event => event.kind === 'log' && event.data === 'live-before-completion')) sawLive = true;
    if (job.status === 'running' && job.events.some(event => event.kind === 'stdout' && event.data.includes('output-first'))) sawStdout = true;
    if (job.events.length) sequence = job.events.at(-1).sequence;
    if (job.status !== 'running') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(sawLive, true); assert.equal(sawStdout, true); assert.equal(job.status, 'completed'); assert.equal(job.result.result, 'background-ok');
  const outputHook = path.join(dir, 'output-hook.mjs');
  await writeFile(outputHook, `let body = ''; for await (const chunk of process.stdin) body += chunk;
    const event = JSON.parse(body);
    if (event.source !== 'poll_event' || event.hook_event_name !== 'UserPromptSubmit') process.exit(2);
    await new Promise(r => setTimeout(r, 150));
    if (event.prompt.includes('withheld-secret')) console.log(JSON.stringify({ decision: 'block', reason: 'Output withheld by policy' }));`);
  await writeFile(path.join(dir, 'secret.txt'), 'withheld-secret-value');
  const secretCode = `const text = await read('secret.txt'); log(text); await new Promise(r => setTimeout(r, 100)); state.secret = text; return text;`;
  await writeFile(policyPath, JSON.stringify({ userPromptSubmit: [{ command: process.execPath, args: [outputHook] }] }));
  const blockedId = await start(secretCode, { sessionId: 'output-test' });
  const blocked = await finished(blockedId);
  assert.equal(blocked.result.outputBlocked, true); assert.equal(blocked.result.ok, false);
  assert.deepEqual(blocked.events, []);
  assert.doesNotMatch(JSON.stringify(blocked), /withheld-secret-value/);
  const lateOutput = await finished(await start(`const secret = await read('secret.txt'); setTimeout(() => log(secret), 20); return 'public-result';`));
  assert.equal(lateOutput.result.result, 'public-result');
  assert.doesNotMatch(JSON.stringify(lateOutput), /withheld-secret-value/);
  assert.equal((await call('return state.secret;', { sessionId: 'output-test' })).result.result, null);
  await writeFile(policyPath, JSON.stringify({ userPromptSubmit: [{ type: 'mcp_tool', server: 'fixture', mcpTool: 'hook_check' }] }));
  const mcpBlocked = await finished(await start(secretCode));
  assert.equal(mcpBlocked.result.outputBlocked, true);
  assert.doesNotMatch(JSON.stringify(mcpBlocked), /withheld-secret-value/);
  const mcpAllowed = await finished(await start(`log('allowed-log'); return 'allowed-output';`));
  assert.equal(mcpAllowed.result.ok, true); assert.equal(mcpAllowed.result.result, 'allowed-output');
  assert.ok(mcpAllowed.events.some(event => event.data === 'allowed-log'));
  await writeFile(policyPath, JSON.stringify({ userPromptSubmit: [{ command: process.execPath, args: [path.join(dir, 'ctx-output-hook.mjs')] }] }));
  await writeFile(path.join(dir, 'ctx-output-hook.mjs'), `let body = ''; for await (const chunk of process.stdin) body += chunk;
    const event = JSON.parse(body);
    if (event.source !== 'poll_event' || event.hook_event_name !== 'UserPromptSubmit') process.exit(2);
    console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: 'out-ctx' } }));`);
  const ctxOut = await finished(await start(`return 'with-context';`));
  assert.equal(ctxOut.result.result, 'with-context');
  assert.equal(ctxOut.result.additionalContext, 'out-ctx');
  await writeFile(policyPath, JSON.stringify({ userPromptSubmit: [{ command: process.execPath, args: [path.join(dir, 'missing-hook.mjs')], onFailure: 'continue' }] }));
  assert.equal((await finished(await start(`return 'continue-output';`))).result.result, 'continue-output');
  await writeFile(policyPath, '{}');
  await client.close();
  client = new Client({ name: 'code-mode-integration-test-restarted', version: '1.0.0' });
  await client.connect(makeTransport());
  const session = JSON.parse((await client.callTool({ name: 'code_session_resume', arguments: { sessionId: 'test-session' } })).content[0].text);
  assert.equal(session.cwd, dir);
  assert.equal(session.mode, 'rules');
  assert.equal(session.history.length, 2);
  assert.equal((await call('return state.count;', { cwd: undefined, sessionId: 'test-session' })).result.result, '7');
  const recovered = JSON.parse((await client.callTool({ name: 'code_status', arguments: { jobId } })).content[0].text);
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.result.result, 'background-ok');
  assert.match(recovered.result.transcript, /background-ok/);
  const recoveredBlocked = await poll(blockedId);
  assert.equal(recoveredBlocked.result.outputBlocked, true);
  assert.doesNotMatch(JSON.stringify(recoveredBlocked), /withheld-secret-value/);
  assert.equal(JSON.parse((await client.callTool({ name: 'code_job_delete', arguments: { jobId } })).content[0].text).deleted, true);
  const longJob = JSON.parse((await client.callTool({ name: 'code_start', arguments: { cwd: dir, code: `await new Promise(r => setTimeout(r, 10000));` } })).content[0].text);
  const cancelled = JSON.parse((await client.callTool({ name: 'code_cancel', arguments: { jobId: longJob.id } })).content[0].text);
  assert.equal(cancelled.status, 'cancelled');
  const failure = await call(`await edit('sample.txt', 'missing', 'x');`);
  assert.equal(failure.response.isError, true);
  assert.match(failure.result.error, /match exactly once/);
  const reviewed = await call(`return 'done';`, { cwd: os.tmpdir(), reviewAfter: { mode: 'quick' } });
  assert.equal(reviewed.result.ok, true);
  assert.ok(['failed', 'incomplete'].includes(reviewed.result.review.status));
  const timeout = await call(`await new Promise(() => {});`, { timeoutMs: 1000 });
  // An unresolved promise with no active handles may exit earlier, which is also a failure.
  assert.equal(timeout.response.isError, true);
  await client.close();
  client = new Client({ name: 'approval-test', version: '1.0.0' });
  await client.connect(makeTransport('default'));
  {
    // Deny: the tool call blocks until the human decides; code_status only
    // observes and must never consume the approval.
    const pendingCall = client.callTool({ name: 'code_execute', arguments: { cwd: dir, code: `await tools.Edit('sample.txt', 'after', 'approved');` } });
    const item = await waitForPending(x => x.tool === 'Edit' && x.file?.endsWith('sample.txt'), 'Edit');
    assert.match(item.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
    const view = JSON.parse((await client.callTool({ name: 'code_status', arguments: { jobId: item.jobId } })).content[0].text);
    assert.equal(view.status, 'running');
    assert.ok(view.pendingApprovals?.some(p => p.tool === 'Edit' && p.deadline && p.url === item.url));
    assert.doesNotMatch(JSON.stringify(view), new RegExp(item.nonce), 'the nonce must never reach the model');
    for (let i = 0; i < 5; i++) {
      await client.callTool({ name: 'code_status', arguments: { jobId: item.jobId } });
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal((await pendingList()).length, 1, 'polling code_status must not resolve the approval');
    // A background fetch holding the relayed URL (token included) cannot
    // grant the decision: the broker requires the approval UI's origin.
    const raw = await fetch(await withToken('/decisions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: item.nonce, decision: 'approve', channel: 'ui' }),
    });
    assert.equal(raw.status, 403, 'a fetch without the UI origin cannot grant a decision');
    assert.equal(await decideApproval(item.nonce, 'deny'), 200);
    const denied = JSON.parse((await pendingCall).content[0].text);
    assert.match(denied.error, /Approval denied for Edit/);
    assert.equal(await readFile(path.join(dir, 'sample.txt'), 'utf8'), 'after\n');
    assert.equal(await decideApproval(item.nonce, 'approve'), 409, 'a consumed nonce is one-time');
  }
  {
    // Approve: the file changes only after the human's decision.
    const pendingCall = client.callTool({ name: 'code_execute', arguments: { cwd: dir, code: `await tools.Edit('sample.txt', 'after', 'approved');` } });
    const item = await waitForPending(x => x.tool === 'Edit', 'Edit');
    assert.equal(await decideApproval(item.nonce, 'approve'), 200);
    const approved = JSON.parse((await pendingCall).content[0].text);
    assert.equal(approved.ok, true);
    assert.equal(await readFile(path.join(dir, 'sample.txt'), 'utf8'), 'approved\n');
    const record = (await client.callTool({ name: 'code_status', arguments: { jobId: item.jobId } })).content.map(item => item.text).join('\n');
    assert.match(record, /- after\r?\n\s+\+ approved/);
  }
  {
    // The human sees the hook-updated input: the approval preview and the
    // executed file are the replacement, not the original request.
    const askUpdateHook = path.join(dir, 'ask-update-hook.mjs');
    await writeFile(askUpdateHook, `let body = ''; for await (const part of process.stdin) body += part;
      const event = JSON.parse(body);
      if (event.tool_name !== 'Write') process.exit(0);
      console.log(JSON.stringify({ hookSpecificOutput: { updatedInput: { file_path: event.tool_input.file_path.replace(/\\.txt$/, '-asked.txt'), content: 'HOOK-ASKED' } } }));`);
    await writeFile(policyPath, JSON.stringify({ ask: ['Write'], preToolUse: [{ tool: 'Write', command: process.execPath, args: [askUpdateHook] }] }));
    const askedCall = call(`await write('asked.txt', 'orig');`);
    const askedItem = await waitForPending(x => x.tool === 'Write' && x.file?.endsWith('asked-asked.txt'), 'hook-updated Write');
    assert.match(askedItem.preview, /HOOK-ASKED/);
    assert.equal(await decideApproval(askedItem.nonce, 'approve', 'ui'), 200);
    const asked = await askedCall;
    assert.equal(asked.result.ok, true, asked.result.error);
    assert.equal(await readFile(path.join(dir, 'asked-asked.txt'), 'utf8'), 'HOOK-ASKED');
    await writeFile(policyPath, '{}');
  }
  {
    // Capability evidence: this client declared no elicitation support, and
    // the server still completed the approval flow through the broker.
    const lines = (await readFile(path.join(brokerDir, 'client-capabilities.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const mine = lines.find(line => line.clientInfo?.name === 'approval-test');
    assert.ok(mine, 'client capabilities should be logged on initialize');
    assert.equal(mine.capabilities?.elicitation, undefined);
    const isolation = JSON.parse(await readFile(path.join(brokerDir, 'isolation.json'), 'utf8'));
    assert.equal(isolation.platform, process.platform);
  }
  // The same-permission-mode requirement is relaxed: resuming under a
  // different effective mode succeeds, and the saved mode is plain metadata.
  const otherMode = await client.callTool({ name: 'code_session_resume', arguments: { sessionId: 'test-session' } });
  assert.ok(!otherMode.isError, otherMode.content?.[0]?.text);
  assert.equal(JSON.parse(otherMode.content[0].text).mode, 'rules');
  await client.close();

  client = new Client({ name: 'plan-test', version: '1.0.0' });
  await client.connect(makeTransport('plan'));
  assert.equal((await call("await tools.Read('sample.txt')")).result.result, 'approved\n');
  assert.match((await call("await tools.Write('sample.txt', 'blocked')")).result.error, /plan mode denied Write/);
  assert.equal(await readFile(path.join(dir, 'sample.txt'), 'utf8'), 'approved\n');
  for (const name of ['review_changes', 'review_and_fix']) {
    const denied = await client.callTool({ name, arguments: { cwd: dir } });
    assert.equal(denied.isError, true); assert.match(denied.content[0].text, /outside Code Mode permissions/);
  }
  assert.equal((await client.callTool({ name: 'code_start', arguments: { cwd: dir, code: '1' } })).isError, true);
  await client.close();

  const classifier = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { code } = JSON.parse(JSON.parse(body).messages[1].content);
    const decision = code.includes('reject-me') ? 'deny' : 'allow';
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision }) } }] }));
  });
  await new Promise((resolve, reject) => {
    classifier.once('error', reject);
    classifier.listen(0, '127.0.0.1', resolve);
  });
  try {
    const classifierEnv = {
      CODE_MODE_CLASSIFIER_ENDPOINT: `http://127.0.0.1:${classifier.address().port}/v1`,
      CODE_MODE_CLASSIFIER_MODEL: 'fixture',
    };
    client = new Client({ name: 'classifier-test', version: '1.0.0' });
    let autoApprovals = 0;
    const approvePendingWrite = async name => {
      const item = await waitForPending(x => x.tool === 'Write' && x.file?.endsWith(name), `Write ${name}`);
      autoApprovals++;
      assert.equal(await decideApproval(item.nonce, 'approve', 'ui'), 200);
    };
    await client.connect(makeTransport('auto', classifierEnv));
    assert.match((await call('return "reject-me";')).result.error, /classifier denied REPL/);
    assert.equal((await call('return "allowed";')).result.result, 'allowed');
    await writeFile(path.join(dir, 'release.txt'), 'wait');
    const autoCode = `log('auto-ready'); while ((await read('release.txt')) !== 'go') await new Promise(r => setTimeout(r, 30)); await write('auto-gated.txt', 'approved'); return 'gated-complete';`;
    const gated = await start(autoCode);
    await until(() => poll(gated), job => job.events.some(event => event.data === 'auto-ready'));
    assert.equal((await call('return "new-code";')).result.ok, true);
    await writeFile(path.join(dir, 'release.txt'), 'go');
    const gatedDone = finished(gated);
    await approvePendingWrite('auto-gated.txt');
    assert.equal((await gatedDone).result.result, 'gated-complete');
    assert.equal(autoApprovals, 1);
    assert.equal(await readFile(path.join(dir, 'auto-gated.txt'), 'utf8'), 'approved');
    // An explicit ask on an invalidated job must prompt exactly once.
    await writeFile(policyPath, JSON.stringify({ ask: ['Write'] }));
    await writeFile(path.join(dir, 'release.txt'), 'wait');
    const asked = await start(autoCode);
    await until(() => poll(asked), job => job.events.some(event => event.data === 'auto-ready'));
    await call('return "invalidate-asked-job";');
    await writeFile(path.join(dir, 'release.txt'), 'go');
    const askedDone = finished(asked);
    await approvePendingWrite('auto-gated.txt');
    assert.equal((await askedDone).result.result, 'gated-complete');
    assert.equal(autoApprovals, 2);
    // A hook that changes the input after the auto review cannot run under
    // the old review: the human approves the changed input.
    const autoUpdateHook = path.join(dir, 'auto-update-hook.mjs');
    await writeFile(autoUpdateHook, `let body = ''; for await (const part of process.stdin) body += part;
      const event = JSON.parse(body);
      if (event.tool_name !== 'Write') process.exit(0);
      console.log(JSON.stringify({ hookSpecificOutput: { updatedInput: { file_path: event.tool_input.file_path + '.reworked', content: 'REWORKED' } } }));`);
    await writeFile(policyPath, JSON.stringify({ preToolUse: [{ tool: 'Write', command: process.execPath, args: [autoUpdateHook] }] }));
    const reworkedCall = call(`await write('auto-reworked.txt', 'original'); return 'reworked-done';`);
    const reworked = await waitForPending(x => x.tool === 'Write' && x.file?.endsWith('auto-reworked.txt.reworked'), 'hook-reworked Write');
    assert.equal(await decideApproval(reworked.nonce, 'approve', 'ui'), 200);
    assert.equal((await reworkedCall).result.ok, true);
    assert.equal(await readFile(path.join(dir, 'auto-reworked.txt.reworked'), 'utf8'), 'REWORKED');
    await writeFile(policyPath, '{}');
    await client.close();

    client = new Client({ name: 'countdown-test', version: '1.0.0' });
    await client.connect(makeTransport('auto', { ...classifierEnv, CODE_MODE_APPROVAL_TIMEOUT_MS: '150' }));
    await writeFile(path.join(dir, 'release.txt'), 'wait');
    const expired = await start(`log('auto-ready'); while ((await read('release.txt')) !== 'go') await new Promise(r => setTimeout(r, 30));
      try { await write('expired.txt', 'should-not-exist'); } catch (e) { log(e.message); }
      try { await write('expired-again.txt', 'should-not-exist'); } catch (e) { return e.message; }`);
    await until(() => poll(expired), job => job.events.some(event => event.data === 'auto-ready'));
    await call('return "invalidate-again";');
    await writeFile(path.join(dir, 'release.txt'), 'go');
    // Do not poll while the approval countdown is active: no client is answering it.
    await new Promise(r => setTimeout(r, 400));
    const timedOut = await finished(expired);
    assert.match(timedOut.result.result, /countdown expired/);
    await assert.rejects(readFile(path.join(dir, 'expired.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(dir, 'expired-again.txt')), { code: 'ENOENT' });
  } finally {
    await client.close();
    await new Promise(resolve => classifier.close(resolve));
  }
  console.log('PASS: MCP execution, approval, auto classification, transcripts and session resume');
} finally {
  await client.close();
  await stopBroker();
  await rm(dir, { recursive: true, force: true });
}
