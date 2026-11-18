import assert from 'node:assert/strict';
import { evaluateCode, completionBody } from './code-mode-runtime.mjs';
import { policyCheck } from './code-mode-policy.mjs';

const messages=[];
let active=0, peak=0;
const tools={log:(...args)=>messages.push(args),read:async file=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,20));active--;return file;},run:async command=>({exitCode:0,stdout:command,stderr:'',timedOut:false})};
const run=code=>evaluateCode({code,tools});
assert.equal((await run('const value = 4\nvalue + 3 // ASI')).value,7);
assert.equal((await run('const text = `a;${2}`;\n({text, nested: Promise.resolve(8)})')).value.nested,8);
assert.equal((await run('const data = await Promise.all([read("a"), read("b")]); data.join(":")')).value,'a:b');
assert.equal(peak,2);
assert.equal((await run('await new Promise(resolve=>setTimeout(resolve,5)); state.count=3; state.count')).state.count,3);
assert.equal((await run('const id=setTimeout(()=>log("forgotten"),1000); clearTimeout(id); log("visible"); 1')).value,1);
assert.deepEqual(messages,[['visible']]);
assert.match(completionBody('const x=1\nx // ending'),/return \(x\)/);
// A syntax error in the generated code must be self-locating: the offending
// line plus a caret under the offending character, so the caller can fix the
// position without re-reading the whole code (windowed on very long lines).
{
  const problem = "const defter = 'anchor ok ' + dt + @JSFEYEAR";
  let failure;
  try { completionBody('const ok = 1;\n' + problem); } catch (error) { failure = error; }
  assert.ok(failure, 'completionBody must throw on a syntax error');
  assert.equal(failure.name, 'SyntaxError');
  const frame = failure.message.split('\n');
  const lineIdx = frame.findIndex(line => line.includes(problem));
  assert.ok(lineIdx > 0, `error message must carry the offending line:\n${failure.message}`);
  const shown = frame[lineIdx], caretLine = frame[lineIdx + 1];
  assert.ok(caretLine && caretLine.includes('^'), `a caret line must follow the offending line:\n${failure.message}`);
  assert.equal(caretLine.indexOf('^'), shown.indexOf(problem) + problem.indexOf('@'), 'caret must point under the offending character');
}
{
  const problem = `const s = '${'x'.repeat(300)}' + dt + @bad`;
  let failure;
  try { completionBody(problem); } catch (error) { failure = error; }
  assert.ok(failure, 'completionBody must throw on a syntax error in a long line');
  const frame = failure.message.split('\n');
  const lineIdx = frame.findIndex(line => line.includes('@bad'));
  assert.ok(lineIdx > 0, `long-line error must still carry the frame:\n${failure.message}`);
  assert.ok(frame[lineIdx].length < 400, `offending line must be windowed, was ${frame[lineIdx].length} chars`);
  assert.equal(frame[lineIdx + 1].indexOf('^'), frame[lineIdx].indexOf('@'), 'caret must point under the offending character on a windowed line');
}
await assert.rejects(run("const s = 'a' + @b"), error => error.message.includes('^') && error.message.includes('const s'), 'evaluateCode must surface the syntax frame');
for(const specimen of ['process.exit()','require("node:fs")','await import("node:fs/promises")','fetch("http://127.0.0.1/")','Function("return process")()','tools.read.constructor("return process")()','await __bridge("constructor", "[]")']) {
  await assert.rejects(run(specimen),undefined,specimen);
}
assert.deepEqual((await run('[typeof process,typeof require,typeof fetch,typeof Buffer]')).value,['undefined','undefined','undefined','undefined']);
await assert.rejects(evaluateCode({code:'while(true) {}',tools,timeoutMs:10}));
// A scoped deny still applies when the path is computed at runtime.
const check=policyCheck({deny:['Write(*.env)','Bash(git push:*)','mcp__private__*']},process.cwd(),undefined,'rules');
await assert.rejects(check('Write',{file_path:process.cwd()+'/.env'}),/policy denied/);
await assert.rejects(check('Bash',{command:"cd 'app' && git push origin main"}),/policy denied/);
await assert.rejects(check('mcp__private__delete',{}),/policy denied/);
await check('Bash',{command:"echo 'git push origin main'"});
console.log('PASS: WASM runtime blocks Node/prototype/import escapes, bounds CPU, preserves parallel calls, timers, ASI completion and scoped rules');
