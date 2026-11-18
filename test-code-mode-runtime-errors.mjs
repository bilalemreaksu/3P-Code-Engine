import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Error-path hardening for code-mode-runtime.evaluateCode. Each scenario runs
// in its own child process: the pre-fix defects are a process crash
// (unhandled host rejection) and an infinite hang, which would otherwise take
// the test process down with them. A child that does not finish within 8 s is
// killed and reported as a hang.

const RUNTIME = new URL('./code-mode-runtime.mjs', import.meta.url).href;
const KILL_AFTER = 8000;

const scenarioSource = ({ code, tools, timeoutMs = 600000, postMs = 0 }) => `
const { evaluateCode } = await import(process.env.CODE_MODE_RUNTIME);
const tools = ${tools};
const started = Date.now();
try {
  const result = await evaluateCode({ code: ${JSON.stringify(code)}, tools, timeoutMs: ${timeoutMs} });
  console.log('settled=ok');
  console.log('value=' + JSON.stringify(result.value));
} catch (error) {
  console.log('settled=error');
  console.log('error=' + error.message);
  console.log('elapsed=' + (Date.now() - started));
}
${postMs ? `await new Promise(r => setTimeout(r, ${postMs}));\nconsole.log('late=settled');` : ''}
process.exit(0);
`;

const runScenario = (name, source) => new Promise(resolve => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CODE_MODE_RUNTIME: RUNTIME },
  });
  let out = '', err = '', killed = false;
  const killer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, KILL_AFTER);
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('close', (code, signal) => { clearTimeout(killer); resolve({ name, out, err, code, signal, killed }); });
});

const failures = [];
const expect = (v, want) => {
  const detail = (message) => `${v.name}: ${message}\nstdout: ${v.out}\nstderr: ${v.err}`;
  const check = (ok, message) => { if (!ok) failures.push(detail(message)); };
  check(!v.killed || want.hung, v.killed ? `hung (killed after ${KILL_AFTER} ms)` : 'expected a hang');
  if (want.hung) return;
  check(v.code === (want.code ?? 0), `exit code ${v.code} (signal ${v.signal})`);
  if (want.settled) check(v.out.match(new RegExp(`^settled=${want.settled}$`, 'm')), `wanted settled=${want.settled}`);
  if (want.error) check(v.out.match(new RegExp(`^error=.*${want.error}`, 'm')), `wanted error matching /${want.error}/`);
  if (want.value) check(v.out.match(new RegExp(`^value=${want.value}$`, 'm')), `wanted value ${want.value}`);
  if (want.line) check(v.out.match(want.line), `wanted line /${want.line.source}/`);
  if (want.maxMs) {
    const match = v.out.match(/^elapsed=(\d+)$/m);
    check(!!match, 'no elapsed line');
    if (match) check(Number(match[1]) < want.maxMs, `elapsed ${match[1]} ms >= ${want.maxMs} ms`);
  }
};

// 1. A helper rejection the guest never awaits is a pending-job error: it must
//    reach the caller instead of vanishing in executePendingJobs. (The call is
//    a plain statement — not the last expression — so completionBody does not
//    turn it into the awaited return value.)
const promiseJob = await runScenario('promise-job-error', scenarioSource({
  code: "read('boom'); 42",
  tools: '({ read: async () => { await new Promise(r => setTimeout(r, 10)); throw new Error(\'helper exploded\'); }, log: () => {} })',
}));
expect(promiseJob, { settled: 'error', error: 'helper exploded' });

// 2. A timer callback that throws while the evaluation is still active must be
//    surfaced, not disposed. (The timer is scheduled before the await so that
//    it fires while the main promise is still pending.)
const timerCallback = await runScenario('timer-callback-error', scenarioSource({
  code: "setTimeout(() => { throw new Error('timer died'); }, 20); await new Promise(r => setTimeout(r, 50)); 42",
  tools: '({ log: () => {} })',
}));
expect(timerCallback, { settled: 'error', error: 'timer died' });

// 3. A host result that cannot be JSON-serialized (BigInt) must reject the
//    guest promise with a clear error — not crash the host with an unhandled
//    rejection and not hang the REPL.
const serialization = await runScenario('serialization-error', scenarioSource({
  code: "await read('big')",
  tools: '({ read: async () => 1n })',
}));
expect(serialization, { settled: 'error', error: '[Ss]erialization failed' });

// 4. An out-of-memory allocation inside a pending job must reach the caller.
const memory = await runScenario('memory-limit', scenarioSource({
  code: "read('x').then(() => { const a = []; for (let i = 0; i < 2 * 10**7; i++) a.push(String(i)); })",
  tools: '({ read: async () => \'ok\' })',
}));
expect(memory, { settled: 'error', error: 'memory' });

// 5. The deadline must stop the evaluation while a helper is still pending:
//    no infinite wait, and the late host settlement after the context closed
//    must not become an unhandled rejection.
const cancelPending = await runScenario('cancel-pending-helper', scenarioSource({
  code: "await read('slow'); 'done'",
  tools: '({ read: async () => new Promise(r => setTimeout(() => r(\'late-result\'), 1500)) })',
  timeoutMs: 300,
  postMs: 1700,
}));
expect(cancelPending, { settled: 'error', error: 'timed out', line: /^late=settled$/m, maxMs: 1500 });

assert.deepEqual(failures, [], 'runtime error paths failed:\n' + failures.join('\n---\n'));
console.log('PASS: runtime error paths (job error, timer error, serialization, OOM, deadline while helper pending) reach the caller; no hang, no unhandled rejection');
