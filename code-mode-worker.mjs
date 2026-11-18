import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { inspect } from 'node:util';
import { loadCodePolicy } from './code-mode-policy.mjs';
import { mcpDefinitions, withMcp } from './code-mode-mcp.mjs';

// This process runs trusted generated code with the user's operating-system
// privileges. AsyncFunction is an execution mechanism, NOT a sandbox.
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
let holdOutput = false;
let outputClosed = false;
const heldEvents = [];
const progress = (kind, data) => {
  if (!process.connected || outputClosed) return;
  const input = String(data);
  const value = input.slice(0, Math.min(4096, Math.max(0, OUTPUT_LIMIT - progressChars)));
  progressChars += value.length;
  try {
    const send = event => { if (holdOutput) heldEvents.push(event); else process.send(event, () => {}); };
    if (value) send({ __codeModeProgress: true, kind, data: value });
    if (value.length < input.length && !progressTruncated) {
      progressTruncated = true;
      send({ __codeModeProgress: true, kind: 'limit', data: 'Live output truncated.' });
    }
  } catch { /* parent may disconnect */ }
};
const sendFinal = result => new Promise(resolve => { if (!process.connected) return resolve(); try { process.send(result, () => resolve()); } catch { resolve(); } });
const record = (operation, details) => { if (operations.length < 100) { operations.push({ operation, ...details }); progress('operation', JSON.stringify({ operation, ...details })); } };
const log = (...args) => { if (logs.length < 100) { const value = cap(args.map(a => cap(a)).join(' ')); logs.push(value); progress('log', value); } };

async function listMcpServers() { return Object.keys(await mcpDefinitions()); }
async function listMcpTools(serverName) {
  if (typeof serverName !== 'string') throw new Error('Invalid MCP server name');
  await checkTool('McpListTools', { server: serverName });
  return withMcp(serverName, client => client.listTools());
}
async function callMcp(serverName, toolName, args = {}) {
  if (typeof toolName !== 'string') throw new Error('Invalid MCP tool name');
  const argumentsSnapshot = JSON.parse(JSON.stringify(args));
  await checkTool(`mcp__${serverName}__${toolName}`, argumentsSnapshot);
  return withMcp(serverName, async client => {
    const result = await client.callTool({ name: toolName, arguments: argumentsSnapshot });
    record('mcp', { server: serverName, tool: toolName, isError: !!result.isError });
    return result;
  });
}

async function run(command, { cwd = '.', timeoutMs = 60000 } = {}) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('command must be a nonempty string');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 7200000) throw new Error('timeoutMs must be 100..7200000');
  const directory = path.resolve(cwd);
  await checkTool('Bash', { command, cwd: directory, timeout: timeoutMs });
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
      : ['-c', command], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); resolve({ command, exitCode, signal, timedOut, truncated, stdout, stderr }); });
  });
}

// Each interpolated value is one shell argument, not a shell fragment.
const quoteArgument = value => process.platform === 'win32'
  ? `'${String(value).replace(/'/g, "''")}'`
  : `'${String(value).replace(/'/g, "'\\''")}'`;
function $(strings, ...values) {
  const command = strings.reduce((out, part, i) => out + part + (i < values.length ? quoteArgument(values[i]) : ''), '');
  const promise = run(command).then(result => { record('run', { command: command.slice(0, 2000), exitCode: result.exitCode, timedOut: result.timedOut }); return result; });
  const checked = () => promise.then(result => { if (result.exitCode !== 0 || result.timedOut) throw new Error(`Command failed (${result.exitCode}): ${result.stderr}`); return result; });
  return { text: () => checked().then(result => result.stdout), nothrow: () => promise, then: (resolve, reject) => checked().then(resolve, reject) };
}

