// Evaluate previously recorded reports against human-labelled cases.
// This measures matches, not the quality of the labels themselves.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function scoreCases(cases) {
  let expected = 0, matched = 0, reported = 0, falsePositives = 0, incomplete = 0;
  const details = [];
  for (const item of cases) {
    if (!Array.isArray(item.expected) || !Array.isArray(item.report?.findings)) throw new Error('Each case needs expected and report.findings arrays');
    const found = item.report.findings;
    const matches = new Set();
    for (const e of item.expected) {
      const index = found.findIndex((f, i) => !matches.has(i) && f.file === e.file && (!e.category || e.category === f.category) && (!e.line || e.line === f.line));
      if (index >= 0) matches.add(index);
    }
    expected += item.expected.length; matched += matches.size; reported += found.length; falsePositives += found.length - matches.size;
    if (item.report.status === 'incomplete' || item.report.status === 'failed') incomplete++;
    details.push({ id: item.id, expected: item.expected.length, matched: matches.size, reported: found.length, status: item.report.status });
  }
  return { cases: cases.length, expected, matched, reported, falsePositives, incomplete, recall: expected ? matched / expected : null, precision: reported ? matched / reported : null, details };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = process.argv[2]; if (!file) throw new Error('Usage: node review-eval.mjs cases.json');
    const cases = JSON.parse(await readFile(file, 'utf8')); if (!Array.isArray(cases)) throw new Error('Expected an array');
    console.log(JSON.stringify(scoreCases(cases), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 2; }
}
