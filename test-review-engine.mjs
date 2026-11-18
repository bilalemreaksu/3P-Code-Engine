import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewChange, collectChange, openAIModel } from './review-engine.mjs';
import { renderReport, updateLedger } from './review-report.mjs';
import { scoreCases } from './review-eval.mjs';
import { runReviewCycle } from './review-cycle.mjs';

const dir = await mkdtemp(path.join(process.cwd(), 'review-test-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', windowsHide: true });
try {
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(path.join(dir, 'app.js'), 'const divisor = 2;\n');
  git('add', 'app.js'); git('commit', '-qm', 'baseline');
  await writeFile(path.join(dir, 'app.js'), 'const divisor = 0;\n');
  const change = await collectChange(dir);
  assert.deepEqual(change.names, ['app.js']); assert.match(change.diff, /divisor = 0/);
  const finding = { file: 'app.js', line: 1, severity: 'high', title: 'Zero divisor', description: 'A zero divisor causes invalid arithmetic.', category: 'bug', introduced: true };
  let calls = 0;
  const modelCall = async system => { calls++; return system.includes('independently verify') ? { verdict: 'confirmed', reason: 'Changed value is zero.' } : { findings: [finding] }; };
  const check = process.platform === 'win32' ? 'Write-Output ok' : 'echo ok';
  const result = await reviewChange({ cwd: dir, modelCall, checkCommands: [check] });
  assert.equal(result.status, 'findings'); assert.equal(result.findings.length, 1); assert.equal(calls, 5);
  assert.match(renderReport(result), /app.js:1/);
  const ledger = path.join(dir, 'history.json');
  assert.equal((await updateLedger(ledger, result)).limitReached, false);
  assert.equal((await updateLedger(ledger, result)).newFindingKeys.length, 0);
  assert.equal((await updateLedger(ledger, result)).limitReached, true);
  assert.equal(result.checks[0].status, 'passed');
  const cycleModel = async (system, input) => {
    if (system.includes('code author')) return { file: 'app.js', oldText: 'divisor = 0', newText: 'divisor = 2' };
    if (system.includes('independently verify')) return { verdict: 'confirmed', reason: 'Zero divisor' };
    return { findings: input.includes('+const divisor = 0;') ? [finding] : [] };
  };
  const cycle = await runReviewCycle({ cwd: dir, modelCall: cycleModel, mode: 'quick', checkCommands: [check] });
  assert.equal(cycle.status, 'reviewed'); assert.equal(cycle.rounds.length, 2);
  assert.equal(await readFile(path.join(dir, 'app.js'), 'utf8'), 'const divisor = 2;\n');
  await writeFile(path.join(dir, 'app.js'), 'const divisor = 0;\n');
  const score = scoreCases([{ id: 'example', expected: [{ file: 'app.js', line: 1 }], report: result }]);
  assert.equal(score.recall, 1); assert.equal(score.precision, 1);
  let requested = false, received = false;
  const researcher = async (system, input) => {
    if (system.includes('independently verify')) return { verdict: 'confirmed', reason: 'Confirmed' };
    if (!requested) { requested = true; return { request_files: ['app.js', '../outside', '.env'] }; }
    if (input.includes('SOURCE EVIDENCE')) { received = input.includes('divisor = 0') && input.includes('not allowed'); }
    return { findings: [] };
  };
  await reviewChange({ cwd: dir, mode: 'quick', modelCall: researcher, checkCommands: [check] });
  assert.equal(received, true);
  await writeFile(path.join(dir, 'untracked.js'), 'test');
  assert.ok((await collectChange(dir)).names.includes('untracked.js'));
  const incomplete = await reviewChange({ cwd: dir, modelCall: async () => ({ findings: [] }), mode: 'quick' });
  assert.equal(incomplete.status, 'incomplete'); assert.match(incomplete.warnings.join(' '), /No tests/);
  const failed = await reviewChange({ cwd: dir, modelCall: async () => { throw new Error('offline'); }, mode: 'quick' });
  assert.equal(failed.status, 'incomplete'); assert.match(failed.warnings.join(' '), /offline/);
  await assert.rejects(collectChange(dir, '--help'), /Invalid base/);
  const realFetch = globalThis.fetch;
  try {
    let usedModel;
    globalThis.fetch = async (url, options) => url.endsWith('/models')
      ? { ok: true, json: async () => ({ data: [{ id: 'custom-model' }] }) }
      : { ok: true, json: async () => { usedModel = JSON.parse(options.body).model; return { choices: [{ message: { content: '{"findings":[]}' } }] }; } };
    await openAIModel({ endpoint: 'http://127.0.0.1:1234/v1' })('review', 'diff');
    assert.equal(usedModel, 'custom-model');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'a' }, { id: 'b' }] }) });
    await assert.rejects(openAIModel({ endpoint: 'http://127.0.0.1:1234/v1' })('review', 'diff'), /REVIEW_MODEL_NAME/);
  } finally { globalThis.fetch = realFetch; }
  console.log('PASS: review snapshots, independent calls, verification, checks, incomplete coverage and failures');
} finally { await rm(dir, { recursive: true, force: true }); }
