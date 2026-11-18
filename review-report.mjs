import { readFile, writeFile } from 'node:fs/promises';

const safe = value => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 1200);
const keyFor = f => `${f.category}|${f.file}|${f.line}|${f.title.toLowerCase()}`;
export function renderReport(result) {
  const lines = ['# Code review', '', `**Result:** ${safe(result.status)} | **Risk:** ${safe(result.risk)} | **Findings:** ${result.findings.length} | **Uncertain:** ${result.uncertain.length}`, '', `**Base:** ${safe(result.base)}  `, `**Head:** ${safe(result.head)}  `, `**Snapshot:** ${safe(result.snapshot)}`, '', '## Findings', ''];
  if (!result.findings.length) lines.push('No confirmed findings. This is not a guarantee that the change is safe.', '');
  for (const f of result.findings) lines.push(`### ${safe(f.severity).toUpperCase()} — ${safe(f.title)}`, '', `- Location: \`${safe(f.file).replace(/`/g, '')}:${f.line}\``, `- Category: ${safe(f.category)}`, `- Evidence: ${safe(f.description)}`, `- Verification: ${f.verification.map(v => safe(v.reason)).join(' | ')}`, '');
  lines.push('## Uncertain findings', '');
  if (!result.uncertain.length) lines.push('None.', '');
  for (const f of result.uncertain) lines.push(`- ${safe(f.file)}:${f.line}: ${safe(f.title)} — ${safe(f.description)}`);
  lines.push('', '## Checks', '');
  if (!result.checks.length) lines.push('No checks run.');
  for (const c of result.checks) lines.push(`- **${safe(c.status)}**: \`${safe(c.command).replace(/`/g, '')}\``);
  lines.push('', '## Limitations', '');
  for (const w of result.warnings) lines.push(`- ${safe(w)}`);
  lines.push('- AI results are advisory; review evidence and permissions before merging.', '');
  return lines.join('\n');
}

// The optional ledger is local evidence, never an approval or a merge authority.
export async function updateLedger(file, result, roundLimit = 3) {
  let previous = { version: 1, rounds: [] };
  try { previous = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (previous.version !== 1 || !Array.isArray(previous.rounds)) throw new Error('Invalid review ledger');
  const round = previous.rounds.length + 1;
  const previousKeys = new Set(previous.rounds.flatMap(r => r.findingKeys || []));
  const current = result.findings.map(keyFor);
  const entry = { round, base: result.base, head: result.head, snapshot: result.snapshot, status: result.status, findingKeys: current, newFindingKeys: current.filter(k => !previousKeys.has(k)), at: new Date().toISOString() };
  previous.rounds.push(entry);
  await writeFile(file, JSON.stringify(previous, null, 2) + '\n', 'utf8');
  return { round, limitReached: round >= roundLimit, newFindingKeys: entry.newFindingKeys };
}
