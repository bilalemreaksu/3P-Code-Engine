import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { runHooks, validateHooks } from './code-mode-hooks.mjs';
import { viewerKey, renderViewer, interactiveViewer } from './code-mode-transcript.mjs';
import { loadCodePolicy } from './code-mode-policy.mjs';

const dir = await mkdtemp(path.join(process.cwd(), 'code-mode-hooks-test-'));
let http;
try {
  const configuredPolicy = process.env.CODE_MODE_POLICY_PATH;
  try {
    delete process.env.CODE_MODE_POLICY_PATH;
    const bundled = JSON.parse(await readFile(new URL('./code-mode-policy.json', import.meta.url), 'utf8'));
    assert.equal((await loadCodePolicy(dir, undefined, 'rules')).hasOutputHooks, (bundled.userPromptSubmit?.length ?? 0) > 0);
    process.env.CODE_MODE_POLICY_PATH = path.join(dir, 'missing-policy.json');
    await assert.rejects(loadCodePolicy(dir, undefined, 'rules'), { code: 'ENOENT' });
  } finally {
    if (configuredPolicy === undefined) delete process.env.CODE_MODE_POLICY_PATH; else process.env.CODE_MODE_POLICY_PATH = configuredPolicy;
  }
  const script = path.join(dir, 'hook.mjs');
  await writeFile(script, `let body = ''; for await (const part of process.stdin) body += part;
    const event = JSON.parse(body);
    if (event.hook_event_name !== 'PreToolUse' && event.source !== 'poll_event') process.exit(2);
    const mode = process.argv[2];
    if (mode === 'hang') await new Promise(r => setTimeout(r, 20000));
    else if (mode === 'invalid') console.log('invalid-json');
    else if (mode === 'deny') console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny'}}));
    else if (mode === 'ask') console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask'}}));
    else process.exitCode = Number(mode);`);
  const hook = (mode, extra = {}) => ({ tool: 'Write', command: process.execPath, args: [script, mode], ...extra });
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: dir, tool_input: { file_path: path.join(dir, 'sample') } };
  await runHooks([hook('0')], event);
  await runHooks([hook('1')], event);
  await assert.rejects(runHooks([hook('1', { onFailure: 'block' })], event), /hook refused Write/);
  await assert.rejects(runHooks([hook('2', { onFailure: 'continue' })], event), /hook refused Write/);
  await assert.rejects(runHooks([hook('127')], event), /hook refused Write/);
  await runHooks([hook('127', { onFailure: 'continue' })], event);
  await assert.rejects(runHooks([hook('hang', { timeoutMs: 100 })], event), /could not complete/);
  await runHooks([hook('hang', { timeoutMs: 100, onFailure: 'continue' })], event);
  await assert.rejects(runHooks([hook('invalid')], event), /could not complete/);
  await assert.rejects(runHooks([hook('deny', { onFailure: 'continue' })], event), /hook refused Write/);
  await assert.rejects(runHooks([hook('0', { command: path.join(dir, 'missing.exe') })], event), /could not complete/);
  await runHooks([hook('0', { command: path.join(dir, 'missing.exe'), onFailure: 'continue' })], event);
  assert.equal((await runHooks([hook('ask')], event)).ask, true);
  await runHooks([hook('2', { tool: 'Read' })], event);
  for (const value of [hook('0', { timeoutMs: 0 }), hook('0', { onFailure: 'ignore' }), { type: 'http', tool: '*', url: 'file:///etc/passwd' }, { type: 'mcp_tool', tool: '*' }]) {
    assert.throws(() => validateHooks([value], 'PreToolUse'));
  }
  let received;
  http = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    if (request.url === '/error') { response.writeHead(500).end('failed'); return; }
    if (request.url === '/invalid') { response.end('invalid'); return; }
    if (request.url === '/slow') { request.on('close', () => response.destroy()); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/block' ? { decision: 'block', reason: 'HTTP output policy' } : {}));
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${http.address().port}`;
  const outputEvent = { hook_event_name: 'UserPromptSubmit', source: 'poll_event', cwd: dir, prompt: 'sample-output' };
  await runHooks([{ type: 'http', url: endpoint }], outputEvent);
  assert.equal(received.source, 'poll_event'); assert.equal(received.prompt, 'sample-output');
  await assert.rejects(runHooks([{ type: 'http', url: endpoint + '/block', onFailure: 'continue' }], outputEvent), /HTTP output policy/);
  await assert.rejects(runHooks([{ type: 'http', url: endpoint + '/error' }], outputEvent), /could not complete/);
  await runHooks([{ type: 'http', url: endpoint + '/error', onFailure: 'continue' }], outputEvent);
  await assert.rejects(runHooks([{ type: 'http', url: endpoint + '/invalid' }], outputEvent), /could not complete/);
  await assert.rejects(runHooks([{ type: 'http', url: endpoint + '/slow', timeoutMs: 100 }], outputEvent), /could not complete/);

  const previousMcp = process.env.CODE_MODE_MCP_SERVERS;
  const previousConfig = process.env.CODE_MODE_MCP_CONFIG_PATH;
  const fixtureConfig = path.join(dir, 'desktop.json');
  await writeFile(fixtureConfig, '{"mcpServers":{}}');
  process.env.CODE_MODE_MCP_CONFIG_PATH = fixtureConfig;
  process.env.CODE_MODE_MCP_SERVERS = JSON.stringify({ fixture: { command: process.execPath, args: [path.join(process.cwd(), 'test-mcp-fixture.mjs')] } });
  try {
    const mcpHook = { type: 'mcp_tool', server: 'fixture', mcpTool: 'hook_check', timeoutMs: 3000 };
    await runHooks([mcpHook], outputEvent);
    for (const mode of ['error', 'invalid', 'hang']) {
      const config = { ...mcpHook, arguments: { mode }, ...(mode === 'hang' ? { timeoutMs: 1000 } : {}) };
      await assert.rejects(runHooks([config], outputEvent), /could not complete/);
      await runHooks([{ ...config, onFailure: 'continue' }], outputEvent);
    }
  } finally {
    if (previousMcp === undefined) delete process.env.CODE_MODE_MCP_SERVERS; else process.env.CODE_MODE_MCP_SERVERS = previousMcp;
    if (previousConfig === undefined) delete process.env.CODE_MODE_MCP_CONFIG_PATH; else process.env.CODE_MODE_MCP_CONFIG_PATH = previousConfig;
  }

  const job = { id: 'test-job', status: 'completed', result: { transcript: 'dangerous-code\u001b[2J', operations: [{ operation: 'edit', file: 'sample', oldText: 'before', newText: 'after' }], result: 'ok' } };
  const state = { jobs: [job], selected: 0, transcript: false, expanded: new Set() };
  assert.doesNotMatch(renderViewer(state), /dangerous-code/);
  viewerKey(state, { ctrl: true, name: 'o' });
  assert.match(renderViewer(state), /\[\+\] Code/);
  viewerKey(state, { name: 'return' });
  assert.match(renderViewer(state), /dangerous-code\\u001b\[2J/);
  assert.doesNotMatch(renderViewer(state), /\u001b/);
  viewerKey(state, { ctrl: true, name: 'o' });
  assert.doesNotMatch(renderViewer(state), /dangerous-code/);
  assert.match(renderViewer(state), /- before/); assert.match(renderViewer(state), /\+ after/);
  const input = new PassThrough(), output = new PassThrough();
  let rendered = ''; output.on('data', chunk => { rendered += chunk; });
  input.isTTY = output.isTTY = true; input.setRawMode = value => { input.isRaw = value; };
  const viewing = interactiveViewer(() => [job], input, output);
  input.emit('keypress', '', { ctrl: true, name: 'o' });
  input.emit('keypress', '', { name: 'return' });
  input.emit('keypress', '', { name: 'q' });
  await viewing;
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount('keypress'), 0);
  assert.match(rendered, /dangerous-code/);
  console.log('PASS: command/HTTP/MCP hook decisions, failures, timeouts and interactive transcript controls');
} finally {
  if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
  await rm(dir, { recursive: true, force: true });
}
