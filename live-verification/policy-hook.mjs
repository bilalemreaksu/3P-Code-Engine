import path from 'node:path';
import { fileURLToPath } from 'node:url';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
const directory = path.dirname(fileURLToPath(import.meta.url));
const file = event.tool_input?.file_path;
let result = {};
if (event.hook_event_name === 'PreToolUse' && file && path.dirname(file) === directory) {
  const name = path.basename(file);
  if (name === 'desktop-denied.txt') result = { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'DESKTOP_HOOK_DENY_PASS' } };
  if (name === 'desktop-approved.txt') result = { hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'Live check: create only desktop-approved.txt' } };
}
if (event.hook_event_name === 'UserPromptSubmit' && event.source === 'poll_event' && event.cwd === directory && event.prompt.includes('DESKTOP_WITHHELD_MARKER')) {
  result = { decision: 'block', reason: 'DESKTOP_OUTPUT_HOOK_PASS' };
}
console.log(JSON.stringify(result));
