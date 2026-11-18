import path from 'node:path';
import { openAIModel } from './review-engine.mjs';
import { runReviewCycle } from './review-cycle.mjs';

const args = process.argv.slice(2);
const get = (flag, fallback) => { const i = args.indexOf(flag); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`); return args[i + 1]; };
try {
  if (args.includes('--help')) { console.log('node review-cycle-cli.mjs --cwd <repo> [--base HEAD] [--mode standard] [--check "command"] [--auto-check]'); process.exit(0); }
  const checkCommands = []; for (let i = 0; i < args.length; i++) if (args[i] === '--check') { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing --check'); checkCommands.push(args[++i]); }
  const result = await runReviewCycle({ cwd: path.resolve(get('--cwd', process.cwd())), base: get('--base', 'HEAD'), intent: get('--intent', ''), mode: get('--mode', 'standard'), checkCommands, autoChecks: args.includes('--auto-check'), modelCall: openAIModel({ endpoint: process.env.REVIEW_MODEL_ENDPOINT, model: process.env.REVIEW_MODEL_NAME, apiKey: process.env.REVIEW_MODEL_API_KEY }) });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'reviewed') process.exitCode = 2;
} catch (e) { console.error(`Cycle failed: ${e.message}`); process.exitCode = 2; }
