import { spawn } from 'node:child_process';
import path from 'node:path';
import { withMcp } from './code-mode-mcp.mjs';

const LIMIT = 64 * 1024;

// Native hooks configuration adapter.
// Accepts the native matcher-group shape ({ matcher, hooks: [handler] })
// beside the project's flat shape ({ tool, ...handler }):
//   - matcher: '*' or exact tool names separated by | or , (regex matchers
//     are rejected, not interpreted);
//   - timeout is native and in SECONDS (converted to timeoutMs);
//   - mcp_tool handlers may use the native tool/input names;
//   - unsupported fields (if, async, shell, statusMessage, once,
//     allowedEnvVars, prompt/agent types, ...) are an explicit error,
//     never silently dropped.
// Returns the flat, normalized handler list.
function matcherTools(matcher, event) {
  const value = matcher === undefined || matcher === null || matcher === '' ? '*' : matcher;
  if (typeof value !== 'string') throw new Error(`Invalid ${event} hook matcher`);
  const tools = value.split(/[|,]/).map(part => part.trim()).filter(part => part.length > 0);
  if (tools.length === 0) tools.push('*');
  for (const tool of tools) {
    if (tool !== '*' && !/^[A-Za-z0-9_-]+$/.test(tool)) {
      throw new Error('Regex matchers are not supported; use exact tool names separated by |');
    }
  }
  return tools;
}

function normalizeHandler(raw, tool, event, native) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid ${event} hook`);
  const type = raw.type ?? 'command';
  if (!['command', 'http', 'mcp_tool'].includes(type)) throw new Error(`Unsupported ${event} hook type '${type}'`);
  const allowed = new Set(['type', 'tool', 'matcher', 'onFailure', 'timeoutMs', 'timeout']);
  if (type === 'command') for (const key of ['command', 'args']) allowed.add(key);
  if (type === 'http') for (const key of ['url', 'headers']) allowed.add(key);
  if (type === 'mcp_tool') for (const key of ['server', 'mcpTool', 'arguments', ...(native ? ['tool', 'input'] : [])]) allowed.add(key);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`Unsupported ${event} hook field '${key}'`);
  }
  let timeoutMs = raw.timeoutMs;
  if (raw.timeout !== undefined) {
    if (timeoutMs !== undefined) throw new Error('A hook cannot set both timeout (seconds) and timeoutMs (milliseconds)');
    if (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout)) throw new Error(`Invalid ${event} hook timeout`);
    timeoutMs = Math.round(raw.timeout * 1000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) throw new Error(`Invalid ${event} hook timeout`);
  }
  const handler = { ...raw };
  delete handler.timeout;
  delete handler.timeoutMs;
  delete handler.matcher;
  if (timeoutMs !== undefined) handler.timeoutMs = timeoutMs;
  if (type === 'mcp_tool') {
    // Native group form: a handler-level `tool` names the MCP tool the hook
    // invokes, so it conflicts with a different `mcpTool`. Flat (project)
    // form: `tool`/`matcher` names the tool the hook fires for; `tool` is
    // the invoked tool only when `mcpTool` is absent.
    let invoked = handler.mcpTool;
    if (handler.tool !== undefined) {
      if (native) {
        if (invoked !== undefined && invoked !== handler.tool) throw new Error('An MCP hook cannot set both tool and mcpTool');
        invoked = handler.tool;
      } else if (invoked === undefined) {
        invoked = handler.tool;
      }
      if (invoked === handler.tool) delete handler.tool;
    }
    if (invoked !== undefined) handler.mcpTool = invoked;
    let mcpArguments = handler.arguments;
    if (handler.input !== undefined) {
      if (mcpArguments !== undefined && JSON.stringify(mcpArguments) !== JSON.stringify(handler.input)) {
        throw new Error('An MCP hook cannot set both arguments and input');
      }
      mcpArguments = handler.input;
    }
    delete handler.input;
    if (mcpArguments !== undefined) handler.arguments = mcpArguments;
  } else {
    delete handler.tool;
  }
  handler.type = type;
  handler.tool = tool;
  return handler;
}

export function normalizeHooks(hooks, event) {
  if (hooks === undefined || hooks === null) return [];
  if (!Array.isArray(hooks)) throw new Error(`Invalid ${event} hooks`);
  const normalized = [];
  for (const entry of hooks) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Invalid ${event} hook`);
    if (Array.isArray(entry.hooks)) {
      for (const key of Object.keys(entry)) {
        if (!['matcher', 'hooks'].includes(key)) throw new Error(`Unsupported ${event} hook group field '${key}'`);
      }
      const tools = matcherTools(entry.matcher, event);
      for (const tool of tools) for (const raw of entry.hooks) normalized.push(normalizeHandler(raw, tool, event, true));
    } else {
      let tool = entry.tool;
      if (entry.matcher !== undefined) {
        if (tool !== undefined && tool !== entry.matcher) throw new Error('A hook cannot define different tool and matcher values');
        tool = entry.matcher;
      }
      if (event === 'PreToolUse' && tool === undefined) throw new Error('Invalid PreToolUse hook configuration');
      for (const t of matcherTools(tool, event)) normalized.push(normalizeHandler(entry, t, event, false));
    }
  }
  return normalized;
}

export function validateHooks(hooks, event) {
  const normalized = normalizeHooks(hooks, event);
  for (const hook of normalized) {
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
  return normalized;
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
      try { resolve(parseOutput(JSON.parse(stdout), event)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(event));
  });
}