function prepareCode(code, names) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const trimmed = code.trim().replace(/;\s*$/, '');
  const compile = body => new AsyncFunction(...names, body);
  try { return compile(`return (\n${trimmed}\n);`); } catch { /* multiple statements */ }
  // A syntactically valid prefix and a final expression after an explicit
  // semicolon cover the documented example without guessing line boundaries.
  for (let index = trimmed.lastIndexOf(';'); index >= 0; index = trimmed.lastIndexOf(';', index - 1)) {
    const prefix = trimmed.slice(0, index + 1), tail = trimmed.slice(index + 1).trim();
    if (!tail) continue;
    try { compile(prefix); compile(`return (\n${tail}\n);`); return compile(`${prefix}\nreturn (\n${tail}\n);`); } catch { /* next boundary */ }
  }
  return compile(code);
}

async function settleNested(value, seen = new WeakSet(), depth = 0) {
  value = await value;
  if (!value || typeof value !== 'object' || depth >= 6 || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const entries = await Promise.all(Object.entries(value).slice(0, 100).map(async ([key, item]) => [key, await settleNested(item, seen, depth + 1)]));
  return Array.isArray(value) ? entries.map(([, item]) => item) : Object.fromEntries(entries);
}

process.once('message', async ({ code, cwd, sessionId, mode, background = false, state = {} }) => {
  let result;
  try {
    process.chdir(await realpath(cwd));
    if (!(await stat('.')).isDirectory()) throw new Error('cwd must be a directory');
    checkTool = await loadCodePolicy(process.cwd(), sessionId, mode);
    holdOutput = background && checkTool.hasOutputHooks;
    await checkTool('REPL', { code });
    const tools = {
      read: async file => { const absolute = path.resolve(file); await checkTool('Read', { file_path: absolute }); const content = await readFile(absolute, 'utf8'); if (content.length > 1024 * 1024) throw new Error('file exceeds 1 MiB'); record('read', { file: absolute }); return content; },
      write: async (file, content) => { if (typeof content !== 'string') throw new Error('content must be a string'); const absolute = path.resolve(file); await checkTool('Write', { file_path: absolute, content }); await writeFile(absolute, content, 'utf8'); record('write', { file: absolute, bytes: Buffer.byteLength(content) }); return { file: absolute, bytes: Buffer.byteLength(content) }; },
      edit: async (file, oldText, newText) => {
        if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') throw new Error('edit requires a nonempty oldText and string newText');
        const absolute = path.resolve(file);
        await checkTool('Edit', { file_path: absolute, old_string: oldText, new_string: newText });
        const before = await readFile(absolute, 'utf8');
        const index = before.indexOf(oldText);
        if (index < 0 || before.indexOf(oldText, index + 1) !== -1) throw new Error('oldText must match exactly once');
        await writeFile(absolute, before.slice(0, index) + newText + before.slice(index + oldText.length), 'utf8');
        record('edit', { file: absolute, oldText: oldText.slice(0, 2000), newText: newText.slice(0, 2000), truncated: oldText.length > 2000 || newText.length > 2000 });
        return { file: absolute, changed: oldText !== newText };
      },
      run: async (...args) => { const result = await run(...args); record('run', { command: args[0].slice(0, 2000), exitCode: result.exitCode, timedOut: result.timedOut }); return result; },
      callMcp,
      listMcpServers,
      listMcpTools,
      log,
    };
    Object.assign(tools, { Read: tools.read, Write: tools.write, Edit: tools.edit, Bash: tools.run });
    const names = ['tools', 'read', 'write', 'edit', 'run', 'log', 'state', 'callMcp', '$', 'listMcpServers', 'listMcpTools'];
    const value = await settleNested(await prepareCode(code, names)(tools, tools.read, tools.write, tools.edit, tools.run, log, state, callMcp, $, listMcpServers, listMcpTools));
    const stateJson = JSON.stringify(state);
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
        await checkTool.output({ result, events: heldEvents });
        for (const event of heldEvents) if (process.connected) process.send(event, () => {});
      } catch (error) {
        result = { ok: false, outputBlocked: true, error: `Code output blocked: ${error.message}` };
      }
    }
    await sendFinal(result);
  } finally {
    // Do not let forgotten timers keep the worker alive.
    if (process.connected) process.disconnect();
    process.exit();
  }
});
