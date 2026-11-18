import { readFile, writeFile, realpath, stat, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { inspect } from 'node:util';
import { loadCodePolicy } from './code-mode-policy.mjs';
import { mcpDefinitions, withMcp } from './code-mode-mcp.mjs';
import { send as channelSend, connected, onMessage, disconnect } from './code-mode-channel.mjs';
import { requestHost } from './code-mode-rpc.mjs';
import { evaluateCode } from './code-mode-runtime.mjs';

// This trusted adapter owns OS access. Generated code runs in a QuickJS
// WASM heap and reaches OS/MCP operations only through checked helpers.
const OUTPUT_LIMIT = 64 * 1024;
const cap = value => {
  const text = typeof value === 'string' ? value : inspect(value, { depth: 5, maxArrayLength: 100 });
  return text.length > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) + '\n...[truncated]' : text;
};
const logs = [];
const operations = [];
let progressChars = 0;
let progressTruncated = false;
let checkTool;
let hostPolicy = false;
let holdOutput = false;
let outputClosed = false;
const heldEvents = [];
// additionalContext collected from hooks; the model receives it with the
// final result, exactly like the updated inputs it refers to.
const contexts = [];
const noteContext = list => { for (const value of list ?? []) if (typeof value === 'string') contexts.push(value); };
const progress = (kind, data) => {
  if (!connected() || outputClosed) return;
  const input = String(data);
  const value = input.slice(0, Math.min(4096, Math.max(0, OUTPUT_LIMIT - progressChars)));
  progressChars += value.length;
  try {
    const emit = event => { if (holdOutput) heldEvents.push(event); else channelSend(event, () => {}); };
    if (value) emit({ __codeModeProgress: true, kind, data: value });
    if (value.length < input.length && !progressTruncated) {
      progressTruncated = true;
      emit({ __codeModeProgress: true, kind: 'limit', data: 'Live output truncated.' });
    }
  } catch { /* parent may disconnect */ }
};
const sendFinal = result => new Promise(resolve => { if (!connected()) return resolve(); try { channelSend(result, () => resolve()); } catch { resolve(); } });
const record = (operation, details) => { if (operations.length < 100) { operations.push({ operation, ...details }); progress('operation', JSON.stringify({ operation, ...details })); } };
const log = (...args) => { if (logs.length < 100) { const value = cap(args.map(a => cap(a)).join(' ')); logs.push(value); progress('log', value); } };

async function listMcpServers() { return hostPolicy ? requestHost('listMcpServers') : Object.keys(await mcpDefinitions()); }
async function listMcpTools(serverName) {
  if (typeof serverName !== 'string') throw new Error('Invalid MCP server name');
  if (hostPolicy) return requestHost('listMcpTools', { server: serverName });
  const { input, context } = await checkTool('McpListTools', { server: serverName });
  noteContext(context);
  if (typeof input?.server !== 'string' || !input.server) throw new Error('updated list input must carry a server name');
  return withMcp(input.server, client => client.listTools());
}
async function callMcp(serverName, toolName, args = {}) {
  if (typeof toolName !== 'string') throw new Error('Invalid MCP tool name');
  const argumentsSnapshot = JSON.parse(JSON.stringify(args));
  if (hostPolicy) {
    const result = await requestHost('callMcp', { server: serverName, tool: toolName, args: argumentsSnapshot });
    record('mcp', { server: serverName, tool: toolName, isError: !!result.isError });
    return result;
  }
  // The check may return the input a hook replaced; that is what executes.
  const { input, context } = await checkTool(`mcp__${serverName}__${toolName}`, argumentsSnapshot);
  noteContext(context);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('updated MCP arguments must be an object');
  return withMcp(serverName, async client => {
    const result = await client.callTool({ name: toolName, arguments: input });
    record('mcp', { server: serverName, tool: toolName, isError: !!result.isError });
    return result;
  });
}

async function run(command, { cwd = '.', timeoutMs = 60000 } = {}) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('command must be a nonempty string');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 7200000) throw new Error('timeoutMs must be 100..7200000');
  const directory = path.resolve(cwd);
  // The check may return the input a hook replaced; that is what executes.
  const { input, context } = await checkTool('Bash', { command, cwd: directory, timeout: timeoutMs });
  noteContext(context);
  if (typeof input?.command !== 'string' || !input.command.trim()) throw new Error('updated Bash input must carry a command');
  const effectiveCwd = typeof input.cwd === 'string' && input.cwd ? path.resolve(input.cwd) : directory;
  const effectiveTimeout = typeof input.timeout === 'number' && Number.isInteger(input.timeout) && input.timeout >= 100 && input.timeout <= 7200000 ? input.timeout : timeoutMs;
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', input.command]
      : ['-c', input.command], { cwd: effectiveCwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, truncated = false;
    const append = (current, data) => {
      const s = data.toString();
      if (current.length + s.length > OUTPUT_LIMIT) truncated = true;
      return (current + s).slice(0, OUTPUT_LIMIT);
    };
    child.stdout.on('data', b => { stdout = append(stdout, b); progress('stdout', b.toString()); });
    child.stderr.on('data', b => { stderr = append(stderr, b); progress('stderr', b.toString()); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (windows && child.pid) spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref();
      else child.kill('SIGKILL');
    }, effectiveTimeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); resolve({ ok: exitCode === 0 && !timedOut, command: input.command, exitCode, signal, timedOut, truncated, stdout, stderr }); });
  });
}

