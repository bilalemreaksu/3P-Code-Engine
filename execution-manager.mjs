import { fork, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { getPermissionMode, policyCheck } from './code-mode-policy.mjs';
import { approvalTimeoutMs, cancelDecision, createApprovalRequest, waitForDecision } from './approval-client.mjs';
import { createHostBridge } from './code-mode-host.mjs';
import { workerImageTag } from './worker-image.mjs';

const worker = fileURLToPath(new URL('./code-mode-worker.mjs', import.meta.url));
const engineDir = path.dirname(fileURLToPath(import.meta.url));
const jobs = new Map(), sessions = new Map(), busy = new Set();
let autoEpoch = 0;

// OS isolation. CODE_MODE_ISOLATION=docker runs every worker inside a
// disposable container: the project cwd is the only host path it sees
// (mounted at /work), and the host's loopback interface — where the
// approval broker listens — is unreachable from the container. The worker
// protocol then travels JSON-lines over stdio instead of the fork IPC
// channel (see code-mode-channel.mjs).
function isolationMode() {
  const mode = (process.env.CODE_MODE_ISOLATION || 'off').toLowerCase();
  if (!['off', 'docker'].includes(mode)) throw new Error(`Unknown CODE_MODE_ISOLATION value: ${process.env.CODE_MODE_ISOLATION}`);
  return mode;
}
// The docker CLI by default, overridable through CODE_MODE_DOCKER_BIN.
// The override is useful for alternative CLIs (podman) and lets the isolation
// test substitute a fake engine.
export function dockerBin() {
  return process.env.CODE_MODE_DOCKER_BIN || 'docker';
}
// A batch-file CLI (.cmd/.bat, as version managers or the test fake produce)
// cannot be spawned directly on Windows — spawn() throws EINVAL for it — so
// the system shell executes it. /s keeps the argument quoting intact.
export function spawnDocker(args, opts) {
  const bin = dockerBin();
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(bin)) {
    return spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', bin, ...args], opts);
  }
  return spawn(bin, args, opts);
}
function dockerRun(args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnDocker(args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timer;
    const fail = error => { clearTimeout(timer); child.kill(); reject(error); };
    if (timeoutMs) timer = setTimeout(() => fail(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`)), timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', error => fail(error));
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      // BuildKit writes progress to stderr on non-TTY; a build that dies
      // early can leave stdout holding the only useful detail.
      else reject(new Error([stderr.trim(), stdout.trim()].filter(Boolean).join(' | ').slice(-4000) || `docker ${args[0]} exited with code ${code}`));
    });
  });
}
const imageBuilds = new Map();
async function ensureWorkerImage() {
  const image = await workerImageTag();
  if (imageBuilds.has(image)) return imageBuilds.get(image);
  const build = (async () => {
    try { await dockerRun(['image', 'inspect', image], { timeoutMs: 15000 }); return image; }
    catch { /* first use: build the small worker image once */ }
    await dockerRun(['build', '-q', '-t', image, '-f', path.join(engineDir, 'worker-image', 'Dockerfile'), engineDir], { timeoutMs: 300000 });
    // Do not run an image built while its source inputs were changing.
    if (await workerImageTag() !== image) throw new Error('Worker source changed during image build; retry the job');
    return image;
  })().catch(error => {
    // A failure is transient (e.g. Docker Desktop stopped mid-session):
    // forget the cached rejection so the next job re-probes the engine
    // instead of replaying a stale error until the server restarts.
    imageBuilds.delete(image);
    throw error;
  });
  imageBuilds.set(image, build);
  return build;
}
isolationMode() === 'docker' && void ensureWorkerImage().catch(() => {});
function spawnWorker(cwd, containerName, image) {
  if (isolationMode() !== 'docker') return { child: fork(worker, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }), isolated: false, container: undefined };
  const child = spawnDocker(['run', '-i', '--rm', '--init', '--name', containerName,
    '-v', `${cwd}:/work`, '-w', '/work',
    '-e', 'CODE_MODE_WORKER_TRANSPORT=stdio',
    image, 'node', '/app/code-mode-worker.mjs'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return { child, isolated: true, container: containerName };
}
// The fork child delivers protocol messages over its IPC channel; the
// docker child over stdout lines. User-code console.log noise (non-JSON
// lines) is dropped on both ends.
function onWorkerMessage(child, isolated, handler, fail) {
  if (!isolated) { child.on('message', handler); return; }
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  child.stdout.on('data', chunk => {
    buffer += decoder.write(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) { fail(new Error('Worker message exceeds 2 MiB')); return; }
      if (!line.trimStart().startsWith('{')) continue;
      try { handler(JSON.parse(line)); } catch { /* not a protocol line */ }
    }
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) fail(new Error('Worker message exceeds 2 MiB'));
  });
}

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

function terminate(child, container) {
  if (container) {
    // The attached `docker run` client exits when the container is removed.
    const killer = spawnDocker(['rm', '-f', container], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.unref();
    return;
  }
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

export async function startExecution({ cwd, code, timeoutMs, sessionId, decide, background = false }) {
  timeoutMs ??= background ? 7200000 : 600000;
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
  const isolation = isolationMode();
  // Reserve before asynchronous image preparation so two starts cannot load
  // the same state and later overwrite each other's session history.
  if (sessionId) busy.add(sessionId);
  let policy, image;
  const container = isolation === 'docker' ? `3p-worker-${randomUUID().replace(/-/g, '').slice(0, 24)}` : undefined;
  let child, isolated;
  try {
    if (isolation === 'docker') {
      // First job pays the one-time image build (or reuse) cost.
      image = await ensureWorkerImage();
      // Policy and hooks stay on the trusted host, beside the MCP config.
      const policyPath = process.env.CODE_MODE_POLICY_PATH || path.join(engineDir, 'code-mode-policy.json');
      if (!path.isAbsolute(policyPath)) throw new Error('CODE_MODE_POLICY_PATH must be absolute');
      policy = JSON.parse(await readFile(policyPath, 'utf8'));
      policyCheck(policy, cwd, sessionId, mode); // validate before starting any worker
    }
    ({ child, isolated } = spawnWorker(cwd, container, image));
  } catch (error) {
    if (sessionId) busy.delete(sessionId);
    throw error;
  }
  const id = randomUUID();
  for (const active of jobs.values()) active.approvalTimedOut = false;
  const job = { id, mode, background, cwd, status: 'running', startedAt: new Date().toISOString(), child, container, isolated, events: [], nextSequence: 1, permissions: new Map(), reviewValid: false };
  try { save('job', id, { id, status: 'interrupted', startedAt: job.startedAt, events: [], nextSequence: 1, result: { ok: false, error: 'Server stopped while this job was running; completion is unknown.' } }); }
  catch (e) { terminate(child, container); if (sessionId) busy.delete(sessionId); throw new Error(`Cannot persist job: ${e.message}`); }
  jobs.set(id, job);
  job.promise = new Promise(resolve => {
    let settled = false, finalizing = false;
    const controller = new AbortController();
    const decideForJob = async (kind, event) => {
      controller.signal.throwIfAborted();
      if (kind === 'classify') {
        const epoch = ++autoEpoch;
        for (const active of jobs.values()) if (active.mode === 'auto') active.reviewValid = false;
        if (!decide) throw new Error('Auto mode requires a classifier');
        await decide('classify', event, controller.signal);
        job.reviewValid = epoch === autoEpoch;
      } else if (kind !== 'autoTool' || !job.reviewValid || event?.inputChangedByHook) {
        await queueApproval(job, event, controller.signal);
      }
    };
    const bridge = isolated ? createHostBridge({ policy, cwd, sessionId, mode, code, decide: decideForJob, signal: controller.signal }) : undefined;
    const heldEvents = [];
    const seenRequests = new Set();
    let activeRequests = 0;
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
      delete job.child; void waitForExit(child).then(() => {
        if (isolated && child.exitCode === null && child.signalCode === null) terminate(child, container);
        resolve(result);
      });
    };
    job.cancel = () => { terminate(child, container); finish({ ok: false, error: 'Execution cancelled; detached child processes may remain.' }, 'cancelled'); };
    const timer = setTimeout(() => { terminate(child, container); finish({ ok: false, error: 'Execution timed out; detached child processes may remain.' }, 'timed_out'); }, timeoutMs);
    let workerStderr = '';
    if (isolated) child.stderr.on('data', chunk => { workerStderr = (workerStderr + chunk.toString()).slice(-8192); });
    onWorkerMessage(child, isolated, result => {
      if (isolated && result?.rpcId) {
        if (settled || finalizing) return;
        const rpcId = result.rpcId;
        if (typeof rpcId !== 'string' || !/^[a-f0-9-]{36}$/.test(rpcId) || seenRequests.has(rpcId) || seenRequests.size >= 10000 || activeRequests >= 64) {
          terminate(child, container); finish({ ok: false, error: 'Invalid or excessive host requests' }); return;
        }
        seenRequests.add(rpcId); activeRequests++;
        void (async () => {
          let reply;
          try {
            const value = await bridge.request(result.method, result.params);
            if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new Error('Host response exceeds 1 MiB');
            reply = { rpcId, ok: true, value };
          } catch (error) { reply = { rpcId, ok: false, error: error.message }; }
          finally { activeRequests--; }
          if (!settled && !finalizing) child.stdin.write(JSON.stringify(reply) + '\n', () => {});
        })();
        return;
      }
      if (result?.decisionId && ['approve', 'classify', 'autoTool'].includes(result.kind)) {
        if (settled || isolated) return;
        const reply = async () => {
          let error;
          try {
            await decideForJob(result.kind, result.event);
          } catch (failure) { error = failure.message; }
          if (settled) return;
          const reply = { decisionId: result.decisionId, allowed: error === undefined, error };
          // The fork child answers over its IPC channel; the docker child over
          // the same JSON-lines protocol on stdin (it has no IPC channel).
          if (isolated) child.stdin.write(JSON.stringify(reply) + '\n', () => {});
          else if (child.connected) child.send(reply, () => {});
        };
        void reply();
        return;
      }
      if (result && result.__codeModeProgress === true) {
        if (settled || finalizing || !['stdout', 'stderr', 'log', 'operation', 'limit'].includes(result.kind) || typeof result.data !== 'string') return;
        const events = background && bridge?.hasOutputHooks ? heldEvents : job.events;
        events.push({ sequence: job.nextSequence++, kind: result.kind, data: result.data.slice(0, 4096) });
        if (events.length > 256) events.shift();
        return;
      }
      if (result && typeof result.ok === 'boolean' && !settled && !finalizing) {
        if (background && bridge?.hasOutputHooks) {
          finalizing = true;
          void bridge.checkOutput({ result, events: heldEvents }).then(out => {
            if (settled) return;
            job.events = heldEvents;
            if (out?.context?.length) result = { ...result, additionalContext: [result.additionalContext, ...out.context].filter(Boolean).join('\n\n') };
            finish(result);
          }, error => finish({ ok: false, outputBlocked: true, error: `Code output blocked: ${error.message}` }));
        } else finish(result);
      }
    }, error => { terminate(child, container); finish({ ok: false, error: error.message }); });
    child.on('error', e => finish({ ok: false, error: isolated ? `Isolated worker could not start: ${e.message}` : e.message }));
    child.on('exit', (code, signal) => { if (!finalizing) finish({ ok: false, error: `${isolated ? 'Isolated ' : ''}worker exited without result: code=${code}, signal=${signal}${isolated && workerStderr.trim() ? ` stderr=${workerStderr.trim().slice(-2000)}` : ''}` }); });
    if (isolated) {
      // The worker chdirs to /work (the mounted project); absolute paths in
      // code resolve against the container root, not the host.
      child.stdin.on('error', error => { if (!settled && !finalizing) finish({ ok: false, error: `Worker channel failed: ${error.message}` }); });
      child.stdin.write(JSON.stringify({ code, cwd: '/work', sessionId, mode, background, timeoutMs, state: saved?.state ?? {}, hostPolicy: true }) + '\n', error => { if (error) finish({ ok: false, error: `Isolated worker could not start: ${error.message}` }); });
    } else {
      child.send({ code, cwd, sessionId, mode, background, timeoutMs, state: saved?.state ?? {} }, error => { if (error) finish({ ok: false, error: error.message }); });
    }
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
