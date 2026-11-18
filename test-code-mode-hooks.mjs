import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { runHooks, validateHooks, normalizeHooks } from './code-mode-hooks.mjs';
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
    else if (mode === 'allow') console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'allow'}}));
    else if (mode === 'approve') console.log(JSON.stringify({decision:'approve'}));
    else if (mode === 'update') console.log(JSON.stringify({hookSpecificOutput:{updatedInput:{file_path:event.tool_input.file_path+'.updated',content:'HOOK-EDITED'},additionalContext:'hook-context'}}));
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
  // Official PreToolUse contract: allow / updatedInput / additionalContext
  // carry through runHooks instead of being dropped.
  const updated = await runHooks([hook('update')], event);
  assert.equal(updated.ask, false);
  assert.equal(updated.allow, false);
  assert.deepEqual(updated.updatedInput, { file_path: event.tool_input.file_path + '.updated', content: 'HOOK-EDITED' });
  assert.deepEqual(updated.additionalContext, ['hook-context']);
  assert.equal((await runHooks([hook('allow')], event)).allow, true);
  assert.equal((await runHooks([hook('approve')], event)).allow, true);
  const combined = await runHooks([hook('allow'), hook('ask')], event);
  assert.equal(combined.ask, true);
  assert.equal(combined.allow, true);
  await assert.rejects(runHooks([hook('allow'), hook('deny')], event), /hook refused Write/);
  // A later hook sees the input the earlier hook returned.
  const chained = await runHooks([hook('update'), hook('update')], event);
  assert.deepEqual(chained.updatedInput, { file_path: event.tool_input.file_path + '.updated.updated', content: 'HOOK-EDITED' });
  // A timed-out update hook contributes no decision and no input.
  const silentTimeout = await runHooks([hook('hang', { timeoutMs: 100, onFailure: 'continue' })], event);
  assert.equal(silentTimeout.updatedInput, undefined);
  assert.deepEqual(silentTimeout.additionalContext, []);
  for (const value of [hook('0', { timeoutMs: 0 }), hook('0', { onFailure: 'ignore' }), { type: 'http', tool: '*', url: 'file:///etc/passwd' }, { type: 'mcp_tool', tool: '*' }]) {
    assert.throws(() => validateHooks([value], 'PreToolUse'));
  }
  // Native hooks configuration adapter: matcher groups, timeout in seconds,
  // explicit errors for unsupported fields (never silently dropped).
  const normalized = normalizeHooks([{ matcher: 'Bash|Edit', hooks: [{ command: process.execPath, args: [script, '0'], timeout: 5 }] }], 'PreToolUse');
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized.map(hook => hook.tool).sort(), ['Bash', 'Edit']);
  assert.equal(normalized[0].type, 'command');
  assert.equal(normalized[0].timeoutMs, 5000);
  assert.equal('timeout' in normalized[0], false);
  const nativeMcp = normalizeHooks([{ matcher: '*', hooks: [{ type: 'mcp_tool', server: 'fixture', tool: 'hook_check', input: { mode: 'x' }, timeout: 2 }] }], 'PreToolUse');
  assert.equal(nativeMcp[0].mcpTool, 'hook_check');
  assert.deepEqual(nativeMcp[0].arguments, { mode: 'x' });
  assert.equal(nativeMcp[0].timeoutMs, 2000);
  assert.equal(normalizeHooks([{ hooks: [{ command: process.execPath, args: [script, '0'] }] }], 'PreToolUse')[0].tool, '*');
  assert.equal(normalizeHooks([{ matcher: '', hooks: [{ command: process.execPath, args: [script, '0'] }] }], 'UserPromptSubmit')[0].tool, '*');
  const flatNormalized = normalizeHooks([{ tool: 'Write', command: process.execPath, args: [script, '0'], timeout: 7 }], 'PreToolUse');
  assert.equal(flatNormalized[0].tool, 'Write');
  assert.equal(flatNormalized[0].timeoutMs, 7000);
  for (const [bad, pattern] of [
    [[{ matcher: 'Edit.*', hooks: [{ command: process.execPath }] }], /Regex matchers are not supported/],
    [[{ matcher: 'Bash', hooks: [{ command: process.execPath, if: 'Bash(rm *)' }] }], /hook field 'if'/],
    [[{ matcher: 'Bash', hooks: [{ command: process.execPath, async: true }] }], /hook field 'async'/],
    [[{ matcher: 'Bash', hooks: [{ command: process.execPath, statusMessage: 'w' }] }], /hook field 'statusMessage'/],
    [[{ matcher: 'Bash', hooks: [{ command: process.execPath, once: true }] }], /hook field 'once'/],
    [[{ matcher: 'Bash', hooks: [{ command: process.execPath, shell: 'bash' }] }], /hook field 'shell'/],
    [[{ matcher: 'Bash', hooks: [{ command: process.execPath, allowedEnvVars: [] }] }], /hook field 'allowedEnvVars'/],
    [[{ matcher: 'Bash', hooks: [{ type: 'prompt', command: process.execPath }] }], /hook type 'prompt'/],
    [[{ matcher: 'Bash', hooks: [{ type: 'agent', command: process.execPath }] }], /hook type 'agent'/],
    [[{ matcher: 'Bash', hooks: [{ command: process.execPath, timeout: 5, timeoutMs: 6000 }] }], /both timeout/],
    [[{ matcher: 'Bash', hooks: [{ command: process.execPath, timeout: '5' }] }], /hook timeout/],
    [[{ matcher: 'Bash', hooks: [{ command: process.execPath, timeout: 0.05 }] }], /hook timeout/],
    [[{ matcher: 'Bash', hooks: [{ command: process.execPath, timeout: 601 }] }], /hook timeout/],
    [[{ matcher: 'Bash', timeout: 5, hooks: [{ command: process.execPath }] }], /group field 'timeout'/],
    [[{ matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: 'fixture', tool: 'a', mcpTool: 'b' }] }], /tool and mcpTool/],
  ]) {
    assert.throws(() => normalizeHooks(bad, 'PreToolUse'), pattern);
  }
  // A PreToolUse handler with no tool filter is still rejected.
  assert.throws(() => normalizeHooks([{ command: process.execPath, args: [script, '0'] }], 'PreToolUse'), /PreToolUse hook/);
  let received;
  http = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    if (request.url === '/error') { response.writeHead(500).end('failed'); return; }
    if (request.url === '/invalid') { response.end('invalid'); return; }
    if (request.url === '/slow') { request.on('close', () => response.destroy()); return; }
    response.setHeader('Content-Type', 'application/json');
    const output = {
      '/block': { decision: 'block', reason: 'HTTP output policy' },
      '/allow': { hookSpecificOutput: { permissionDecision: 'allow' } },
      '/update': { hookSpecificOutput: { updatedInput: { file_path: (received.tool_input?.file_path ?? 'http') + '-http', content: 'HTTP-EDITED' }, additionalContext: 'http-ctx' } },
      '/defer': { hookSpecificOutput: { permissionDecision: 'defer' } },
      '/updatedlist': { hookSpecificOutput: { updatedInput: ['nope'] } },
      '/badctx': { hookSpecificOutput: { additionalContext: 42 } },
      '/systemmessage': { systemMessage: 'x' },
      '/badevent': { hookSpecificOutput: { hookEventName: 'OtherEvent' } },
    }[request.url] ?? {};
    response.end(JSON.stringify(output));
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
  // HTTP hook output contract.
  const httpUpdated = await runHooks([{ type: 'http', tool: '*', url: endpoint + '/update' }], event);
  assert.equal(httpUpdated.updatedInput?.content, 'HTTP-EDITED');
  assert.deepEqual(httpUpdated.additionalContext, ['http-ctx']);
  assert.equal((await runHooks([{ type: 'http', tool: '*', url: endpoint + '/allow' }], event)).allow, true);
  await assert.rejects(runHooks([{ type: 'http', tool: '*', url: endpoint + '/defer' }], event), /Invalid hook permission decision/);
  await assert.rejects(runHooks([{ type: 'http', tool: '*', url: endpoint + '/updatedlist' }], event), /Invalid updatedInput/);
  await assert.rejects(runHooks([{ type: 'http', tool: '*', url: endpoint + '/badctx' }], event), /Invalid additionalContext/);
  await assert.rejects(runHooks([{ type: 'http', tool: '*', url: endpoint + '/systemmessage' }], event), /systemMessage/);
  await assert.rejects(runHooks([{ type: 'http', tool: '*', url: endpoint + '/badevent' }], event), /hookEventName/);
  await assert.rejects(runHooks([{ type: 'http', url: endpoint + '/update' }], outputEvent), /PreToolUse/);

  const previousMcp = process.env.CODE_MODE_MCP_SERVERS;
  const previousConfig = process.env.CODE_MODE_MCP_CONFIG_PATH;
  const fixtureConfig = path.join(dir, 'desktop.json');
  await writeFile(fixtureConfig, '{"mcpServers":{}}');
  process.env.CODE_MODE_MCP_CONFIG_PATH = fixtureConfig;
  process.env.CODE_MODE_MCP_SERVERS = JSON.stringify({ fixture: { command: process.execPath, args: [path.join(process.cwd(), 'test-mcp-fixture.mjs')] } });
  try {
    const mcpHook = { type: 'mcp_tool', server: 'fixture', mcpTool: 'hook_check', timeoutMs: 3000 };
    await runHooks([mcpHook], outputEvent);
    const mcpUpdated = await runHooks([{ ...mcpHook, tool: '*', arguments: { mode: 'update' } }], event);
    assert.deepEqual(mcpUpdated.updatedInput, { file_path: 'mcp-updated', note: 'mcp' });
    assert.deepEqual(mcpUpdated.additionalContext, ['mcp-ctx']);
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
