import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHooks, validateHooks } from './code-mode-hooks.mjs';
import { send as channelSend, onMessage } from './code-mode-channel.mjs';

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

export function policyCheck(policy, cwd, sessionId, mode) {
  const { deny = [], ask = [], preToolUse = [], userPromptSubmit = [] } = policy;
  for (const rules of [deny, ask]) {
    if (!Array.isArray(rules) || rules.some(rule => typeof rule !== 'string' || !rule)) {
      throw new Error('Code Mode rules must be arrays of tool names');
    }
  }
  validateHooks(preToolUse, 'PreToolUse');
  validateHooks(userPromptSubmit, 'UserPromptSubmit');

  const check = async (tool, input) => {
    const event = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd, session_id: sessionId };
    if (deny.includes(tool)) throw new Error(`Code Mode policy denied ${tool}`);
    const edit = tool === 'Edit' || tool === 'Write';
    const readOnly = tool === 'REPL' || tool === 'Read';
    if (mode === 'plan' && !readOnly) throw new Error(`Code Mode plan mode denied ${tool}`);
    const hookDecision = await runHooks(preToolUse, event);
    const approvalRequired = hookDecision.ask || ask.includes(tool) || (!readOnly && (mode === 'default' || (mode === 'acceptEdits' && !edit)));
    if (approvalRequired) {
      await requestDecision('approve', event);
    }
    if (mode === 'auto' && tool === 'REPL') await requestDecision('classify', event);
    if (mode === 'auto' && !readOnly && !approvalRequired) await requestDecision('autoTool', event);
  };
  check.hasOutputHooks = userPromptSubmit.length > 0;
  check.output = output => runHooks(userPromptSubmit, { hook_event_name: 'UserPromptSubmit', source: 'poll_event', cwd, session_id: sessionId, prompt: JSON.stringify(output) });
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
