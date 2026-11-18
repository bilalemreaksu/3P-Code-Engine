import { getQuickJS } from 'quickjs-emscripten';
import { parse } from 'acorn';

const quoteArgument = process.platform === 'win32'
  ? function(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
  : function(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; };

// Parse statements rather than guessing semicolon boundaries (ASI, comments,
// templates and nested blocks must retain their normal JavaScript meaning).
export function completionBody(code) {
  const tree = parse(code, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
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
  const pump = () => {
    if (closed) return;
    const result = runtime.executePendingJobs();
    if (result.error) result.error.dispose();
  };
  const install = (name, callback) => {
    const handle = vm.newFunction(name, callback);
    vm.setProp(vm.global, name, handle); handle.dispose();
  };
  install('__call', (nameHandle, argsHandle) => {
    const name = vm.getString(nameHandle), args = JSON.parse(vm.getString(argsHandle));
    const deferred = vm.newPromise();
    pending.add(deferred);
    Promise.resolve().then(async () => {
      if (!Object.hasOwn(tools, name) || typeof tools[name] !== 'function') throw new Error('Unknown helper');
      return tools[name](...args);
    }).then(value => {
      if (closed) return;
      const handle = vm.newString(JSON.stringify(value ?? null));
      deferred.resolve(handle); handle.dispose();
    }, error => {
      if (closed) return;
      const handle = vm.newError({ name: error?.name || 'Error', message: error?.message || String(error) });
      deferred.reject(handle); handle.dispose();
    }).finally(() => {
      if (closed) return;
      pending.delete(deferred); deferred.dispose(); pump();
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
      deferred.resolve(); pending.delete(deferred); deferred.dispose(); pump();
    }, milliseconds);
    timers.add(timer);
    return deferred.handle;
  });
  const bootstrap = `
    const state = ${JSON.stringify(state)};
    const __bridge = __call, __logger = __log, __wait = __delay;
    delete globalThis.__call; delete globalThis.__log; delete globalThis.__delay;
    const tools = Object.create(null);
    for (const name of ['read','write','edit','run','callMcp','listMcpServers','listMcpTools']) {
      tools[name] = (...args) => __bridge(name, JSON.stringify(args)).then(JSON.parse);
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
      __wait(milliseconds).then(() => { if (__timers.delete(id)) callback(...args); });
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
  let promiseHandle, valueHandle;
  try {
    const compiled = completionBody(code);
    promiseHandle = vm.unwrapResult(vm.evalCode(`(async () => { ${bootstrap}\n const value = await __settle(await (async () => {\n${compiled}\n})()); return {value, state}; })()`, 'code-mode.js'));
    const resolved = vm.resolvePromise(promiseHandle);
    pump();
    valueHandle = vm.unwrapResult(await resolved);
    return vm.dump(valueHandle);
  } catch (error) {
    // QuickJSUnwrapError carries its entire context; never let that escape
    // into logs, transcripts or a host inspector.
    throw new Error(`${error.name || 'Error'}: ${error.message || String(error)}`);
  } finally {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    for (const deferred of pending) deferred.dispose();
    valueHandle?.dispose(); promiseHandle?.dispose();
    vm.dispose(); runtime.dispose();
  }
}
