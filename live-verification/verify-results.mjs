import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAudit } from '../approval-broker.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.argv[2];
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Usage: node live-verification/verify-results.mjs <absolute Desktop data directory>');
const session = async id => {
  const name = `session-${createHash('sha256').update(id).digest('hex')}.json`;
  const record = JSON.parse(await readFile(path.join(dataDir, name), 'utf8'));
  assert.equal(record.id, id);
  return record.value;
};
const exists = async file => { try { return await readFile(path.join(directory, file), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const records = [];
for (const file of await readdir(dataDir)) {
  if (!/^job-[a-f0-9]{64}\.json$/.test(file)) continue;
  const record = JSON.parse(await readFile(path.join(dataDir, file), 'utf8'));
  const job = record.value;
  if (!job?.result?.transcript || !/desktop-smoke|desktop-approved|desktop-denied|withheld-input|DESKTOP_LIVE_PROGRESS|should-cancel/.test(job.result.transcript)) continue;
  records.push(job);
}
const saved = await session('desktop-live-check');
const background = await session('desktop-background-check');
const blocked = records.find(job => job.result.outputBlocked && job.result.transcript.includes('withheld-input.txt'));
const synthetic = await exists('withheld-input.txt');

// Approval evidence: the broker's hash-chained audit log. A job counts as
// human-approved only when an 'approve' decision line exists for its jobId,
// the tool and file match, the decision happened inside the job's own
// lifetime, the decision came from the approval UI's own origin (fromUi,
// verified by the broker — the page it serves) with channel 'ui', and the
// nonce was consumed exactly once. File existence alone is not proof.
const auditFile = path.join(dataDir, 'approvals.jsonl');
const audit = await readAudit(auditFile);
const decisionEntries = audit.entries.filter(entry => entry.event === 'decision');
const nonceCounts = new Map();
for (const entry of decisionEntries) nonceCounts.set(entry.nonce, (nonceCounts.get(entry.nonce) ?? 0) + 1);
const approvedEntryFor = (jobId, tool, basename) => decisionEntries.find(entry =>
  entry.decision === 'approve' &&
  entry.jobId === jobId &&
  entry.tool === tool &&
  path.basename(String(entry.file || '')) === basename &&
  entry.channel === 'ui' &&
  entry.fromUi === true &&
  nonceCounts.get(entry.nonce) === 1 &&
  (() => { const job = records.find(candidate => candidate.id === jobId); return job && Date.parse(entry.ts) >= Date.parse(job.startedAt) && Date.parse(entry.ts) <= Date.parse(job.finishedAt); })()
);

const approvalJob = records.find(job => job.result.ok && job.result.result === 'DESKTOP_APPROVAL_PASS' && job.result.operations?.some(op => op.operation === 'write' && path.basename(op.file) === 'desktop-approved.txt'));
const interactiveApproval =
  await exists('desktop-approved.txt') === 'approved-by-user' &&
  Boolean(approvalJob) &&
  audit.valid &&
  Boolean(approvedEntryFor(approvalJob?.id, 'Write', 'desktop-approved.txt'));

const checks = {
  executionAndParallelReads: await exists('desktop-smoke.txt') === 'after\n' && records.some(job => job.result.ok && job.result.result?.includes('DESKTOP_CODE_MODE_PASS') && job.result.operations.some(op => op.operation === 'edit')),
  sessionResume: saved.state.desktopSmoke === true && saved.history.length >= 2 && records.some(job => job.result.result?.includes('DESKTOP_SESSION_PASS')),
  backgroundProgress: background.state.backgroundDone === true && records.some(job => job.status === 'completed' && job.result.result === 'DESKTOP_BACKGROUND_PASS' && job.events.some(event => event.data === 'DESKTOP_LIVE_PROGRESS')),
  deniedWriteHasNoEffect: await exists('desktop-denied.txt') === null && records.some(job => job.result.result?.includes('DESKTOP_DENY_PASS') && job.result.result.includes('DESKTOP_HOOK_DENY_PASS') && job.result.operations.length === 0),
  outputWithheldWithoutLeak: Boolean(blocked && blocked.result.ok === false && blocked.events.length === 0 && blocked.result.error.includes('DESKTOP_OUTPUT_HOOK_PASS') && synthetic && !JSON.stringify(blocked).includes(synthetic) && !('logs' in blocked.result) && !('state' in blocked.result) && !('operations' in blocked.result)),
  backgroundCancellation: records.some(job => job.status === 'cancelled' && job.result.transcript.includes('should-cancel')),
  approvalAuditChain: audit.valid,
  interactiveApproval,
};
const report = {
  generatedAt: new Date().toISOString(),
  surface: process.env.DESKTOP_SURFACE || 'Claude Desktop 3P, local Code session',
  desktopSessionId: process.env.DESKTOP_SESSION_ID || 'unknown',
  passed: Object.values(checks).every(Boolean),
  checks,
  audit: {
    valid: audit.valid,
    decisions: decisionEntries.map(({ ts, nonce, jobId, tool, file, decision, channel, reason, fromUi }) => ({ ts, nonce, jobId, tool, file, decision, channel, reason, fromUi })),
  },
  jobs: records.map(job => ({ id: job.id, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, outputBlocked: Boolean(job.result.outputBlocked) })),
};
await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, checks }, null, 2));
if (!report.passed) process.exitCode = 1;