// Official PreToolUse output contract. Supported fields are validated;
// unsupported fields are rejected explicitly instead of being ignored.
// 'defer' needs non-interactive -p mode and is not supported here.
function parseOutput(value, event) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hook JSON');
  const name = event.hook_event_name;
  for (const key of Object.keys(value)) {
    if (!['decision', 'reason', 'continue', 'stopReason', 'suppressOutput', 'hookSpecificOutput'].includes(key)) {
      throw new Error(`Unsupported ${name} hook output field '${key}'`);
    }
  }
  if (value.decision !== undefined && !['block', 'approve'].includes(value.decision)) throw new Error('Invalid hook decision');
  if (value.reason !== undefined && typeof value.reason !== 'string') throw new Error('Invalid hook reason');
  if (value.continue !== undefined && typeof value.continue !== 'boolean') throw new Error('Invalid hook continue');
  if (value.stopReason !== undefined && typeof value.stopReason !== 'string') throw new Error('Invalid hook stop reason');
  if (value.suppressOutput !== undefined && typeof value.suppressOutput !== 'boolean') throw new Error('Invalid hook suppressOutput');
  const hso = value.hookSpecificOutput;
  if (hso !== undefined) {
    if (!hso || typeof hso !== 'object' || Array.isArray(hso)) throw new Error('Invalid hookSpecificOutput');
    for (const key of Object.keys(hso)) {
      if (!['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'updatedInput', 'additionalContext'].includes(key)) {
        throw new Error(`Unsupported hookSpecificOutput field '${key}'`);
      }
    }
    if (hso.hookEventName !== undefined && hso.hookEventName !== name) throw new Error('Hook output hookEventName does not match the event');
    const decision = hso.permissionDecision;
    if (decision !== undefined && !['allow', 'deny', 'ask'].includes(decision)) throw new Error('Invalid hook permission decision');
    if (hso.permissionDecisionReason !== undefined && typeof hso.permissionDecisionReason !== 'string') throw new Error('Invalid permissionDecisionReason');
    if (hso.updatedInput !== undefined) {
      if (name !== 'PreToolUse') throw new Error('updatedInput is only supported for PreToolUse hooks');
      if (!hso.updatedInput || typeof hso.updatedInput !== 'object' || Array.isArray(hso.updatedInput)) throw new Error('Invalid updatedInput: must be a plain object');
    }
    if (hso.additionalContext !== undefined) {
      const contexts = Array.isArray(hso.additionalContext) ? hso.additionalContext : [hso.additionalContext];
      if (contexts.some(context => typeof context !== 'string')) throw new Error('Invalid additionalContext: must be a string or an array of strings');
    }
  }
  return value;
}

async function readResponse(response, event) {
  let body = '';
  for await (const chunk of response.body) {
    body += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(body) > LIMIT) throw new Error('Hook response exceeds output limit');
  }
  return body.trim() ? parseOutput(JSON.parse(body), event) : {};
}

export async function runHooks(hooks, event, externalSignal) {
  let ask = false;
  let allow = false;
  let updatedInput;
  const additionalContext = [];
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
        output = await readResponse(response, event);
      } else {
        const result = await withMcp(hook.server, client => client.callTool({ name: hook.mcpTool, arguments: { ...hook.arguments, ...event } }, undefined, { signal, timeout: hook.timeoutMs ?? 5000 }), signal);
        if (result.isError) throw new Error('MCP hook failed');
        const text = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
        if (Buffer.byteLength(text) > LIMIT) throw new Error('MCP hook output exceeds limit');
        output = parseOutput(result.structuredContent ?? (text.trim() ? JSON.parse(text) : {}), event);
      }
    } catch (error) {
      externalSignal?.throwIfAborted();
      if (hook.onFailure === 'continue') continue;
      throw new Error(`${event.hook_event_name} hook refused ${event.tool_name || 'code output'} or could not complete: ${error.message}`);
    }
    externalSignal?.throwIfAborted();
    if (output.decision === 'block' || output.continue === false || output.hookSpecificOutput?.permissionDecision === 'deny') {
      const reason = output.reason || output.stopReason || output.hookSpecificOutput?.permissionDecisionReason;
      throw new Error(`${event.hook_event_name} hook refused ${event.tool_name || 'code output'}${reason ? `: ${String(reason).slice(0, 2000)}` : ''}`);
    }
    // Hook decision precedence: deny throws above; ask and allow accumulate.
    const hso = output.hookSpecificOutput ?? {};
    if (output.decision === 'approve' || hso.permissionDecision === 'allow') allow = true;
    if (hso.permissionDecision === 'ask') ask = true;
    if (hso.updatedInput !== undefined) updatedInput = hso.updatedInput;
    const contexts = hso.additionalContext === undefined ? [] : (Array.isArray(hso.additionalContext) ? hso.additionalContext : [hso.additionalContext]);
    for (const context of contexts) {
      if (Buffer.byteLength(JSON.stringify(additionalContext)) + context.length > LIMIT) throw new Error('Hook additionalContext exceeds output limit');
      additionalContext.push(context);
    }
    // A later hook sees the input the earlier hook returned.
    if (hso.updatedInput !== undefined) event = { ...event, tool_input: updatedInput };
  }
  return { ask, allow, updatedInput, additionalContext };
}
