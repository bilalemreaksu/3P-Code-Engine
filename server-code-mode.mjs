import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { formatRecord } from './code-mode-transcript.mjs';
import { getPermissionMode } from './code-mode-policy.mjs';
import { openAIModel, reviewChange } from './review-engine.mjs';
import { runReviewCycle } from './review-cycle.mjs';
import { dataDir, startExecution, getJob, cancelJob, deleteJob, deleteSession, resumeSession, spawnDocker } from './execution-manager.mjs';
import { isolationSnapshot } from './approval-client.mjs';
import { classifyCode } from './code-mode-classifier.mjs';

const server = new McpServer({ name: '3p-code-mode', version: '0.12.0' }, {instructions:'Use code_execute for coding work: group related file, shell and MCP calls in JavaScript, use Promise.all for independent calls, and return only needed output. Use code_start for long-running tasks and code_status for results. JavaScript runs in QuickJS: Node.js globals, dynamic imports and direct network access are unavailable. All OS operations use the checked helpers. Default autoApprove runs without a classifier or human approval prompts; explicit deny rules and blocking hooks still apply. Other explicitly configured permission modes may require human approvals. Desktop clients decide whether to follow these instructions. The bundled terminal agent exposes only Code Mode tools.'});

// Record what the connecting MCP client actually supports. This is the
// evidence for compatibility decisions: older code assumed clients offered
// form elicitation; real clients (e.g. Claude Desktop 3P) do not, so
// approvals moved to the local approval broker (approval-broker.mjs).
server.server.oninitialized = () => {
  const record = {
    ts: new Date().toISOString(),
    clientInfo: server.server.getClientVersion ? server.server.getClientVersion() : undefined,
    capabilities: server.server.getClientCapabilities() ?? null,
  };
  void mkdir(dataDir, { recursive: true, mode: 0o700 }).then(async () => {
    // The isolation flag is only real if a docker engine actually answers.
    let dockerAvailable = null;
    if ((process.env.CODE_MODE_ISOLATION || 'off').toLowerCase() === 'docker') {
      dockerAvailable = await new Promise(resolve => {
        const child = spawnDocker(['version', '--format', '{{.Server.Version}}'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => { child.kill(); resolve(false); }, 4000);
        child.stdout.on('data', d => { out += d; });
        child.on('error', () => { clearTimeout(timer); resolve(false); });
        child.on('close', code => { clearTimeout(timer); resolve(code === 0 && out.trim().length > 0); });
      });
    }
    await appendFile(path.join(dataDir, 'client-capabilities.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
    await writeFile(path.join(dataDir, 'isolation.json'), JSON.stringify({ ts: record.ts, ...isolationSnapshot(dockerAvailable) }, null, 2), 'utf8');
  }).catch(() => {});
};
async function decide(kind, event, signal) {
  if (kind === 'classify') return classifyCode(event, signal);
  // Unreachable in practice: the execution manager routes 'approve' requests
  // to the local approval broker (queueApproval) — a human answers in the
  // broker UI and no MCP tool can grant an approval. Fail closed if this
  // invariant ever changes.
  throw new Error(`Code Mode policy requires interactive approval for ${event.tool_name}`);
}
const description = `Execute JavaScript in an isolated QuickJS WASM heap. Node.js globals, imports and direct network access are unavailable. Every OS/MCP operation uses checked helpers. With CODE_MODE_ISOLATION=docker shell/file helpers run in a container; configured MCP tools and policy hooks run on the host through a checked bridge. Without Docker, permitted shell commands run with the current user's OS permissions. cwd is the absolute project directory, passed as this tool's cwd argument: required for a new session (do not define cwd inside the code); omit it only when sessionId continues an existing session. Async APIs: read(file), write(file,text), edit(file,oldText,newText), run(command,{cwd,timeoutMs}), listMcpServers(), listMcpTools(server), callMcp(server,tool,args), log(...values), and tagged $ commands with .text()/.nothrow(). Return explicitly or end with an expression. Optional sessionId persists explicit JSON state; normal variables are not retained. Default autoApprove executes without classifier calls, approval queues or human prompts. Deny rules and blocking hooks still apply. Recorded operations cover helpers; shell programs' internal actions are not individually recorded.`;

server.registerTool('code_execute', {
  description,
  inputSchema: { cwd: z.string().min(1).max(2000).optional(), code: z.string().min(1).max(65536), timeoutMs: z.number().int().min(1000).max(600000).default(600000), sessionId: z.string().min(1).max(100).optional(), reviewAfter: z.object({ base: z.string().default('HEAD'), intent: z.string().max(5000).default(''), mode: z.enum(['quick','standard','deep']).default('standard'), autoChecks: z.boolean().default(false), checkCommands: z.array(z.string()).max(5).default([]) }).optional() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, async ({ cwd, code, timeoutMs, reviewAfter, sessionId }, extra) => {
  let result;
  try {
    if (reviewAfter && !['rules', 'bypassPermissions', 'autoApprove'].includes(getPermissionMode())) {
      throw new Error('reviewAfter runs outside Code Mode permissions and is unavailable in this permission mode');
    }
    const job = await startExecution({ cwd, code, timeoutMs, sessionId, source: 'mcp',
      decide: (kind, event, signal) => decide(kind, event, AbortSignal.any([signal, extra.signal])) });
    const cancel = () => cancelJob(job.id);
    extra.signal.addEventListener('abort', cancel, { once: true });
    if (extra.signal.aborted) cancel();
    try { result = await job.promise; }
    finally { extra.signal.removeEventListener('abort', cancel); }
  }
  catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
  if (result.ok && reviewAfter) {
    try {
      const modelCall = openAIModel({ endpoint: process.env.REVIEW_MODEL_ENDPOINT, model: process.env.REVIEW_MODEL_NAME, apiKey: process.env.REVIEW_MODEL_API_KEY });
      result.review = await reviewChange({ cwd: cwd ?? resumeSession(sessionId).cwd, modelCall, ...reviewAfter });
    } catch (e) { result.review = { status: 'failed', error: e.message }; }
  }
  return { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(result) }, { type: 'text', text: formatRecord(result) }] };
});

const response = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }, ...(formatRecord(value?.result) ? [{ type: 'text', text: formatRecord(value.result) }] : [])] });
const jobError = e => ({ isError: true, content: [{ type: 'text', text: e.message }] });
server.registerTool('code_start', {
  description: "Start background JavaScript in QuickJS. cwd is the absolute project directory, passed as this tool's cwd argument: required for a new session (do not define cwd inside the code); omit it only when sessionId continues an existing session. Supported modes: autoApprove (default, no classifier or human prompts), rules, auto and bypassPermissions. Node.js globals/imports are unavailable. All OS/MCP operations use checked helpers; Docker additionally isolates file/shell operations. Without Docker, permitted shell programs have the host account's OS permissions. Use code_status to inspect progress. Output hooks may withhold output until completion. Completed results and explicit JSON state persist; running jobs do not resume after restart.",
  inputSchema: { cwd: z.string().min(1).max(2000).optional(), code: z.string().min(1).max(65536), timeoutMs: z.number().int().min(1000).max(7200000).default(7200000), sessionId: z.string().min(1).max(100).optional() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, async args => {
  try {
    const job = await startExecution({ ...args, background: true, source: 'mcp', decide });
    return response(getJob(job.id));
  } catch (e) { return jobError(e); }
});
server.registerTool('code_session_resume', {
  description: 'Open saved session metadata and recent transcript job IDs. Continue with code_execute and the same sessionId.',
  inputSchema: { sessionId: z.string().min(1).max(100) },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ sessionId }) => { try { return response(resumeSession(sessionId)); } catch (e) { return jobError(e); } });
server.registerTool('code_status', {
  description: 'Poll a background job for output and helper events. Pass afterSequence for new events. Output is bounded and may be withheld by hooks. Default autoApprove has no pending approvals. In explicitly configured interactive modes, pendingApprovals contains URLs for the human.',
  inputSchema: { jobId: z.string().uuid(), afterSequence: z.number().int().min(0).default(0) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ jobId, afterSequence }) => {
  try { return response(getJob(jobId, afterSequence)); } catch (e) { return jobError(e); }
});
server.registerTool('code_cancel', {
  description: 'Cancel a background code job. Detached child processes may survive.',
  inputSchema: { jobId: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
}, async ({ jobId }) => { try { return response(cancelJob(jobId)); } catch (e) { return jobError(e); } });
server.registerTool('code_job_delete', {
  description: 'Delete the stored result, transcript and events for a finished job. This does not undo file changes or terminate an interrupted process.',
  inputSchema: { jobId: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
}, async ({ jobId }) => { try { return response({ deleted: deleteJob(jobId) }); } catch (e) { return jobError(e); } });
server.registerTool('code_session_delete', {
  description: 'Clear explicitly saved JSON state for an idle execution session.',
  inputSchema: { sessionId: z.string().min(1).max(100) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
}, async ({ sessionId }) => { try { return response({ deleted: deleteSession(sessionId) }); } catch (e) { return jobError(e); } });

server.registerTool('review_and_fix', {
  description: 'Run up to three review rounds and automatically edit files to fix verified findings, rerunning requested checks after each edit. Executes shell checks with user permissions. Stops on incomplete review, failed checks, or round limit. This changes project files.',
  inputSchema: { cwd: z.string().min(1), base: z.string().default('HEAD'), intent: z.string().max(5000).default(''), mode: z.enum(['quick', 'standard', 'deep']).default('standard'), checkCommands: z.array(z.string().min(1).max(2000)).max(5).default([]), autoChecks: z.boolean().default(false), maxRounds: z.number().int().min(1).max(3).default(3) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, async options => {
  try {
    if (!['rules', 'bypassPermissions', 'autoApprove'].includes(getPermissionMode())) throw new Error('review_and_fix runs outside Code Mode permissions; use rules, bypassPermissions or autoApprove mode');
    const modelCall = openAIModel({ endpoint: process.env.REVIEW_MODEL_ENDPOINT, model: process.env.REVIEW_MODEL_NAME, apiKey: process.env.REVIEW_MODEL_API_KEY });
    const result = await runReviewCycle({ ...options, modelCall });
    return { isError: result.status !== 'reviewed', content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'failed', error: e.message }) }] }; }
});

server.registerTool('review_changes', {
  description: 'Review tracked Git changes using independent local-model calls and verification. Optional checkCommands execute shell commands with user permissions and can modify files. Reports incomplete coverage; it does not approve, merge or enforce policies. The diff is sent to the configured model endpoint.',
  inputSchema: { cwd: z.string().min(1), base: z.string().default('HEAD'), intent: z.string().max(5000).default(''), mode: z.enum(['quick', 'standard', 'deep']).default('standard'), checkCommands: z.array(z.string().min(1).max(2000)).max(5).default([]), autoChecks: z.boolean().default(false) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, async ({ cwd, base, intent, mode, checkCommands, autoChecks }) => {
  try {
    if (!['rules', 'bypassPermissions', 'autoApprove'].includes(getPermissionMode())) throw new Error('review_changes runs outside Code Mode permissions; use rules, bypassPermissions or autoApprove mode');
    const modelCall = openAIModel({ endpoint: process.env.REVIEW_MODEL_ENDPOINT, model: process.env.REVIEW_MODEL_NAME, apiKey: process.env.REVIEW_MODEL_API_KEY });
    const result = await reviewChange({ cwd, base, intent, mode, modelCall, checkCommands, autoChecks });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'failed', error: e.message }) }] };
  }
});

await server.connect(new StdioServerTransport());
