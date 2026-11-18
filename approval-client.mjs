// Trusted-side client for the local approval broker. Only the MCP server
// process (and tests) import this module; the untrusted worker never does.
// The broker is the human's surface: nonces are one-time, pending nonces live
// only in broker memory, and no MCP tool can grant an approval.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from './approval-broker.mjs';

const brokerPath = fileURLToPath(new URL('./approval-broker.mjs', import.meta.url));
const instances = new Map(); // dataDir -> { baseUrl, token }

export function approvalTimeoutMs() {
  const value = Number(process.env.CODE_MODE_APPROVAL_TIMEOUT_MS ?? 120000);
  if (!Number.isInteger(value) || value < 100 || value > 120000) throw new Error('Invalid CODE_MODE_APPROVAL_TIMEOUT_MS');
  return value;
}

async function health(baseUrl, timeoutMs = 1500) {
  try {
    const response = await fetch(`${baseUrl}/health?token=1`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await response.json();
    return body.ok === true ? { baseUrl, token: body.token, pid: body.pid } : null;
  } catch { return null; }
}

async function readInfo(dataDir) {
  try {
    const info = JSON.parse(await readFile(path.join(dataDir, 'broker.json'), 'utf8'));
    if (typeof info?.port !== 'number' || typeof info?.pid !== 'number') return null;
    return info;
  } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Reuse a healthy broker or start one. The broker is spawned detached so it
// survives the MCP server being restarted by the Desktop app; a healthy
// broker is re-attached via broker.json. A slow (but alive) broker is never
// taken over: only a dead pid or a missing broker.json triggers a respawn,
// so in-flight pending approvals are not orphaned by an impatient health
// check.
export async function ensureBroker(dataDir) {
  const resolved = path.resolve(dataDir || defaultDataDir());
  const cached = instances.get(resolved);
  if (cached) {
    const ok = await health(cached.baseUrl);
    if (ok) { instances.set(resolved, ok); return ok; }
    instances.delete(resolved);
  }
  const info = await readInfo(resolved);
  const started = Date.now();
  for (;;) {
    if (info) {
      if (!pidAlive(info.pid)) break; // dead broker: take over
      const ok = await health(`http://127.0.0.1:${info.port}`);
      if (ok) { instances.set(resolved, ok); return ok; }
    }
    if (Date.now() - started > 8000) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const logFile = path.join(resolved, 'broker.log');
  let child;
  try {
    const { openSync } = await import('node:fs');
    const fd = openSync(logFile, 'a');
    child = spawn(process.execPath, [brokerPath, '--data-dir', resolved], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, CODE_MODE_DATA_DIR: resolved },
    });
    child.unref();
  } catch (error) {
    throw new Error(`Approval broker could not start: ${error.message}`);
  }
  const spawnStarted = Date.now();
  for (;;) {
    const fresh = await readInfo(resolved);
    if (fresh) {
      const ok = await health(`http://127.0.0.1:${fresh.port}`, 400);
      if (ok) { instances.set(resolved, ok); return ok; }
    }
    if (Date.now() - spawnStarted > 6000) {
      try { child.kill(); } catch { /* already exited */ }
      throw new Error('Approval broker could not start; check <data dir>/broker.log');
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

function messageFor(outcome, tool) {
  switch (outcome.decision) {
    case 'deny': return `Approval denied for ${tool}${outcome.reason ? `: ${outcome.reason}` : ''}`;
    case 'timeout': return `Approval countdown expired for ${tool}; start new code before requesting approval again`;
    case 'cancelled': return `Approval cancelled before the user decided${outcome.reason ? `: ${outcome.reason}` : ''}`;
    case 'lost': return 'Approval lost: the approval broker restarted; run the operation again';
    default: return `Approval failed for ${tool}: ${outcome.decision}`;
  }
}

// Post the approval request to the broker. Returns the one-time nonce and
// the human's UI URL. The nonce is never exposed through any MCP response.
export async function createApprovalRequest({ dataDir, jobId, tool, file, command, preview, deadline }) {
  const instance = await ensureBroker(dataDir);
  let created;
  try {
    const response = await fetch(`${instance.baseUrl}/requests?t=${encodeURIComponent(instance.token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, tool, file, command, preview: preview?.slice(0, 8000), deadline }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.nonce) throw new Error(body.error || `Approval broker rejected the request (${response.status})`);
    created = body;
  } catch (error) {
    throw new Error(`Approval broker unavailable for ${tool}: ${error.message}`);
  }
  return created;
}

// Create the broker request, then long-poll for the human's decision.
// Resolves only on 'approve'; anything else throws with a stable message.
export async function requestApproval({ dataDir, jobId, tool, file, command, preview, deadlineMs, signal }) {
  signal?.throwIfAborted();
  const created = await createApprovalRequest({ dataDir, jobId, tool, file, command, preview, deadline: new Date(Date.now() + (deadlineMs ?? approvalTimeoutMs())).toISOString() });
  if (signal?.aborted) {
    await cancelDecision(dataDir, created.nonce, 'request aborted').catch(() => {});
    throw new Error('Execution stopped while requesting approval');
  }
  return waitForDecision({ dataDir, nonce: created.nonce, tool, signal });
}

export async function waitForDecision({ dataDir, nonce, tool, signal }) {
  const poll = async () => {
    const instance = await ensureBroker(dataDir);
    const response = await fetch(`${instance.baseUrl}/decision?nonce=${encodeURIComponent(nonce)}&t=${encodeURIComponent(instance.token)}`, { signal });
    if (!response.ok) throw new Error(`Approval broker error (${response.status})`);
    return response.json();
  };
  let outcome;
  try {
    outcome = await poll();
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') {
      await cancelDecision(dataDir, nonce, 'client disconnected').catch(() => {});
      throw new Error(`Approval cancelled for ${tool}: the request was aborted while awaiting the user`);
    }
    if (/404/.test(String(error.status || error.message))) {
      // The nonce is unknown to the (re)started broker: its memory is gone.
      throw new Error(messageFor({ decision: 'lost' }, tool));
    }
    throw new Error(`Approval broker disconnected for ${tool}; run the operation again (${error.cause?.code || error.message})`);
  }
  if (outcome.decision === 'approve') return outcome;
  throw new Error(messageFor(outcome, tool));
}

export async function cancelDecision(dataDir, nonce, reason) {
  const instance = await ensureBroker(dataDir);
  const response = await fetch(`${instance.baseUrl}/cancel?t=${encodeURIComponent(instance.token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, reason }),
    signal: AbortSignal.timeout(3000),
  });
  await response.body?.cancel();
  return response.ok || response.status === 409;
}

// Records where the model's untrusted code actually runs relative to the
// broker. Written once by the server at startup; used by SECURITY.md guidance
// and by live verification. workerIsolated is true only when the worker runs
// as a different OS user or in a container/VM; that is the only configuration
// in which the helper-level gates plus broker form a hard boundary. With
// CODE_MODE_ISOLATION=docker the probe is a real `docker version` check:
// the flag alone is not isolation until a docker engine answers.
export function isolationSnapshot(dockerAvailable) {
  let container = false, wsl = false;
  try {
    if (existsSync('/.dockerenv')) container = true;
    else if (existsSync('/proc/1/cgroup')) container = /docker|containerd|kubepods|lxc/i.test(readFileSync('/proc/1/cgroup', 'utf8'));
    if (process.platform === 'linux' && existsSync('/proc/version')) wsl = /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch { /* non-Linux filesystems */ }
  const isolationMode = (process.env.CODE_MODE_ISOLATION || 'off').toLowerCase();
  const dockerIsolated = isolationMode === 'docker' && dockerAvailable === true;
  return {
    platform: process.platform,
    container,
    wsl,
    isolationMode: isolationMode === 'off' ? undefined : isolationMode,
    dockerAvailable: dockerAvailable ?? null,
    workerIsolated: dockerIsolated || container || wsl,
    note: dockerIsolated
      ? 'Isolated worker: each job runs in a disposable container with only the project mounted; the host loopback (approval broker) is unreachable from the worker. Helper gates remain the only control on the host side.'
      : 'The worker runs untrusted model code with the OS privileges of the launching account. Helper-level policy gates are not a sandbox: direct Node.js/shell access bypasses them. For a hard boundary run with CODE_MODE_ISOLATION=docker or across OS users (see SECURITY.md).',
  };
}
