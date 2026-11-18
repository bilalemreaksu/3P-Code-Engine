import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectChange } from './review-engine.mjs';
import { renderReport } from './review-report.mjs';

const exec = promisify(execFile);
const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name}`); return args[i + 1]; }
try {
  const cwd = path.resolve(option('--cwd'));
  const pr = option('--pr'); if (!/^[1-9][0-9]*$/.test(pr)) throw new Error('PR must be a positive integer');
  const result = JSON.parse(await readFile(path.resolve(option('--json')), 'utf8'));
  if (!['reviewed', 'findings'].includes(result.status) || !Array.isArray(result.findings) || !Array.isArray(result.uncertain) || result.uncertain.length) throw new Error('Only a complete review can be published');
  const { stdout: status } = await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, windowsHide: true });
  if (status.trim()) throw new Error('Working tree must be clean, including untracked files');
  const { stdout } = await exec('gh', ['pr', 'view', pr, '--json', 'headRefOid,baseRefOid'], { cwd, windowsHide: true });
  const remote = JSON.parse(stdout);
  if (remote.headRefOid !== result.head || remote.baseRefOid !== result.base) throw new Error('PR head or base no longer matches the reviewed commits');
  const change = await collectChange(cwd, result.base);
  if (change.snapshot !== result.snapshot) throw new Error('Local diff no longer matches review snapshot');
  const text = renderReport(result);
  if (!args.includes('--publish')) { console.log(text); console.log('\nPreview only. Add --publish to post a comment review.'); process.exit(0); }
  const tmp = await mkdtemp(path.join(os.tmpdir(), '3p-review-'));
  try {
    const body = path.join(tmp, 'review.md'); await writeFile(body, text, 'utf8');
    await exec('gh', ['pr', 'review', pr, '--comment', '--body-file', body], { cwd, windowsHide: true });
    console.log(`Posted review comment on PR #${pr}.`);
  } finally { await rm(tmp, { recursive: true, force: true }); }
} catch (e) { console.error(`PR review was not published: ${e.stderr || e.message}`); process.exitCode = 2; }
