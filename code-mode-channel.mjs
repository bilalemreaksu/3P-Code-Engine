// Worker transport. Locally the worker is a forked child with a Node IPC
// channel. In isolated (container) mode `docker run` provides plain stdio
// pipes instead, so the same JSON protocol travels line-delimited over
// stdin/stdout. Non-protocol lines (for example console.log output from
// user code) are ignored on both ends.
import readline from 'node:readline';

const stdio = process.env.CODE_MODE_WORKER_TRANSPORT === 'stdio';

export const send = (message, callback) => {
  if (!stdio) return process.send?.(message, callback);
  try { process.stdout.write(JSON.stringify(message) + '\n', callback); }
  catch (error) { callback?.(error); }
};

export const connected = () => (stdio ? process.stdout.writable : Boolean(process.connected));

export function onMessage(handler) {
  if (!stdio) { process.on('message', handler); return; }
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  input.on('line', line => {
    const text = line.trim();
    if (!text.startsWith('{')) return;
    try { handler(JSON.parse(text)); } catch { /* not a protocol line */ }
  });
}

export function disconnect() {
  if (stdio) return;
  if (process.connected) process.disconnect();
}
