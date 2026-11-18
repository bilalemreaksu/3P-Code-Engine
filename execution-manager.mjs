import { fork, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPermissionMode } from './code-mode-policy.mjs';
import { approvalTimeoutMs, cancelDecision, createApprovalRequest, waitForDecision } from './approval-client.mjs';

const worker = fileURLToPath(new URL('./code-mode-worker.mjs', import.meta.url));
const jobs = new Map(), sessions = new Map(), busy = new Set();
let autoEpoch = 0;

export const dataDir = process.env.CODE_MODE_DATA_DIR || path.join(process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), '3p-code-engine');

function approvalFields(event) {
  const input = event.tool_input || {};
  return {
    tool: event.tool_name,
    file: typeof input.file_path === 'string' ? input.file_path : undefined,
    command: typeof input.command === 'string' ? input.command : undefined,
    preview: JSON.stringify(input).slice(0, 4000),
  };
}

// Foreground and background approvals both queue here. The broker request is
// created once; the human answers in the local approval UI; the long poll
// resolves the worker. The approval stays visible in pendingApprovals (via
// getJob/transcript) whether the tool call is blocking or not. The model can
// observe pendingApprovals through code_status but cannot grant the
// approval: no MCP tool carries the nonce or a decision endpoint.
function queueApproval(job, event, signal) {
  if (job.approvalTimedOut) return Promise.reject(new Error('Approval countdown expired; start new code before requesting approval again'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const deadline = new Date(Date.now() + approvalTimeoutMs()).toISOString();
    const permission = { id, event, deadline, nonce: undefined, url: undefined, finished: false };
    const finish = error => {
      if (permission.finished) return;
      permission.finished = true;
      clearTimeout(safeguard);
      signal.removeEventListener('abort', aborted);
      job.permissions.delete(id);
      if (error) reject(error); else resolve();
    };
    // Safeguard: even if the broker poll wedges, the deadline bounds the wait.
    const safeguard = setTimeout(() => { job.approvalTimedOut = true; finish(new Error(`Approval countdown expired for ${event.tool_name}; start new code before requesting approval again`)); }, approvalTimeoutMs() + 5000);
    safeguard.unref?.();
    const aborted = () => {
      if (permission.nonce) void cancelDecision(dataDir, permission.nonce, 'job cancelled').catch(() => {});
      finish(new Error('Execution stopped while awaiting approval'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) return aborted();
    job.permissions.set(id, permission);
    void (async () => {
      try {
        const created = await createApprovalRequest({ dataDir, jobId: job.id, deadline, ...approvalFields(event) });
        if (permission.finished) return;
        permission.nonce = created.nonce;
        permission.url = created.url;
        await waitForDecision({ dataDir, nonce: created.nonce, tool: event.tool_name, signal });
        finish();
      } catch (error) {
        if (signal.aborted) return finish(new Error('Execution stopped while awaiting approval'));
        if (/countdown expired|Approval lost/.test(error.message)) job.approvalTimedOut = true;
        finish(error);
      }
    })();
  });
}

function filename(kind, id) { return path.join(dataDir, `${kind}-${createHash('sha256').update(id).digest('hex')}.json`); }
function save(kind, id, value) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = filename(kind, id), temp = `${target}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify({ version: kind === 'session' ? 2 : 1, id, value }), { encoding: 'utf8', mode: 0o600 }); renameSync(temp, target); }
  finally { rmSync(temp, { force: true }); }
}
function load(kind, id) {
  try {
    const data = JSON.parse(readFileSync(filename(kind, id), 'utf8'));
    if (data.id !== id) throw new Error('Invalid saved record');
    if (kind === 'session' && data.version === 1) return { state: data.value, history: [] };
    if (data.version !== (kind === 'session' ? 2 : 1)) throw new Error('Invalid saved record');
    return data.value;
  }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') { const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); killer.unref(); }
  else child.kill('SIGKILL');
}

// taskkill is async on Windows; the worker keeps its cwd in the target
// directory, so callers must not treat the job as finished (or touch that
// directory) until the process has actually exited.
function waitForExit(child, graceMs = 5000) {
  return new Promise(resolve => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
    const onExit = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(); }, graceMs);
    child.once('exit', onExit);
  });
}

function getSession(id) {
  return sessions.get(id) || load('session', id);
}

export function resumeSession(id) {
  const saved = getSession(id);
  if (!saved) throw new Error('Unknown Code Mode session');
  if (saved.mode && saved.mode !== getPermissionMode()) throw new Error(`Resume this session with permission mode ${saved.mode}`);
  const { state, ...metadata } = saved;
  return { sessionId: id, ...metadata, running: busy.has(id) };
}

export function startExecution({ cwd, code, timeoutMs = 120000, sessionId, decide, background = false }) {
  const mode = getPermissionMode();
  if (typeof code !== 'string' || !code.trim() || code.length > 65536) throw new Error('code must be 1..65536 characters');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > (background ? 7200000 : 600000)) throw new Error('Invalid execution timeout');
  if (background && !['rules', 'auto', 'bypassPermissions'].includes(mode)) throw new Error('Background code requires rules, auto or bypassPermissions mode');
  approvalTimeoutMs();
  const saved = sessionId ? getSession(sessionId) : undefined;
  if (saved?.mode && saved.mode !== mode) throw new Error(`Resume this session with permission mode ${saved.mode}`);
  cwd ??= saved?.cwd;
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path for a new session');
  cwd = path.normalize(cwd);
  if (saved?.cwd && saved.cwd !== cwd) throw new Error('Session belongs to a different working directory');
  if (jobs.size >= 100) {
    for (const [id, job] of jobs) if (job.status !== 'running') { jobs.delete(id); if (jobs.size < 100) break; }
    if (jobs.size >= 100) throw new Error('Background job capacity reached');
  }
  if (sessionId && busy.has(sessionId)) throw new Error('Session already has an execution in progress');
  if (sessionId && !sessions.has(sessionId) && sessions.size >= 64) throw new Error('Session capacity reached');
  const child = fork(worker, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  if (sessionId) busy.add(sessionId);
  const id = randomUUID();
  for (const active of jobs.values()) active.approvalTimedOut = false;
  const job = { id, mode, background, cwd, status: 'running', startedAt: new Date().toISOString(), child, events: [], nextSequence: 1, permissions: new Map(), reviewValid: false };
  try { save('job', id, { id, status: 'interrupted', startedAt: job.startedAt, events: [], nextSequence: 1, result: { ok: false, error: 'Server stopped while this job was running; completion is unknown.' } }); }
  catch (e) { terminate(child); if (sessionId) busy.delete(sessionId); throw new Error(`Cannot persist job: ${e.message}`); }
  jobs.set(id, job);
  job.promise = new Promise(resolve => {
    let settled = false;
    const controller = new AbortController();
    const finish = (result, status) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      controller.abort();
      result.transcript = code;
      result.jobId = id;
      if (sessionId) {
        busy.delete(sessionId);
        const session = { cwd, mode, state: result.ok ? result.state : saved?.state ?? {},
          history: [...(saved?.history ?? []), id].slice(-100) };
        try { save('session', sessionId, session); sessions.set(sessionId, session); }
        catch (e) { result = { ...result, ok: false, error: `Session could not be saved: ${e.message}` }; }
      }
      job.status = status || (result.ok ? 'completed' : 'failed');
      job.finishedAt = new Date().toISOString(); job.result = result;
      try { save('job', id, { id, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, result: job.result, events: job.events, nextSequence: job.nextSequence }); }
      catch (e) { result.persistenceWarning = `Job result could not be saved: ${e.message}`; }
      delete job.child; void waitForExit(child).then(() => resolve(result));
    };
    job.cancel = () => { terminate(child); finish({ ok: false, error: 'Execution cancelled; detached child processes may remain.' }, 'cancelled'); };
    const timer = setTimeout(() => { terminate(child); finish({ ok: false, error: 'Execution timed out; detached child processes may remain.' }, 'timed_out'); }, timeoutMs);
    child.on('message', result => {
      if (result?.decisionId && ['approve', 'classify', 'autoTool'].includes(result.kind)) {
        if (settled) return;
        const reply = async () => {
          let error;
          try {
            if (result.kind === 'classify') {
              const epoch = ++autoEpoch;
              for (const active of jobs.values()) if (active.mode === 'auto') active.reviewValid = false;
              if (!decide) throw new Error('Auto mode requires a classifier');
              await decide('classify', result.event, controller.signal);
              job.reviewValid = epoch === autoEpoch;
            } else if (result.kind !== 'autoTool' || !job.reviewValid) {
              await queueApproval(job, result.event, controller.signal);
            }
          } catch (failure) { error = failure.message; }
          if (!settled && child.connected) child.send({ decisionId: result.decisionId, allowed: error === undefined, error }, () => {});
        };
        void reply();
        return;
      }
      if (result && result.__codeModeProgress === true) {
        if (settled || !['stdout', 'stderr', 'log', 'operation', 'limit'].includes(result.kind) || typeof result.data !== 'string') return;
        job.events.push({ sequence: job.nextSequence++, kind: result.kind, data: result.data.slice(0, 4096) });
        if (job.events.length > 256) job.events.shift();
        return;
      }
      if (result && typeof result.ok === 'boolean') finish(result);
    });
    child.on('error', e => finish({ ok: false, error: e.message }));
    child.on('exit', (code, signal) => finish({ ok: false, error: `Worker exited without result: code=${code}, signal=${signal}` }));
    child.send({ code, cwd, sessionId, mode, background, state: saved?.state ?? {} }, error => { if (error) finish({ ok: false, error: error.message }); });
  });
  return job;
}
export function getJob(id, afterSequence = 0) {
  const job = jobs.get(id) || load('job', id); if (!job) throw new Error('Unknown job');
  const firstSequence = job.events[0]?.sequence ?? job.nextSequence;
  return { id: job.id, status: job.status, startedAt: job.startedAt, events: job.events.filter(event => event.sequence > afterSequence), nextSequence: job.nextSequence, eventsDropped: afterSequence < firstSequence - 1,
    ...(job.permissions?.size ? { pendingApprovals: [...job.permissions.values()].map(({ id, event, deadline, url }) => ({ id, tool: event.tool_name, deadline, ...(url ? { url } : {}) })) } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}), ...(job.result ? { result: job.result } : {}) };
}
export function cancelJob(id) { const job = jobs.get(id); if (!job) return getJob(id); if (job.status === 'running') job.cancel(); return getJob(id); }
export function deleteJob(id) { const job = jobs.get(id) || load('job', id); if (!job) return false; if (job.status === 'running') throw new Error('Cancel the job before deleting its record'); jobs.delete(id); rmSync(filename('job', id), { force: true }); return true; }
export function deleteSession(id) { if (busy.has(id)) throw new Error('Session already has an execution in progress'); const existed = sessions.delete(id) || load('session', id) !== undefined; rmSync(filename('session', id), { force: true }); return existed; }
