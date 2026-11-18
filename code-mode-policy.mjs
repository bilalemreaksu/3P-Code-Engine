import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHooks, validateHooks } from './code-mode-hooks.mjs';
import { send as channelSend, onMessage } from './code-mode-channel.mjs';
import { matchesRule, commandIsReadOnly } from './code-mode-rules.mjs';

export const permissionModes = ['rules', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export const backgroundModes = ['rules', 'auto', 'bypassPermissions'];
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
  const raw = policy ?? {};
  // Native hooks configuration: policy.hooks = { PreToolUse: [...],
  // UserPromptSubmit: [...] } with matcher groups inside. It cannot be
  // combined with the flat keys; unknown keys are an explicit error.
  let pre = raw.preToolUse;
  let post = raw.userPromptSubmit;
  if (raw.hooks !== undefined) {
    if (!raw.hooks || typeof raw.hooks !== 'object' || Array.isArray(raw.hooks) ||
        Object.keys(raw.hooks).some(key => !['PreToolUse', 'UserPromptSubmit'].includes(key))) {
      throw new Error('Invalid policy hooks object: only PreToolUse and UserPromptSubmit are supported');
    }
    if (pre !== undefined || post !== undefined) {
      throw new Error('Use either the policy.hooks object or the preToolUse/userPromptSubmit keys, not both');
    }
    pre = raw.hooks.PreToolUse ?? [];
    post = raw.hooks.UserPromptSubmit ?? [];
  }
  const { deny = [], ask = [], allow = [] } = raw;
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
  const preToolUse = validateHooks(pre, 'PreToolUse');
  const userPromptSubmit = validateHooks(post, 'UserPromptSubmit');

  const check = async (tool, input) => {
    signal?.throwIfAborted();
    const event = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd, session_id: sessionId };
    // Deny first (against the submitted input): it blocks in every mode,
    // including bypassPermissions.
    if (deny.some(rule => matchesRule(rule, tool, input, cwd, 'deny'))) throw new Error(`Code Mode policy denied ${tool}`);
    // Hooks run before the mode checks: they can block in every mode
    // (including plan) and return the input the call continues with.
    const hookDecision = await runHooks(preToolUse, event, signal);
    let checked = input;
    let changed = false;
    if (hookDecision.updatedInput !== undefined) {
      // The executed code is what was submitted and classified; a hook
      // cannot substitute it.
      if (tool === 'REPL') throw new Error('Code Mode hooks cannot update the executed code (REPL input)');
      checked = hookDecision.updatedInput;
      changed = true;
      event.tool_input = checked;
    }
    // Permission rules are evaluated against the input the hook returned,
    // not the input the caller sent.
    if (changed && deny.some(rule => matchesRule(rule, tool, checked, cwd, 'deny'))) throw new Error(`Code Mode policy denied ${tool}`);
    const edit = tool === 'Edit' || tool === 'Write';
    // Documented read-only set: the worker REPL and Read never prompt; a
    // Bash/PowerShell command that is entirely read-only does not either.
    const readOnly = tool === 'REPL' || tool === 'Read' || (tool === 'Bash' && commandIsReadOnly(checked?.command ?? '', cwd));
    // A hook allow cannot lift the plan restriction: plan auto-approves
    // only read-only actions, and the restriction applies to what runs.
    if (mode === 'plan' && !readOnly) throw new Error(`Code Mode plan mode denied ${tool}`);
    // An ask rule (or a hook that asks) forces a prompt that allow cannot
    // override; a hook allow or an allow rule pre-approves the action the
    // mode baseline would prompt for.
    const askRule = ask.some(rule => matchesRule(rule, tool, checked, cwd, 'ask'));
    const covered = hookDecision.allow || allow.some(rule => matchesRule(rule, tool, checked, cwd, 'allow'));
    const modeBaseline = !readOnly && (mode === 'default' || (mode === 'acceptEdits' && !edit));
    if (hookDecision.ask || askRule || (!covered && modeBaseline)) await decide('approve', event);
    if (mode === 'auto' && tool === 'REPL') await decide('classify', event);
    // Auto: the classifier reviewed the submitted code. A hook-changed
    // input is not covered by that review and gets a fresh decision.
    if (mode === 'auto' && !readOnly && !hookDecision.ask && !askRule && !modeBaseline && (!covered || changed)) {
      await decide('autoTool', { ...event, inputChangedByHook: changed });
    }
    return { input: checked, context: hookDecision.additionalContext };
  };
  check.hasOutputHooks = userPromptSubmit.length > 0;
  check.output = async output => {
    const decision = await runHooks(userPromptSubmit, { hook_event_name: 'UserPromptSubmit', source: 'poll_event', cwd, session_id: sessionId, prompt: JSON.stringify(output) }, signal);
    return { context: decision.additionalContext };
  };
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