onMessage(async message => {
  // Only the initial job message starts execution; decision replies
  // ({decisionId, allowed, error}) are consumed by the policy module's own
  // listener. The original used process.once; the channel listener is
  // persistent, so filter by shape instead.
  if (typeof message?.code !== 'string') return;
  const { code, cwd, sessionId, mode, background = false, state = {}, policy, timeoutMs } = message;
  let result;
  try {
    process.chdir(await realpath(cwd));
    if (!(await stat('.')).isDirectory()) throw new Error('cwd must be a directory');
    hostPolicy = message.hostPolicy === true;
    // Isolated workers never receive the trusted policy or MCP configuration.
    // Host-side checks also gate bridged calls and background output.
    checkTool = hostPolicy
      ? (tool, input) => requestHost('checkTool', { tool, input })
      : await loadCodePolicy(process.cwd(), sessionId, mode, policy);
    holdOutput = background && checkTool.hasOutputHooks;
    await checkTool('REPL', { code });
    const tools = {
      // Each helper executes the input the permission check returned: when
      // a hook replaced it, that replacement is what runs, is recorded and
      // was shown in any approval.
      read: async file => { const absolute = path.resolve(file); const { input, context } = await checkTool('Read', { file_path: absolute }); noteContext(context); if (typeof input?.file_path !== 'string' || !input.file_path) throw new Error('updated Read input must carry a file_path'); const content = await readFile(input.file_path, 'utf8'); if (content.length > 1024 * 1024) throw new Error('file exceeds 1 MiB'); record('read', { file: input.file_path }); return content; },
      write: async (file, content) => { if (typeof content !== 'string') throw new Error('content must be a string'); const absolute = path.resolve(file); const { input, context } = await checkTool('Write', { file_path: absolute, content }); noteContext(context); if (typeof input?.file_path !== 'string' || !input.file_path || typeof input.content !== 'string') throw new Error('updated Write input must carry file_path and content'); // Missing parent directories are created after the permission check: a
      // denied write must not leave a directory tree behind.
      await mkdir(path.dirname(input.file_path), { recursive: true }); await writeFile(input.file_path, input.content, 'utf8'); record('write', { file: input.file_path, bytes: Buffer.byteLength(input.content) }); return { file: input.file_path, bytes: Buffer.byteLength(input.content) }; },
      edit: async (file, oldText, newText) => {
        if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') throw new Error('edit requires a nonempty oldText and string newText');
        const absolute = path.resolve(file);
        const { input, context } = await checkTool('Edit', { file_path: absolute, old_string: oldText, new_string: newText });
        noteContext(context);
        if (typeof input?.file_path !== 'string' || !input.file_path || typeof input.old_string !== 'string' || !input.old_string || typeof input.new_string !== 'string') throw new Error('updated Edit input must carry file_path, old_string and new_string');
        const before = await readFile(input.file_path, 'utf8');
        const index = before.indexOf(input.old_string);
        if (index < 0 || before.indexOf(input.old_string, index + 1) !== -1) throw new Error('oldText must match exactly once');
        await writeFile(input.file_path, before.slice(0, index) + input.new_string + before.slice(index + input.old_string.length), 'utf8');
        record('edit', { file: input.file_path, oldText: input.old_string.slice(0, 2000), newText: input.new_string.slice(0, 2000), truncated: input.old_string.length > 2000 || input.new_string.length > 2000 });
        return { file: input.file_path, changed: input.old_string !== input.new_string };
      },
      run: async (...args) => { const result = await run(...args); record('run', { command: result.command.slice(0, 2000), exitCode: result.exitCode, timedOut: result.timedOut }); return result; },
      callMcp,
      listMcpServers,
      listMcpTools,
      log,
    };
    Object.assign(tools, { Read: tools.read, Write: tools.write, Edit: tools.edit, Bash: tools.run });
    const evaluated = await evaluateCode({ code, tools, state, timeoutMs });
    const value = evaluated.value;
    const stateJson = JSON.stringify(evaluated.state);
    if (typeof stateJson !== 'string' || Buffer.byteLength(stateJson) > 256 * 1024) throw new Error('state must be JSON serializable and at most 256 KiB');
    result = { ok: true, result: value === undefined ? null : cap(value), logs: cap(logs.join('\n')), operations, state: JSON.parse(stateJson) };
  } catch (error) {
    result = { ok: false, error: cap(error?.stack || String(error)), logs: cap(logs.join('\n')), operations };
  }
  try {
    // Forgotten timers must not add unchecked output while a hook is running.
    outputClosed = true;
    result = structuredClone(result);
    if (holdOutput) {
      try {
        const out = await checkTool.output({ result, events: heldEvents });
        noteContext(out?.context);
        for (const event of heldEvents) if (connected()) channelSend(event, () => {});
      } catch (error) {
        result = { ok: false, outputBlocked: true, error: `Code output blocked: ${error.message}` };
      }
    }
    if (contexts.length) result.additionalContext = contexts.join('\n\n');
    await sendFinal(result);
  } finally {
    // Do not let forgotten timers keep the worker alive.
    disconnect();
    process.exit();
  }
});
