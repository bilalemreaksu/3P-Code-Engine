import { spawn } from 'node:child_process';
import path from 'node:path';
import { withMcp } from './code-mode-mcp.mjs';

const LIMIT = 64 * 1024;
export function validateHooks(hooks, event) {
  if (!Array.isArray(hooks)) throw new Error(`Invalid ${event} hooks`);
  for (const hook of hooks) {
    if (!hook || typeof hook !== 'object' || Array.isArray(hook)) throw new Error(`Invalid ${event} hook`);
    const type = hook.type || 'command';
    if (!['command', 'http', 'mcp_tool'].includes(type) ||
        (hook.onFailure !== undefined && !['continue', 'block'].includes(hook.onFailure)) ||
        (hook.timeoutMs !== undefined && (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs < 100 || hook.timeoutMs > 600000)) ||
        (event === 'PreToolUse' && typeof hook.tool !== 'string')) throw new Error(`Invalid ${event} hook configuration`);
    if (type === 'command' && (typeof hook.command !== 'string' || !path.isAbsolute(hook.command) ||
        !Array.isArray(hook.args ?? []) || (hook.args ?? []).some(arg => typeof arg !== 'string'))) throw new Error('Invalid command hook configuration');
    if (type === 'http') {
      let url;
      try { url = new URL(hook.url); } catch { throw new Error('Invalid HTTP hook URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid HTTP hook URL');
      if (hook.headers !== undefined && (!hook.headers || typeof hook.headers !== 'object' || Array.isArray(hook.headers) || Object.values(hook.headers).some(v => typeof v !== 'string'))) throw new Error('Invalid HTTP hook headers');
    }
    if (type === 'mcp_tool' && (typeof hook.server !== 'string' || typeof hook.mcpTool !== 'string' ||
        (hook.arguments !== undefined && (!hook.arguments || typeof hook.arguments !== 'object' || Array.isArray(hook.arguments))))) throw new Error('Invalid MCP hook configuration');
  }
}

function commandHook(hook, event, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(hook.command, hook.args ?? [], { cwd: event.cwd, windowsHide: true, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exceeded = false;
    const append = (name, chunk) => {
      const text = chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(text) > LIMIT) {
        exceeded = true; child.kill(); return;
      }
      if (name === 'stdout') stdout += text; else stderr += text;
    };
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
    child.once('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.once('close', (code, exitSignal) => {
      if (exceeded || exitSignal || code === null || code === 126 || code === 127 || code > 128) return reject(new Error('Hook failed or exceeded output limit'));
      if (code === 2) return resolve({ decision: 'block', reason: stderr.trim().slice(0, 2000) || 'Hook exited with code 2' });
      if (code !== 0) {
        if (hook.onFailure === 'block') return reject(new Error(`Hook exited with code ${code}`));
        return resolve({});
      }
      if (!stdout.trim()) return resolve({});
      try { resolve(parseOutput(JSON.parse(stdout))); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(event));
  });
}

function parseOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hook JSON');
  if (value.decision !== undefined && !['block', 'approve'].includes(value.decision)) throw new Error('Invalid hook decision');
  const decision = value.hookSpecificOutput?.permissionDecision;
  if (decision !== undefined && !['allow', 'deny', 'ask'].includes(decision)) throw new Error('Invalid hook permission decision');
  return value;
}

async function readResponse(response) {
  let body = '';
  for await (const chunk of response.body) {
    body += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(body) > LIMIT) throw new Error('Hook response exceeds output limit');
  }
  return body.trim() ? parseOutput(JSON.parse(body)) : {};
}

export async function runHooks(hooks, event, externalSignal) {
  let ask = false;
  for (const hook of hooks) {
    externalSignal?.throwIfAborted();
    if (event.hook_event_name === 'PreToolUse' && hook.tool !== '*' && hook.tool !== event.tool_name) continue;
    const timeout = AbortSignal.timeout(hook.timeoutMs ?? 5000);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    let output;
    try {
      const type = hook.type || 'command';
      if (type === 'command') output = await commandHook(hook, event, signal);
      else if (type === 'http') {
        const response = await fetch(hook.url, { method: 'POST', headers: { ...hook.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(event), signal, redirect: 'error' });
        if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP hook failed'); }
        output = await readResponse(response);
      } else {
        const result = await withMcp(hook.server, client => client.callTool({ name: hook.mcpTool, arguments: { ...hook.arguments, ...event } }, undefined, { signal, timeout: hook.timeoutMs ?? 5000 }), signal);
        if (result.isError) throw new Error('MCP hook failed');
        const text = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
        if (Buffer.byteLength(text) > LIMIT) throw new Error('MCP hook output exceeds limit');
        output = parseOutput(result.structuredContent ?? (text.trim() ? JSON.parse(text) : {}));
      }
    } catch {
      externalSignal?.throwIfAborted();
      if (hook.onFailure === 'continue') continue;
      throw new Error(`${event.hook_event_name} hook refused ${event.tool_name || 'code output'} or could not complete`);
    }
    externalSignal?.throwIfAborted();
    if (output.decision === 'block' || output.continue === false || output.hookSpecificOutput?.permissionDecision === 'deny') {
      const reason = output.reason || output.stopReason || output.hookSpecificOutput?.permissionDecisionReason;
      throw new Error(`${event.hook_event_name} hook refused ${event.tool_name || 'code output'}${reason ? `: ${String(reason).slice(0, 2000)}` : ''}`);
    }
    if (output.hookSpecificOutput?.permissionDecision === 'ask') ask = true;
  }
  return { ask };
}
