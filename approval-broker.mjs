// Local human-approval broker for 3P Code Mode.
//
// Binds to 127.0.0.1 on a random port and is the ONLY surface where a human
// answers approval requests. The MCP server (trusted infrastructure) posts
// requests here and long-polls for the decision; the human uses the HTML page
// served on the instance URL. Pending nonces live only in this process's
// memory and are never written to disk: a worker process running as the same
// OS user can read any file but cannot read another process's memory.
// See SECURITY.md for the threat model and the residual same-user risks.

import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const PREVIEW_LIMIT = 8000;
const MAX_REQUEST_DEADLINE_MS = 24 * 60 * 60 * 1000;
const BODY_LIMIT = 256 * 1024;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const GENESIS = '0'.repeat(64);

export function defaultDataDir() {
  return process.env.CODE_MODE_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), '3p-code-engine');
}

function sha256(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }

// Hash-chained audit log. Each stored line is the JSON of an entry whose
// `prev` field is the sha256 of the previous stored line (genesis is zeros).
// readAudit recomputes every hash; any edit, drop or reorder breaks the chain.
// NOTE: the chain detects tampering, but a same-OS-user process can rewrite
// the whole file; combine with the cross-checks in live-verification/verify-results.mjs.
export class AuditLog {
  constructor(file) {
    this.file = file;
    this.lastHash = GENESIS;
    this.queue = Promise.resolve();
  }
  append(entry) {
    const line = JSON.stringify({ ...entry, prev: this.lastHash });
    this.lastHash = sha256(line);
    this.queue = this.queue.then(() => appendFile(this.file, `${line}\n`, 'utf8')).catch(() => {});
    return this.queue;
  }
  async flush() { await this.queue; }
}

export async function readAudit(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { valid: true, entries: [] }; throw error; }
  const lines = raw.split('\n').filter(line => line.trim());
  const entries = [];
  let prev = GENESIS;
  let valid = true;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { valid = false; entries.push({ invalid: true }); continue; }
    if (entry.prev !== prev) valid = false;
    prev = sha256(line);
    entries.push(entry);
  }
  return { valid, entries };
}

