import { openAIModel, reviewChange } from './review-engine.mjs';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { renderReport, updateLedger } from './review-report.mjs';

const args = process.argv.slice(2);
const get = (flag, fallback) => { const i = args.indexOf(flag); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`); return args[i + 1]; };
try {
  if (args.includes('--help')) {
    console.log('node review-cli.mjs --cwd <repository> [--base HEAD] [--mode quick|standard|deep] [--intent "description"]');
    process.exit(0);
  }
  const cwd = path.resolve(get('--cwd', process.cwd()));
  const modelCall = openAIModel({ endpoint: process.env.REVIEW_MODEL_ENDPOINT, model: process.env.REVIEW_MODEL_NAME, apiKey: process.env.REVIEW_MODEL_API_KEY });
  const checkCommands = []; for (let i = 0; i < args.length; i++) if (args[i] === '--check') { if (!args[i+1] || args[i+1].startsWith('--')) throw new Error('Missing --check command'); checkCommands.push(args[++i]); }
  const result = await reviewChange({ cwd, base: get('--base', 'HEAD'), mode: get('--mode', 'standard'), intent: get('--intent', ''), modelCall, checkCommands, autoChecks: args.includes('--auto-check') });
  const ledger = get('--ledger', '');
  if (ledger) result.history = await updateLedger(path.resolve(ledger), result);
  const report = get('--report', '');
  if (report) await writeFile(path.resolve(report), renderReport(result), 'utf8');
  const json = get('--json', '');
  if (json) await writeFile(path.resolve(json), JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'incomplete') process.exitCode = 2;
  else if (result.findings.length) process.exitCode = 1;
} catch (e) { console.error(`Review failed: ${e.message}`); process.exitCode = 2; }
