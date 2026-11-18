// Rule–tool–input–expected-decision matrix for the permissions engine.
// Expected decisions are derived from the official Claude Code permissions
// documentation (https://code.claude.com/docs/en/permissions) plus the
// project's documented strictness: allow rules never cover compound,
// redirected or unparseable commands, and the project's Write(path)
// extension only applies to the Write tool.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { policyCheck } from './code-mode-policy.mjs';
import { commandIsReadOnly, commandSegments } from './code-mode-rules.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'code-mode-rules-'));
const home = path.resolve(os.homedir());
const posix = value => value.split(path.sep).join('/');
const posixAbs = value => {
  if (process.platform === 'win32' && /^[A-Za-z]:[\\//]/.test(value)) return `/${value[0].toLowerCase()}${posix(value.slice(2))}`;
  return posix(value);
};
const file = (...parts) => path.join(dir, ...parts);
const bash = command => ({ command });
const hookBlock = { tool: 'Bash', command: process.execPath, args: [path.join(dir, 'hook-block.mjs')] };
const hookAllow = { tool: 'Bash', command: process.execPath, args: [path.join(dir, 'hook-allow.mjs')] };
await writeFile(path.join(dir, 'hook-block.mjs'), `process.exitCode = 2;`);
await writeFile(path.join(dir, 'hook-allow.mjs'), `console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }));`);
await writeFile(path.join(dir, 'hook-update.mjs'), `let body = ''; for await (const part of process.stdin) body += part;
  const event = JSON.parse(body);
  console.log(JSON.stringify({ hookSpecificOutput: { updatedInput: { command: process.argv[2], cwd: event.tool_input?.cwd, timeout: event.tool_input?.timeout } } }));`);
await writeFile(path.join(dir, 'hook-update-allow.mjs'), `let body = ''; for await (const part of process.stdin) body += part;
  const event = JSON.parse(body);
  console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { command: process.argv[2], cwd: event.tool_input?.cwd } } }));`);
const hookUpdate = command => ({ tool: 'Bash', command: process.execPath, args: [path.join(dir, 'hook-update.mjs'), command] });
const hookUpdateAllow = command => ({ tool: 'Bash', command: process.execPath, args: [path.join(dir, 'hook-update-allow.mjs'), command] });

const run = async (policy, mode, tool, input) => {
  const decisions = [];
  const check = policyCheck(policy, dir, undefined, mode, async (kind, event) => { decisions.push([kind, event.tool_name]); });
  try {
    await check(tool, input);
  } catch (error) {
    if (/policy denied/.test(error.message)) return 'deny';
    if (/plan mode denied/.test(error.message)) return 'plan';
    if (/hook refused/.test(error.message)) return 'hookrefuse';
    throw error;
  }
  if (decisions.some(([kind]) => kind === 'approve')) return 'ask';
  if (decisions.some(([kind, toolName]) => kind === 'autoTool' && toolName === tool)) return 'auto';
  return 'allow';
};

let failures = 0;
const row = async (name, policy, mode, tool, input, want) => {
  let got;
  try { got = await run(policy, mode, tool, input); } catch (error) { got = `error: ${error.message}`; }
  if (got !== want) { failures += 1; console.error(`FAIL ${name}: expected ${want}, got ${got}`); }
};

const R = 'rules', D = 'default', A = 'acceptEdits', P = 'plan', B = 'bypassPermissions', AUTO = 'auto';
const cases = [
  // --- File path rules: Edit rules cover the Write tool (native schema) ---
  ['F1 deny Edit(secrets/**) blocks Edit', { deny: ['Edit(secrets/**)'] }, R, 'Edit', { file_path: file('secrets', 'key.txt') }, 'deny'],
  ['F2 deny Edit(secrets/**) blocks nested depth', { deny: ['Edit(secrets/**)'] }, R, 'Edit', { file_path: file('a', 'secrets', 'key.txt') }, 'deny'],
  ['F3 deny Edit(secrets/**) leaves other paths', { deny: ['Edit(secrets/**)'] }, R, 'Edit', { file_path: file('other.txt') }, 'allow'],
  ['F4 allow Edit(src/**) covers Write in default mode', { allow: ['Edit(src/**)'] }, D, 'Write', { file_path: file('src', 'app.ts'), content: 'x' }, 'allow'],
  ['F5 allow Edit(src/**) is anchored for allow rules', { allow: ['Edit(src/**)'] }, D, 'Write', { file_path: file('vendor', 'pkg', 'src', 'lib.js'), content: 'x' }, 'ask'],
  ['F6 allow Edit(**/src/**) matches any depth', { allow: ['Edit(**/src/**)'] }, D, 'Edit', { file_path: file('vendor', 'pkg', 'src', 'lib.js') }, 'allow'],
  ['F7 allow Edit(/src/**) anchors at cwd', { allow: ['Edit(/src/**)'] }, D, 'Edit', { file_path: file('src', 'app.ts') }, 'allow'],
  ['F8 allow Edit(/src/**) does not match nested', { allow: ['Edit(/src/**)'] }, D, 'Edit', { file_path: file('a', 'src', 'app.ts') }, 'ask'],
  ['F19 deny Edit(docs/**) blocks Write', { deny: ['Edit(docs/**)'] }, R, 'Write', { file_path: file('docs', 'a.md'), content: 'x' }, 'deny'],
  ['F22 deny Edit (bare) covers Write', { deny: ['Edit'] }, R, 'Write', { file_path: file('any.txt'), content: 'x' }, 'deny'],
  ['F23 deny Edit does not cover Read', { deny: ['Edit'] }, R, 'Read', { file_path: file('any.txt') }, 'allow'],
  // --- Write(path) is a project extension: it only applies to Write ---
  ['F20 deny Write(legacy/**) blocks Write', { deny: ['Write(legacy/**)'] }, R, 'Write', { file_path: file('legacy', 'x'), content: 'x' }, 'deny'],
  ['F21 deny Write(legacy/**) leaves Edit to the mode', { deny: ['Write(legacy/**)'] }, D, 'Edit', { file_path: file('legacy', 'x') }, 'ask'],
  // --- Read rules ---
  ['F9 deny Read(.env) blocks exact name', { deny: ['Read(.env)'] }, R, 'Read', { file_path: file('.env') }, 'deny'],
  ['F10 deny Read(.env) is any depth for bare names', { deny: ['Read(.env)'] }, R, 'Read', { file_path: file('sub', '.env') }, 'deny'],
  ['F11 deny Read(.env) leaves .envrc', { deny: ['Read(.env)'] }, R, 'Read', { file_path: file('.envrc') }, 'allow'],
  ['F12 deny Read(*.env) is any depth', { deny: ['Read(*.env)'] }, R, 'Read', { file_path: file('sub', 'app.env') }, 'deny'],
  ['F13 allow Read(*.env) covers bare names at depth', { allow: ['Read(*.env)'] }, D, 'Read', { file_path: file('sub', 'app.env') }, 'allow'],
  ['F14 deny Read(src/*.ts) matches one segment', { deny: ['Read(src/*.ts)'] }, R, 'Read', { file_path: file('src', 'app.ts') }, 'deny'],
  ['F15 * does not cross a directory separator', { deny: ['Read(src/*.ts)'] }, R, 'Read', { file_path: file('src', 'sub', 'app.ts') }, 'allow'],
  ['F16 ** crosses directory separators', { deny: ['Read(src/**/*.ts)'] }, R, 'Read', { file_path: file('src', 'sub', 'app.ts') }, 'deny'],
  ['F17 allow cannot cover path traversal', { allow: ['Edit(src/**)'] }, D, 'Write', { file_path: file('src', '..', 'outside.txt'), content: 'x' }, 'ask'],
  ['F18 ./ prefix is cwd-relative', { deny: ['Read(./x.md)'] }, R, 'Read', { file_path: file('x.md') }, 'deny'],
  ['F24 // anchors at the filesystem root', { deny: [`Read(//${posixAbs(file('rooted.md')).slice(1)})`] }, R, 'Read', { file_path: file('rooted.md') }, 'deny'],
  ['F25 ~/ anchors at the home directory', { deny: ['Read(~/sub/x.md)'] }, R, 'Read', { file_path: path.join(home, 'sub', 'x.md') }, 'deny'],
  ...(path.resolve(dir).startsWith(home + path.sep) ? [] : [
    ['F26 ~/ does not match a same-named cwd file', { deny: ['Read(~/rules-home-file.md)'] }, R, 'Read', { file_path: file('rules-home-file.md') }, 'allow'],
  ]),
  ['F27 file paths normalize across separators', { deny: ['Edit(src/**)'] }, R, 'Edit', { file_path: file('src', 'app.ts').split(path.sep).join('\\') }, 'deny'],
  ['F30 bare name glob matches at depth', { deny: ['Read(src*)'] }, R, 'Read', { file_path: file('src2.md') }, 'deny'],
  // --- Bash command rules ---
  ['B1 deny Bash(git push:*) blocks the command', { deny: ['Bash(git push:*)'] }, R, 'Bash', bash('git push origin main'), 'deny'],
  ['B2 :* suffix also matches the bare command', { deny: ['Bash(git push:*)'] }, R, 'Bash', bash('git push'), 'deny'],
  ['B3 a rewritten invocation is not matched', { deny: ['Bash(git push:*)'] }, R, 'Bash', bash('git -C . push origin main'), 'allow'],
  ['B4 deny matches a subcommand of a compound command', { deny: ['Bash(git push:*)'] }, R, 'Bash', bash(`cd 'app' && git push origin main`), 'deny'],
  ['B5 quoted text is not a command', { deny: ['Bash(git push:*)'] }, R, 'Bash', bash(`echo 'git push origin main'`), 'allow'],
  ['B6 allow Bash(npm run *) covers the command', { allow: ['Bash(npm run *)'] }, D, 'Bash', bash('npm run build'), 'allow'],
  ['B7 trailing * also matches the bare command', { allow: ['Bash(npm run *)'] }, D, 'Bash', bash('npm run'), 'allow'],
  ['B8 a different program still asks', { allow: ['Bash(npm run *)'] }, D, 'Bash', bash('npm install'), 'ask'],
  ['B9 allow Bash(ls *) matches the bare command', { allow: ['Bash(ls *)'] }, D, 'Bash', bash('ls'), 'allow'],
  ['B10 allow Bash(ls *) matches with arguments', { allow: ['Bash(ls *)'] }, D, 'Bash', bash('ls -la'), 'allow'],
  ['B11 the space before * is part of the rule', { allow: ['Bash(ls *)'] }, D, 'Bash', bash('lsof'), 'ask'],
  ['B12 every subcommand covered (rule + read-only) allows', { allow: ['Bash(npm test *)'] }, D, 'Bash', bash('npm test && ls'), 'allow'],
  ['B13 an uncovered subcommand in a compound asks', { allow: ['Bash(npm test *)'] }, D, 'Bash', bash('npm test && curl http://example.com'), 'ask'],
  ['B14 a pipeline of a rule and a read-only command allows', { allow: ['Bash(npm test *)'] }, D, 'Bash', bash('npm test | grep fail'), 'allow'],
  ['B15 an output redirect is not silently allowed', { allow: ['Bash(npm run *)'] }, D, 'Bash', bash('npm run test > out.txt'), 'ask'],
  ['B16 an input redirect is not silently allowed', { allow: ['Bash(npm run *)'] }, D, 'Bash', bash('npm run test < in.txt'), 'ask'],
  ['B17 a trailing separator is unparseable for allow', { allow: ['Bash(npm *)'] }, D, 'Bash', bash('npm test &&'), 'ask'],
  ['B18 command substitution is not silently allowed', { allow: ['Bash(npm *)'] }, D, 'Bash', bash('$(npm test)'), 'ask'],
  ['B19 backtick substitution is not silently allowed', { allow: ['Bash(npm *)'] }, D, 'Bash', bash('`npm test`'), 'ask'],
  ['B20 an uncovered pipeline segment asks', { allow: ['Bash(npm *)'] }, D, 'Bash', bash('npm test |& x'), 'ask'],
  ['B21 separators inside quotes are not separators', { allow: ['Bash(echo *)'] }, D, 'Bash', bash(`echo 'a; b'`), 'allow'],
  ['B22 deny matches any subcommand', { deny: ['Bash(rm *)'] }, R, 'Bash', bash('echo hi && rm -rf build/'), 'deny'],
  ['B23 bypassPermissions mode allows without rules', {}, B, 'Bash', bash('npm install'), 'allow'],
  // --- Documented read-only commands (same grammar for Bash and PowerShell) ---
  ['R1 ls is read-only', {}, D, 'Bash', bash('ls -la'), 'allow'],
  ['R2 cat is read-only', {}, D, 'Bash', bash('cat notes.md'), 'allow'],
  ['R3 echo is read-only', {}, D, 'Bash', bash('echo hi'), 'allow'],
  ['R4 pwd is read-only', {}, D, 'Bash', bash('pwd'), 'allow'],
  ['R5 head is read-only', {}, D, 'Bash', bash('head -n 5 f.txt'), 'allow'],
  ['R6 tail is read-only', {}, D, 'Bash', bash('tail f.txt'), 'allow'],
  ['R7 grep is read-only', {}, D, 'Bash', bash('grep -rn pattern .'), 'allow'],
  ['R8 wc is read-only', {}, D, 'Bash', bash('wc -l f.txt'), 'allow'],
  ['R9 which is read-only', {}, D, 'Bash', bash('which node'), 'allow'],
  ['R10 diff is read-only', {}, D, 'Bash', bash('diff a.txt b.txt'), 'allow'],
  ['R11 stat is read-only', {}, D, 'Bash', bash('stat f.txt'), 'allow'],
  ['R12 du is read-only', {}, D, 'Bash', bash('du -sh .'), 'allow'],
  ['R13 read-only git forms are read-only', {}, D, 'Bash', bash('git status'), 'allow'],
  ['R14 git log is read-only', {}, D, 'Bash', bash('git log --oneline'), 'allow'],
  ['R15 git diff is read-only', {}, D, 'Bash', bash('git diff'), 'allow'],
  ['R16 git commit is not read-only', {}, D, 'Bash', bash('git commit -m x'), 'ask'],
  ['R17 git -c flag can run a program', {}, D, 'Bash', bash('git -c core.fsmonitor=x status'), 'ask'],
  ['R18 plain find is read-only', {}, D, 'Bash', bash('find . -name x.tmp'), 'allow'],
  ['R19 find -delete is not read-only', {}, D, 'Bash', bash('find . -delete'), 'ask'],
  ['R20 unquoted glob with find asks', {}, D, 'Bash', bash('find . -name *.tmp'), 'ask'],
  ['R21 find -exec is not read-only', {}, D, 'Bash', bash('find . -exec rm {} \\;'), 'ask'],
  ['R22 quoted glob for find is literal', {}, D, 'Bash', bash("find . -name '*.tmp'"), 'allow'],
  ['R23 a glob argument for ls is read-only', {}, D, 'Bash', bash('ls *.ts'), 'allow'],
  ['R24 cd inside cwd then ls is read-only', {}, D, 'Bash', bash('cd src && ls'), 'allow'],
  ['R25 cd outside cwd is not read-only', {}, D, 'Bash', bash('cd .. && ls'), 'ask'],
  ['R26 bare cd moves to the home directory', {}, D, 'Bash', bash('cd'), 'ask'],
  ['R27 sort is not in the read-only set', {}, D, 'Bash', bash('sort a b'), 'ask'],
  ['R28 sed is not in the read-only set', {}, D, 'Bash', bash('sed -n 1p f'), 'ask'],
  ['R29 mkdir is not read-only', {}, D, 'Bash', bash('mkdir tmp'), 'ask'],
  ['R30 npm is not read-only', {}, D, 'Bash', bash('npm test'), 'ask'],
  ['R31 a redirect makes the command non-read-only', {}, D, 'Bash', bash('ls > out.txt'), 'ask'],
  ['R32 PowerShell Get-ChildItem is read-only', {}, D, 'Bash', bash('Get-ChildItem'), 'allow'],
  ['R33 PowerShell alias gci is read-only', {}, D, 'Bash', bash('gci src'), 'allow'],
  ['R34 a PowerShell pipeline of read-only cmdlets', {}, D, 'Bash', bash('Get-ChildItem | Select-Object Name'), 'allow'],
  ['R35 Remove-Item is not read-only', {}, D, 'Bash', bash('Remove-Item x'), 'ask'],
  ['R36 a PowerShell redirect is not read-only', {}, D, 'Bash', bash('Get-Content a.txt > b.txt'), 'ask'],
  ['R37 ; separator with read-only parts', {}, D, 'Bash', bash('ls; cat x'), 'allow'],
  ['R38 newline separator with read-only parts', {}, D, 'Bash', bash('ls\npwd'), 'allow'],
  ['R39 git push is not read-only', {}, D, 'Bash', bash('git push origin main'), 'ask'],
  ['R40 Test-Path is read-only', {}, D, 'Bash', bash('Test-Path x'), 'allow'],
  ['R41 commands over 10000 characters are not read-only', {}, D, 'Bash', bash('ls ' + 'a '.repeat(5000)), 'ask'],
  ['R42 a cd into another directory then git asks', {}, D, 'Bash', bash('cd src && git status'), 'ask'],
  ['R43 a no-op cd then git stays read-only', {}, D, 'Bash', bash('cd . && git status'), 'allow'],
  ['R44 which with a special flag asks', {}, D, 'Bash', bash('which -i node'), 'ask'],
  ['R45 a read-only command on a UNC path asks', {}, D, 'Bash', bash('ls \\\\server\\share'), 'ask'],
  ['R46 a read-only command on a /net path asks', {}, D, 'Bash', bash('cat /net/fileserver/notes.txt'), 'ask'],
  // --- plan mode: read-only commands run, everything else is denied ---
  ['P1 plan allows Read', {}, P, 'Read', { file_path: file('x.md') }, 'allow'],
  ['P2 plan allows read-only commands', {}, P, 'Bash', bash('ls'), 'allow'],
  ['P3 plan denies non-read-only commands', {}, P, 'Bash', bash('npm test'), 'plan'],
  ['P4 plan denies Write', {}, P, 'Write', { file_path: file('x.md'), content: 'x' }, 'plan'],
  ['P5 plan denies Edit', {}, P, 'Edit', { file_path: file('x.md') }, 'plan'],
  ['P6 plan denies MCP tools', {}, P, 'mcp__fixture__echo', {}, 'plan'],
  // --- deny/ask/allow precedence ---
  ['PR1 deny beats allow', { deny: ['Write'], allow: ['Edit(src/**)'] }, D, 'Write', { file_path: file('src', 'a'), content: 'x' }, 'deny'],
  ['PR2 allow beats the mode when ask targets another tool', { ask: ['Write(**)'], allow: ['Edit(src/**)'] }, D, 'Edit', { file_path: file('src', 'a') }, 'allow'],
  ['PR3 ask beats allow', { ask: ['Edit(**)'], allow: ['Edit(src/**)'] }, D, 'Edit', { file_path: file('src', 'a') }, 'ask'],
  ['PR4 deny beats ask', { deny: ['Edit(src/**)'], ask: ['Edit(**)'] }, D, 'Edit', { file_path: file('src', 'a') }, 'deny'],
  ['PR5 a blocking hook beats allow', { allow: ['Bash(*)'], preToolUse: [hookBlock] }, D, 'Bash', bash('ls'), 'hookrefuse'],
  ['PR6 a hook allow does not beat an ask rule', { ask: ['Bash(npm test *)'], preToolUse: [hookAllow] }, D, 'Bash', bash('npm test'), 'ask'],
  ['PR7 bypassPermissions still applies deny', { deny: ['Write'] }, B, 'Write', { file_path: file('a'), content: 'x' }, 'deny'],
  ['PR8 bypassPermissions still applies ask', { ask: ['Edit'] }, B, 'Edit', { file_path: file('a') }, 'ask'],
  ['PR9 bypassPermissions applies no mode approval', {}, B, 'Edit', { file_path: file('a') }, 'allow'],
  ['PR10 rules mode runs unmatched commands silently', {}, R, 'Bash', bash('npm test'), 'allow'],
  // --- Hook decisions against rules and modes ---
  ['PR11 a hook allow suppresses the mode baseline', { preToolUse: [hookAllow] }, D, 'Bash', bash('npm test'), 'allow'],
  ['PR12 a hook allow cannot lift the plan restriction', { preToolUse: [hookAllow] }, P, 'Bash', bash('npm test'), 'plan'],
  ['PR13 deny beats a hook allow', { deny: ['Bash(npm test *)'], preToolUse: [hookAllow] }, R, 'Bash', bash('npm test'), 'deny'],
  ['U1 a read-only updated input needs no prompt', { preToolUse: [hookUpdate('ls')] }, D, 'Bash', bash('npm test'), 'allow'],
  ['U2 the updated input can fall under a deny rule', { deny: ['Bash(rm *)'], preToolUse: [hookUpdate('rm x')] }, R, 'Bash', bash('ls'), 'deny'],
  ['U3 the updated input can fall under an ask rule', { ask: ['Bash(rm *)'], preToolUse: [hookUpdate('rm x')] }, D, 'Bash', bash('ls'), 'ask'],
  ['U4 an allow-updated input still goes through the auto review', { preToolUse: [hookUpdateAllow('npm run build')] }, AUTO, 'Bash', bash('npm test'), 'auto'],
  ['U5 plan re-checks the updated input (read-only runs)', { preToolUse: [hookUpdate('ls')] }, P, 'Bash', bash('npm test'), 'allow'],
  ['U6 plan denies an updated non-read-only input', { preToolUse: [hookUpdate('npm test')] }, P, 'Bash', bash('ls'), 'plan'],
  ['U7 an allow rule covers the updated input', { allow: ['Bash(npm run *)'], preToolUse: [hookUpdate('npm run build')] }, D, 'Bash', bash('git push origin main'), 'allow'],
  // --- acceptEdits and auto modes ---
  ['M1 acceptEdits auto-approves Edit', {}, A, 'Edit', { file_path: file('a') }, 'allow'],
  ['M2 acceptEdits auto-approves read-only commands', {}, A, 'Bash', bash('ls'), 'allow'],
  ['M3 acceptEdits still asks for other commands', {}, A, 'Bash', bash('npm test'), 'ask'],
  ['M4 acceptEdits auto-approves Read', {}, A, 'Read', { file_path: file('a') }, 'allow'],
  ['M5 an allow rule resolves before the auto classifier', { allow: ['Bash(npm test *)'] }, AUTO, 'Bash', bash('npm test'), 'allow'],
  ['M6 uncovered commands go to the auto classifier', {}, AUTO, 'Bash', bash('npm run build'), 'auto'],
  ['M7 read-only commands skip the auto classifier', {}, AUTO, 'Bash', bash('ls'), 'allow'],
];
for (const [name, policy, mode, tool, input, want] of cases) await row(name, policy, mode, tool, input, want);

// --- Hook result contract: the checked input and context travel with the result ---
await writeFile(path.join(dir, 'hook-ctx.mjs'), `let body = ''; for await (const part of process.stdin) body += part;
  const event = JSON.parse(body);
  console.log(JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'ls', cwd: event.tool_input?.cwd }, additionalContext: ['ctx-1', 'ctx-2'] } }));`);
{
  const decisions = [];
  const check = policyCheck({ preToolUse: [{ tool: 'Bash', command: process.execPath, args: [path.join(dir, 'hook-ctx.mjs')] }] }, dir, undefined, 'default', async (kind, event) => { decisions.push([kind, event]); });
  const out = await check('Bash', bash('npm test'));
  assert.deepEqual(out.input, { command: 'ls' });
  assert.deepEqual(out.context, ['ctx-1', 'ctx-2']);
  assert.equal(decisions.length, 0);
}
{
  // A hook cannot replace the executed code.
  const replCheck = policyCheck({ preToolUse: [{ tool: '*', command: process.execPath, args: [path.join(dir, 'hook-update.mjs'), 'ls'] }] }, dir, undefined, 'default', () => {});
  await assert.rejects(replCheck('REPL', { code: '1 + 1' }), /cannot update the executed code/);
}
{
  // Auto mode: a hook-changed input is not covered by the code review and
  // forces a fresh decision carrying the changed-input flag.
  const autoDecisions = [];
  const check = policyCheck({ preToolUse: [hookUpdate('npm run build')] }, dir, undefined, 'auto', async (kind, event) => { autoDecisions.push([kind, event]); });
  await check('Bash', bash('git push origin main'));
  assert.equal(autoDecisions.length, 1);
  assert.equal(autoDecisions[0][0], 'autoTool');
  assert.equal(autoDecisions[0][1].tool_input.command, 'npm run build');
  assert.equal(autoDecisions[0][1].inputChangedByHook, true);
  // An unchanged, hook-allowed input stays covered by the review.
  const unchanged = [];
  const plain = policyCheck({ preToolUse: [hookAllow] }, dir, undefined, 'auto', async (kind, event) => { unchanged.push([kind, event]); });
  await plain('Bash', bash('npm run build'));
  assert.equal(unchanged.length, 0);
}

// --- policy validation ---
const validation = [
  ['an allow entry must be a string', { allow: [1] }, /allow/],
  ['an allow tool-name glob needs a literal mcp__server__ prefix', { allow: ['*'] }, /mcp__server__/],
  ['an allow tool-name glob cannot glob the server', { allow: ['mcp__*'] }, /mcp__server__/],
  ['an allow mcp server rule is valid', { allow: ['mcp__fixture__*'] }, null],
  ['a negation pattern is rejected, not reinterpreted', { deny: ['Read(!.env)'] }, /negat/i],
  ['a Write(path) extension rule is valid', { deny: ['Write(src/**)'] }, null],
  ['a policy.hooks object maps to the flat hook lists', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: process.execPath, args: [path.join(dir, 'hook-allow.mjs')] }] }] } }, null],
  ['policy.hooks cannot mix with preToolUse', { hooks: { PreToolUse: [] }, preToolUse: [hookBlock] }, /either/],
  ['an unknown policy.hooks key is rejected', { hooks: { PostToolUse: [] } }, /PreToolUse and UserPromptSubmit/],
];
for (const [name, policy, want] of validation) {
  let error;
  try { policyCheck(policy, dir, undefined, 'rules'); } catch (e) { error = e; }
  const got = error?.message;
  if (want === null ? error !== undefined : got === undefined || !want.test(got)) {
    failures += 1; console.error(`FAIL validation ${name}: got ${got ?? 'no error'}, want ${want}`);
  }
}