const page = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="color-scheme" content="dark">
<title>3P Code Mode · İnsan Onayı</title>
<style>
 body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;max-width:860px;margin:2rem auto;padding:0 1rem}
 h1{font-size:1.25rem}h2{font-size:1rem;margin-top:2rem;color:#9aa4b2}
 .card{background:#171a21;border:1px solid #2a2f3a;border-radius:8px;padding:1rem;margin:.75rem 0}
 .tool{font-weight:700;font-size:1.05rem;color:#7ab7ff}
 .meta{color:#9aa4b2;font-size:.85rem;margin:.25rem 0}
 pre{background:#0b0d11;border:1px solid #232833;border-radius:6px;padding:.6rem;overflow-x:auto;font-size:.8rem;white-space:pre-wrap;word-break:break-all}
 button{border:0;border-radius:6px;padding:.5rem 1.1rem;font-size:.95rem;cursor:pointer;margin-right:.5rem}
 .ok{background:#1f7a45;color:#fff}.no{background:#8a2f2f;color:#fff}
 .empty{color:#6b7280;padding:1rem 0}
 .dec{color:#9aa4b2;font-size:.85rem;margin:.2rem 0}
 .dec.approve{color:#4ade80}.dec.deny{color:#f87171}.dec.timeout,.dec.cancelled,.dec.lost{color:#facc15}
</style></head>
<body>
<h1>3P Code Mode · İnsan Onayı</h1>
<p class="meta">Bu sayfa yalnızca 127.0.0.1 üzerinde sunulur. Kararları yalnızca siz buradan verirsiniz; model bu kararlara MCP araçlarıyla ulaşamaz.</p>
<div id="pending"></div>
<h2>Son kararlar</h2>
<div id="recent"></div>
<script>
const t = new URLSearchParams(location.search).get('t') || '';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function decide(nonce, decision) {
  const r = await fetch('/decisions?t=' + encodeURIComponent(t), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,decision,channel:'ui'})});
  if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.error || ('Karar kabul edilmedi (' + r.status + ')')); }
  refresh();
}
function card(item) {
  const d = document.createElement('div'); d.className = 'card';
  d.innerHTML = '<div class="tool"></div><div class="meta file"></div><div class="meta cmd"></div><pre></pre><div class="meta cd"></div><div><button class="ok"></button><button class="no"></button></div>';
  d.querySelector('.tool').textContent = item.tool;
  d.querySelector('.file').textContent = 'Dosya: ' + (item.file || '—') + '  ·  İş: ' + item.jobId + '  ·  Son: ' + new Date(item.deadline).toLocaleTimeString();
  if (item.command) d.querySelector('.cmd').textContent = 'Komut: ' + item.command;
  d.querySelector('pre').textContent = item.preview || '';
  const ok = d.querySelector('.ok'), no = d.querySelector('.no');
  ok.textContent = 'Onayla'; no.textContent = 'Ret';
  ok.addEventListener('click', () => decide(item.nonce, 'approve'));
  no.addEventListener('click', () => decide(item.nonce, 'deny'));
  return d;
}
async function refresh() {
  try {
    const [p, r] = await Promise.all([
      fetch('/pending?t=' + encodeURIComponent(t)).then(x => x.ok ? x.json() : []),
      fetch('/recent?t=' + encodeURIComponent(t)).then(x => x.ok ? x.json() : []).catch(() => [])
    ]);
    const box = document.getElementById('pending'); box.innerHTML = '';
    if (!p.length) box.innerHTML = '<div class="empty">Bekleyen onay yok.</div>';
    for (const item of p) box.appendChild(card(item));
    const rec = document.getElementById('recent'); rec.innerHTML = '';
    for (const d of r) {
      const el = document.createElement('div'); el.className = 'dec ' + d.decision;
      el.textContent = new Date(d.ts).toLocaleString() + ' · ' + d.decision + (d.reason ? ' · ' + d.reason : '') + ' · ' + (d.tool || '') + (d.file ? ' · ' + d.file : '') + ' · ' + d.jobId;
      rec.appendChild(el);
    }
  } catch {}
  setTimeout(refresh, 1000);
}
refresh();
</script>
</body></html>`;

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function parseBody(request, response) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) { reject(new Error('Body too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON body');
        resolve(value);
      } catch { reject(new Error('Invalid JSON body')); }
    });
    request.on('error', reject);
    response.on('close', () => reject(new Error('Client disconnected')));
  });
}

export async function startBroker(options = {}) {
  const dataDir = path.resolve(options.dataDir || defaultDataDir());
  const idleMs = options.idleMs === undefined ? DEFAULT_IDLE_MS : Number(options.idleMs);
  if (!Number.isInteger(idleMs) || idleMs < 0) throw new Error('Invalid broker idle timeout');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const auditFile = path.join(dataDir, 'approvals.jsonl');
  const infoFile = path.join(dataDir, 'broker.json');
  const token = randomBytes(16).toString('hex');
  const audit = new AuditLog(auditFile);

  const existing = await readInfo(infoFile);
  if (existing && await healthFetch(existing)) {
    return { reused: true, port: existing.port, baseUrl: `http://127.0.0.1:${existing.port}`, token: (await healthFetch(existing, true)) ?? token, close: async () => {} };
  }

  const pending = new Map();
  // Consumed nonces stay in a bounded in-memory table so that a one-time
  // nonce is observably one-time: a duplicate decision gets a 409 (not a
  // 404) and late polls can replay the stored outcome. Never written to disk.
  const consumed = new Map();
  const remember = item => {
    consumed.set(item.nonce, item);
    if (consumed.size > 512) consumed.delete(consumed.keys().next().value);
  };
  const startedAt = new Date().toISOString();
  let lastActivity = Date.now();
  let closing = false;

  function consume(item, outcome) {
    if (item.outcome) return item.outcome;
    item.outcome = outcome;
    clearTimeout(item.timer);
    for (const waiter of item.waiters) waiter(outcome);
    item.waiters.clear();
    pending.delete(item.nonce);
    remember(item);
    return outcome;
  }

  function armDeadline(item) {
    const remaining = Date.parse(item.deadline) - Date.now();
    const expire = () => {
      if (item.outcome) return;
      consume(item, { decision: 'timeout', reason: undefined, channel: 'broker', decidedAt: new Date().toISOString() });
      void audit.append({ ts: new Date().toISOString(), event: 'timeout', nonce: item.nonce, jobId: item.jobId, deadline: item.deadline });
    };
    if (remaining <= 0) return expire();
    item.timer = setTimeout(expire, remaining);
    item.timer.unref?.();
  }

  async function shutdown(reason) {
    if (closing) return;
    closing = true;
    for (const item of pending.values()) {
      consume(item, { decision: 'lost', reason: 'broker-shutdown', channel: 'broker', decidedAt: new Date().toISOString() });
      void audit.append({ ts: new Date().toISOString(), event: 'lost', nonce: item.nonce, jobId: item.jobId, reason });
    }
    void audit.append({ ts: new Date().toISOString(), event: 'shutdown', reason });
    await audit.flush();
    try {
      const current = await readInfo(infoFile);
      if (current?.pid === process.pid) await rm(infoFile, { force: true });
    } catch { /* best effort */ }
    await new Promise(resolve => {
      server.close(resolve);
      // Every pending approval was consumed above and its response sent; any
      // remaining socket is keep-alive idle. Close them so the server can
      // actually terminate.
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  }

  const server = createServer(async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch { return json(response, 400, { error: 'Bad URL' }); }
    const query = url.searchParams;
    const route = `${request.method} ${url.pathname}`;
    try {
      lastActivity = Date.now();
      if (route === 'GET /health') {
        return json(response, 200, { ok: true, pid: process.pid, port: server.address().port, startedAt, pending: pending.size, ...(query.get('token') ? { token } : {}) });
      }
      if (route === 'POST /close') {
        const body = await parseBody(request, response);
        if (body.pid !== process.pid) return json(response, 403, { error: 'pid mismatch' });
        // Connection: close ends this socket right after the response, so the
        // server.close() inside shutdown() can complete.
        response.setHeader('Connection', 'close');
        json(response, 200, { ok: true });
        return shutdown('explicit');
      }
      if (route === 'POST /requests') {
        if (query.get('t') !== token) return json(response, 403, { error: 'Forbidden' });
        const body = await parseBody(request, response);
        const now = Date.now();
        const deadline = Date.parse(body.deadline);
        if (typeof body.jobId !== 'string' || !body.jobId || body.jobId.length > 64) throw new Error('jobId is required');
        if (typeof body.tool !== 'string' || !body.tool || body.tool.length > 200) throw new Error('tool is required');
        if (!Number.isFinite(deadline) || deadline <= now || deadline - now > MAX_REQUEST_DEADLINE_MS) throw new Error('deadline must be in the future');
        const nonce = randomBytes(32).toString('hex');
        const item = {
          nonce,
          jobId: body.jobId,
          tool: body.tool,
          file: typeof body.file === 'string' ? body.file.slice(0, 1000) : undefined,
          command: typeof body.command === 'string' ? body.command.slice(0, 2000) : undefined,
          preview: typeof body.preview === 'string' ? body.preview.slice(0, PREVIEW_LIMIT) : undefined,
          deadline: new Date(deadline).toISOString(),
          createdAt: new Date().toISOString(),
          waiters: new Set(),
        };
        pending.set(nonce, item);
        armDeadline(item);
        void audit.append({ ts: item.createdAt, event: 'request', nonce, jobId: item.jobId, tool: item.tool, file: item.file, command: item.command, deadline: item.deadline });
        return json(response, 201, { nonce, deadline: item.deadline, url: `http://127.0.0.1:${server.address().port}/?t=${token}` });
      }
      if (route === 'GET /decision') {
        if (query.get('t') !== token) return json(response, 403, { error: 'Forbidden' });
        const item = pending.get(query.get('nonce') || '') ?? consumed.get(query.get('nonce') || '');
        if (!item) return json(response, 404, { error: 'unknown nonce' });
        if (item.outcome) return json(response, 200, item.outcome);
        return new Promise(resolve => {
          const waiter = result => { item.waiters.delete(waiter); json(response, 200, result); resolve(); };
          item.waiters.add(waiter);
          request.on('close', () => { item.waiters.delete(waiter); resolve(); });
        });
      }
      if (route === 'POST /decisions') {
        if (query.get('t') !== token) return json(response, 403, { error: 'Forbidden' });
        const body = await parseBody(request, response);
        // Only the approval UI page can grant a decision. The page is served
        // by this broker, so a human's browser sends
        // Origin: http://127.0.0.1:<port>. A background fetch holding the
        // relayed tokenized URL (for example worker code) has no such origin
        // and is rejected + audited; /cancel stays token-gated because it
        // can only revoke, never grant.
        if (request.headers.origin !== `http://127.0.0.1:${server.address().port}`) {
          void audit.append({ ts: new Date().toISOString(), event: 'rejected-decision', nonce: String(body.nonce || ''), reason: 'origin-mismatch', channel: String(body.channel || 'api') });
          return json(response, 403, { error: 'Decision must come from the approval UI' });
        }
        const item = pending.get(body.nonce || '') ?? consumed.get(body.nonce || '');
        if (!item) return json(response, 404, { error: 'unknown nonce' });
        if (item.outcome) {
          void audit.append({ ts: new Date().toISOString(), event: 'duplicate-decision', nonce: item.nonce, jobId: item.jobId, decision: String(body.decision), channel: String(body.channel || 'api') });
          return json(response, 409, { error: 'nonce already consumed' });
        }
        if (!['approve', 'deny'].includes(body.decision)) throw new Error('decision must be approve or deny');
        consume(item, { decision: body.decision, reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined, channel: String(body.channel || 'api'), fromUi: true, decidedAt: new Date().toISOString() });
        void audit.append({ ts: new Date().toISOString(), event: 'decision', nonce: item.nonce, jobId: item.jobId, decision: item.outcome.decision, reason: item.outcome.reason, channel: item.outcome.channel, fromUi: true, tool: item.tool, file: item.file, waitedMs: Date.parse(item.outcome.decidedAt) - Date.parse(item.createdAt) });
        return json(response, 200, { ok: true });
      }
      if (route === 'POST /cancel') {
        if (query.get('t') !== token) return json(response, 403, { error: 'Forbidden' });
        const body = await parseBody(request, response);
        const item = pending.get(body.nonce || '') ?? consumed.get(body.nonce || '');
        if (!item) return json(response, 404, { error: 'unknown nonce' });
        if (item.outcome) return json(response, 409, { error: 'nonce already consumed' });
        consume(item, { decision: 'cancelled', reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined, channel: String(body.channel || 'api'), decidedAt: new Date().toISOString() });
        void audit.append({ ts: new Date().toISOString(), event: 'cancelled', nonce: item.nonce, jobId: item.jobId, reason: item.outcome.reason, channel: item.outcome.channel, tool: item.tool, file: item.file });
        return json(response, 200, { ok: true });
      }
      if (route === 'GET /' || route === 'GET /pending' || route === 'GET /recent') {
        if (query.get('t') !== token) return json(response, 403, { error: 'Forbidden' });
        if (url.pathname === '/') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return response.end(page);
        }
        if (url.pathname === '/pending') {
          return json(response, 200, [...pending.values()].filter(item => !item.outcome).map(({ nonce, jobId, tool, file, command, preview, deadline, createdAt }) => ({ nonce, jobId, tool, file, command, preview, deadline, createdAt, url: `http://127.0.0.1:${port}/?t=${token}` })));
        }
        return json(response, 200, await recentDecisions());
      }
      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      if (!response.headersSent) return json(response, 400, { error: error.message || 'Bad request' });
      response.destroy();
    }
  });

  let recentCache = null;
  async function recentDecisions() {
    // The audit file is the source of recent decisions.
    const { entries } = await readAudit(auditFile);
    recentCache = entries.filter(entry => ['decision', 'timeout', 'cancelled', 'lost'].includes(entry.event)).slice(-20);
    return recentCache;
  }

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await writeInfo(infoFile, { port, pid: process.pid, startedAt });
  void audit.append({ ts: startedAt, event: 'start', pid: process.pid, port });

  const idleTimer = setInterval(() => {
    if (!closing && idleMs > 0 && pending.size === 0 && Date.now() - lastActivity > idleMs) {
      void shutdown('idle').then(() => { if (options.onShutdown) options.onShutdown(); else process.exit(0); });
    }
  }, 60000);
  idleTimer.unref?.();

  return {
    reused: false,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    close: async reason => { clearInterval(idleTimer); await shutdown(reason || 'test'); },
  };
}

async function readInfo(infoFile) {
  try {
    const info = JSON.parse(await readFile(infoFile, 'utf8'));
    if (typeof info?.port !== 'number' || typeof info?.pid !== 'number') return null;
    return info;
  } catch { return null; }
}

async function writeInfo(infoFile, info) {
  const temp = `${infoFile}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(info), { mode: 0o600 });
  await rename(temp, infoFile);
}

async function healthFetch(info, wantToken = false) {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health${wantToken ? '?token=1' : ''}`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) { await response.body?.cancel(); return wantToken ? null : false; }
    const body = await response.json();
    if (body.ok !== true || body.pid !== info.pid) return wantToken ? null : false;
    return wantToken ? body.token : true;
  } catch { return wantToken ? null : false; }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--data-dir');
  const dirArg = index >= 0 ? argv[index + 1] : undefined;
  if (dirArg && !path.isAbsolute(dirArg)) { console.error('--data-dir must be an absolute path'); process.exit(1); }
  const dataDir = dirArg ? path.resolve(dirArg) : defaultDataDir();
  startBroker({ dataDir }).then(handle => {
    if (handle.reused) { console.log(`Broker already running on port ${handle.port}`); process.exit(0); }
    console.log(`3P Code Mode approval broker: ${handle.baseUrl}/?t=${handle.token} (pid ${process.pid}, data ${dataDir})`);
  }).catch(error => { console.error(`Broker failed: ${error.message}`); process.exit(1); });
}
