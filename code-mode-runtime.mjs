import { getQuickJS } from 'quickjs-emscripten';
import { parse } from 'acorn';

const quoteArgument = process.platform === 'win32'
  ? function(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
  : function(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; };

// A syntax error in generated code must be self-locating: the message carries
// the offending line plus a caret under the offending character, so the caller
// can fix the position without re-reading the whole code. error.pos (a
// character offset) is the anchor — loc.line/column vary by parser.
const FRAME_WIDTH = 160;
function syntaxFrame(code, error) {
  if (!Number.isInteger(error.pos) || error.pos < 0 || error.pos > code.length) return '';
  const before = code.slice(0, error.pos);
  const lineStart = before.lastIndexOf('\n') + 1;
  const column = error.pos - lineStart;
  const raw = code.slice(lineStart).split('\n', 1)[0].replace(/\r$/, '');
  let shown = raw, offset = 0;
  if (shown.length > FRAME_WIDTH) {
    offset = Math.max(0, column - Math.floor(FRAME_WIDTH / 2));
    shown = shown.slice(offset, offset + FRAME_WIDTH);
  }
  const prefix = offset ? '... ' : '';
  const suffix = offset + shown.length < raw.length ? ' ...' : '';
  return `| ${prefix}${shown}${suffix}\n| ${prefix}${' '.repeat(column - offset)}^`;
}

// Parse statements rather than guessing semicolon boundaries (ASI, comments,
// templates and nested blocks must retain their normal JavaScript meaning).
export function completionBody(code) {
  let tree;
  try {
    tree = parse(code, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (error) {
    if (error instanceof SyntaxError) {
      const frame = syntaxFrame(code, error);
      if (frame) throw new SyntaxError(`${error.message}\n${frame}`, { cause: error });
    }
    throw error;
  }
  const last = tree.body.at(-1);
  if (last?.type !== 'ExpressionStatement') return code;
  return code.slice(0, last.start) + 'return (' + code.slice(last.expression.start, last.expression.end) + ');' + code.slice(last.end);
}

// Generated code lives in a separate WASM JavaScript heap. Only JSON crosses
// the boundary: no host functions, prototypes, Node globals or module loader.
export async function evaluateCode({ code, tools, state = {}, timeoutMs = 600000 }) {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const vm = runtime.newContext();
  let closed = false;
  const pending = new Set(), timers = new Set();
  // Every observable failure must reach the caller. Unhandled guest
  // rejections and OOMs inside pending jobs come back from
  // executePendingJobs; the deadline must fire even while the guest idles on
  // a helper (the WASM interrupt handler is only consulted while WASM code
  // runs); a non-serializable host result must reject the bridge instead of
  // crashing this process. `gate` carries the first such failure; `drain`
  // keeps the evaluation open until in-flight helper calls have settled, so
  // a late helper failure is not swallowed by an already-resolved main
  // promise.
  let failure;
  let gateReject;
  const gate = new Promise((_, reject) => { gateReject = reject; });
  gate.catch(() => {}); // a late gate rejection after success must not crash the host
  let mainSettled = false, bridges = 0;
  let drainResolve;
  const drain = new Promise(resolve => { drainResolve = resolve; });
  const drainCheck = () => { if (mainSettled && bridges === 0) drainResolve(); };
  const fail = message => gateReject(new Error(message));
  const deadlineTimer = setTimeout(() => fail(`Execution timed out after ${timeoutMs} ms`), timeoutMs);
  const pump = () => {
    if (closed) return;
    let result;
    try { result = runtime.executePendingJobs(); }
    catch (error) { fail(`QuickJS job execution failed: ${error?.message || String(error)}`); return; }
    if (!result.error) { drainCheck(); return; }
    // The error handle is a guest value: read its name and message, then
    // release it — never let a QuickJSUnwrapError carrying the context
    // escape into logs or a host inspector.
    let message = 'Unknown QuickJS job error';
    try { vm.unwrapResult(result); }
    catch (error) { message = `${error.name || 'Error'}: ${error.message || String(error)}`; }
    result.error.dispose();
    fail(message);
    drainCheck();
  };
  const install = (name, callback) => {
    const handle = vm.newFunction(name, callback);
    vm.setProp(vm.global, name, handle); handle.dispose();
  };
  install('__call', (nameHandle, argsHandle) => {
    const name = vm.getString(nameHandle), args = JSON.parse(vm.getString(argsHandle));
    const deferred = vm.newPromise();
    pending.add(deferred); bridges += 1;
    Promise.resolve().then(async () => {
      if (!Object.hasOwn(tools, name) || typeof tools[name] !== 'function') throw new Error('Unknown helper');
      return tools[name](...args);
    }).then(value => {
      if (closed) return;
      let handle;
      try {
        // The host result crosses the boundary as JSON. A value stringify
        // cannot render (BigInt, cycles) must reject the evaluation with a
        // reason, not crash the host with an unhandled rejection; a value it
        // renders as undefined (functions, symbols) crosses as null.
        handle = vm.newString(JSON.stringify(value ?? null) ?? 'null');
      } catch (error) {
        fail(`Result serialization failed: ${error?.message || String(error)}`);
        return;
      }
      deferred.resolve(handle); handle.dispose();
    }, error => {
      if (closed) return;
      try {
        const handle = vm.newError({ name: error?.name || 'Error', message: error?.message || String(error) });
        deferred.reject(handle); handle.dispose();
      } catch {
        // The context may already be dead (OOM); the host still has to
        // report the helper failure.
        fail(`Helper "${name}" failed: ${error?.message || String(error)}`);
      }
    }).finally(() => {
      if (closed) return;
      bridges -= 1;
      pending.delete(deferred); deferred.dispose(); pump(); drainCheck();
    });
    return deferred.handle;
  });
  install('__log', args => { tools.log(...JSON.parse(vm.getString(args))); return vm.undefined; });
  install('__delay', duration => {
    const milliseconds = vm.getNumber(duration);
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 7200000) throw new Error('Invalid timer duration');
    const deferred = vm.newPromise(); pending.add(deferred);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (closed) return;
      deferred.resolve(); pending.delete(deferred); deferred.dispose(); pump(); drainCheck();
    }, milliseconds);
    timers.add(timer);
    return deferred.handle;
  });
  const bootstrap = `
    const state = ${JSON.stringify(state)};
    const __bridge = __call, __logger = __log, __wait = __delay;
    delete globalThis.__call; delete globalThis.__log; delete globalThis.__delay;
    // QuickJS does not report unhandled promise rejections: a rejected helper
    // promise the code never observes is invisible to executePendingJobs. So
    // every bridge call records its rejection reason and whether user code
    // ever reacted to the promise (then/catch/finally/await); the host checks
    // the registry once the evaluation has drained.
    const __track = globalThis.__track = new Map();
    let __trackId = 0;
    const __tracked = (name, bridge) => {
      const rec = { observed: false, reason: null };
      __track.set(++__trackId, rec);
      bridge.then(() => {}, error => { rec.reason = name + ': ' + ((error && error.message) || String(error)); });
      const p = bridge.then(JSON.parse);
      const observe = fn => function(...a) { rec.observed = true; return fn.apply(p, a); };
      const wrapped = {};
      wrapped.then = observe(p.then);
      wrapped.catch = observe(p.catch);
      wrapped.finally = observe(p.finally);
      return wrapped;
    };
    const tools = Object.create(null);
    for (const name of ['read','write','edit','run','callMcp','listMcpServers','listMcpTools']) {
      tools[name] = (...args) => __tracked(name, __bridge(name, JSON.stringify(args)));
    }
    const { read, write, edit, run, callMcp, listMcpServers, listMcpTools } = tools;
    const log = (...args) => __logger(JSON.stringify(args));
    tools.log = log;
    Object.assign(tools, {Read:read, Write:write, Edit:edit, Bash:run});
    Object.freeze(tools);
    let __timerId = 0;
    const __timers = new Map();
    const setTimeout = (callback, milliseconds = 0, ...args) => {
      const id = ++__timerId; __timers.set(id, true);
      __wait(milliseconds).then(() => {
        if (!__timers.delete(id)) return;
        try { callback(...args); }
        catch (error) { __track.set(++__trackId, { observed: false, reason: 'setTimeout callback: ' + ((error && error.message) || String(error)) }); }
      });
      return id;
    };
    const clearTimeout = id => __timers.delete(id);
    const console = Object.freeze({log, info:log, warn:log, error:log});
    const __quote = (${quoteArgument.toString()});
    function $(strings, ...values) {
      const command = strings.reduce((out, part, i) => out + part + (i < values.length ? __quote(values[i]) : ''), '');
      const promise = run(command);
      const checked = () => promise.then(result => { if (result.exitCode !== 0 || result.timedOut) throw new Error('Command failed (' + result.exitCode + '): ' + result.stderr); return result; });
      return {text:() => checked().then(result => result.stdout), nothrow:() => promise, then:(resolve,reject) => checked().then(resolve,reject)};
    }
    async function __settle(value, seen = new WeakSet(), depth = 0) {
      value = await value;
      if (!value || typeof value !== 'object' || depth >= 6 || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) return value;
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      const entries = await Promise.all(Object.entries(value).slice(0,100).map(async ([key,item]) => [key,await __settle(item,seen,depth+1)]));
      return Array.isArray(value) ? entries.map(([,item]) => item) : Object.fromEntries(entries);
    }
  `;
  // A helper failure or timer-callback error that the generated code never
  // observed would otherwise vanish: the evaluation must fail with it. All
  // guest microtasks have been pumped to a fixpoint by the time the drain
  // resolves, so the registry's observed flags are final here.
  const reportUnhandled = () => {
    const handle = vm.unwrapResult(vm.evalCode('JSON.stringify([...globalThis.__track.values()].filter(r => !r.observed && r.reason).map(r => r.reason))', 'code-mode-unhandled.js'));
    const reasons = JSON.parse(vm.dump(handle) ?? '[]');
    handle.dispose();
    if (reasons.length) throw new Error(reasons.join(' | '));
  };
  let promiseHandle, valueHandle;
  try {
    const compiled = completionBody(code);
    promiseHandle = vm.unwrapResult(vm.evalCode(`(async () => { ${bootstrap}\n const value = await __settle(await (async () => {\n${compiled}\n})()); return {value, state}; })()`, 'code-mode.js'));
    const resolved = vm.resolvePromise(promiseHandle);
    pump();
    // The main promise may settle while a helper is still in flight; the
    // evaluation only succeeds once those have settled too (or the deadline
    // or a job error settles the gate first).
    const settled = await Promise.race([resolved, gate]);
    mainSettled = true;
    drainCheck();
    await Promise.race([drain, gate]);
    reportUnhandled();
    valueHandle = vm.unwrapResult(settled);
    return vm.dump(valueHandle);
  } catch (error) {
    // Guest rejection, job error, serialization failure or deadline:
    // surface the reason; QuickJSUnwrapError carries its entire context and
    // must never escape into logs, transcripts or a host inspector.
    failure = error;
    throw new Error(`${error.name || 'Error'}: ${error.message || String(error)}`);
  } finally {
    closed = true;
    clearTimeout(deadlineTimer);
    for (const timer of timers) clearTimeout(timer);
    for (const deferred of pending) { try { deferred.dispose(); } catch {} }
    for (const handle of [valueHandle, promiseHandle]) { try { handle?.dispose(); } catch {} }
    try {
      vm.dispose(); runtime.dispose();
    } catch (error) {
      // An OOM-corrupted runtime can fail to free cleanly; the real failure
      // was already reported, so cleanup must not mask it. A clean run must
      // always dispose without error.
      if (!failure) throw error;
    }
  }
}