// --- read-only statement semantics ---
const ro = command => commandIsReadOnly(command, dir);
const readOnlyCases = [
  ['ls -la', true], ['echo \'a; b\'', true], ['cd . && ls', true], ['cd src && ls', true],
  ['cd .. && ls', false], ['cd', false], ['git status', true], ['git log -5', true],
  ['git commit -m x', false], ['git -c a=b status', false], ['git push origin main', false],
  ['find . -name x.tmp', true], ['find . -name *.tmp', false], ['find . -delete', false], ['find . -exec rm {} \\;', false],
  ['find . -name "*.tmp"', true], ["find . -name '*.tmp'", true], ['ls *.ts', true],
  ['sort a b', false], ['sed -n 1p f', false], ['mkdir x', false], ['npm test', false],
  ['ls > out.txt', false], ['cat f < in', false], ['Get-ChildItem | Select-Object Name', true],
  ['gci src', true], ['Get-Content a.txt > b.txt', false], ['Remove-Item x', false],
  ['ls; cat x', true], ['ls\npwd', true], ['Test-Path x', true], ['date', false],
  ['cd src && git status', false], ['cd . && git status', true], ['which -a node', true], ['which -i node', false],
  ['ls \\\\server\\share', false], ['cat /net/fileserver/notes.txt', false],
  ['ls ' + 'a '.repeat(5000), false], ['npm test &&', false], ['$(ls)', false],
];
for (const [command, want] of readOnlyCases) {
  const got = ro(command);
  if (got !== want) { failures += 1; console.error(`FAIL read-only ${JSON.stringify(command.slice(0, 40))}: expected ${want}, got ${got}`); }
}
assert.deepEqual(commandSegments(`cd 'app' && git push origin main`), [`cd 'app'`, 'git push origin main']);

await rm(path.join(home, 'rules-home-file.md'), { force: true });
if (failures) throw new Error(`${failures} rule matrix rows failed`);
console.log('PASS: rule-tool-input-decision matrix (native schema alignment, allow/deny/ask precedence, read-only commands, path patterns)');
await rm(dir, { recursive: true, force: true });
