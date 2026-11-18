import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHooks, validateHooks } from './code-mode-hooks.mjs';
import { send as channelSend, onMessage } from './code-mode-channel.mjs';
import { matchesRule, commandIsReadOnly } from './code-mode-rules.mjs';

const permissionModes = ['rules', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export function getPermissionMode() {
  const mode = process.env.CODE_MODE_PERMISSION_MODE || 'rules';
  if (!permissionModes.includes(mode)) throw new Error('Invalid CODE_MODE_PERMISSION_MODE');
  return mode;
}

const decisions = new Map();
onMessage(message => {
  if (decisions.has(message?.decisionId)) decisions.get(message.decisionId)(message);
});

function requestDecision(kind, event) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    decisions.set(id, message => {
      decisions.delete(id);
      if (message.allowed === true) resolve();
      else reject(new Error(message.error || 'Code Mode permission denied'));
    });
    channelSend({ decisionId: id, kind, event }, error => {
      if (!error) return;
      decisions.delete(id);
      reject(error);
    });
  });
}

const RULE_RE = /^([^()]+)(?:\((.*)\))?$/s;

// Allow rules may only name tools or wildcard the tool name inside a literal
// `mcp__server__` prefix (native does not accept allow `*`).
function validateAllow(allow) {
  for (const rule of allow) {
    const parsed = RULE_RE.exec(rule);
    if (!parsed) continue; // the generic rule-shape check already reported it
    const name = parsed[1];
    if (name.includes('*') && !/^mcp__[^*]+__/.test(name)) {
      throw new Error('Allow rules may only use tool-name wildcards after a literal mcp__server__ prefix');
    }
  }
}

export function policyCheck(policy, cwd, sessionId, mode, decide = requestDecision, signal) {
  const { deny = [], ask = [], allow = [], preToolUse = [], userPromptSubmit = [] } = policy;
  for (const [listName, rules] of [['deny', deny], ['ask', ask], ['allow', allow]]) {
    if (!Array.isArray(rules) || rules.some(rule => typeof rule !== 'string' || !RULE_RE.test(rule))) {
      throw new Error(`Code Mode ${listName} rules must be arrays of tool names`);
    }
    // File-pattern negation is not implemented; reject it instead of
    // silently reinterpreting the pattern.
    for (const rule of rules) {
      const parsed = RULE_RE.exec(rule);
      if (parsed && /^(read|edit|write)$/i.test(parsed[1].trim()) && (parsed[2] ?? '').startsWith('!')) {
        throw new Error(`Code Mode ${listName} rules: negation (!) patterns are not supported`);
      }
    }
  }
  validateAllow(allow);
  validateHooks(preToolUse, 'PreToolUse');
  validateHooks(userPromptSubmit, 'UserPromptSubmit');

  const check = async (tool, input) => {
    signal?.throwIfAborted();
    const event = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd, session_id: sessionId };
    // Deny first: it blocks in every mode, including bypassPermissions.
    if (deny.some(rule => matchesRule(rule, tool, input, cwd, 'deny'))) throw new Error(`Code Mode policy denied ${tool}`);
    const edit = tool === 'Edit' || tool === 'Write';
    // Documented read-only set: the worker REPL and Read never prompt; a
    // Bash/PowerShell command that is entirely read-only does not either.
    const readOnly = tool === 'REPL' || tool === 'Read' || (tool === 'Bash' && commandIsReadOnly(input?.command ?? '', cwd));
    if (mode === 'plan' && !readOnly) throw new Error(`Code Mode plan mode denied ${tool}`);
    const hookDecision = await runHooks(preToolUse, event, signal);
    // An ask rule (or a hook that asks) forces a prompt that allow cannot
    // override; an allow rule pre-approves the action the mode baseline
    // would prompt for.
    const askRule = ask.some(rule => matchesRule(rule, tool, input, cwd, 'ask'));
    const covered = allow.some(rule => matchesRule(rule, tool, input, cwd, 'allow'));
    const modeBaseline = !readOnly && (mode === 'default' || (mode === 'acceptEdits' && !edit));
    if (hookDecision.ask || askRule || (!covered && modeBaseline)) await decide('approve', event);
    if (mode === 'auto' && tool === 'REPL') await decide('classify', event);
    if (mode === 'auto' && !readOnly && !hookDecision.ask && !askRule && !modeBaseline && !covered) await decide('autoTool', event);
  };
  check.hasOutputHooks = userPromptSubmit.length > 0;
  check.output = output => runHooks(userPromptSubmit, { hook_event_name: 'UserPromptSubmit', source: 'poll_event', cwd, session_id: sessionId, prompt: JSON.stringify(output) }, signal);
  return check;
}

// Reads the policy file (CODE_MODE_POLICY_PATH or the bundled default).
// In isolated mode the server loads the file on the host and passes the
// parsed policy through the initial worker message instead.
export async function loadCodePolicy(cwd, sessionId, mode, inlinePolicy) {
  if (inlinePolicy !== undefined) return policyCheck(inlinePolicy, cwd, sessionId, mode);
  const policyPath = process.env.CODE_MODE_POLICY_PATH || fileURLToPath(new URL('./code-mode-policy.json', import.meta.url));
  if (policyPath && !path.isAbsolute(policyPath)) throw new Error('CODE_MODE_POLICY_PATH must be absolute');
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  return policyCheck(policy, cwd, sessionId, mode);
}
