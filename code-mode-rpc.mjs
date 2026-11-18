// Container -> trusted host requests. Only results cross this channel;
// MCP configuration, credentials and policy stay in the host process.
import { randomUUID } from 'node:crypto';
import { send, onMessage } from './code-mode-channel.mjs';

const pending = new Map();
onMessage(message => {
  const entry = pending.get(message?.rpcId);
  if (!entry) return;
  pending.delete(message.rpcId);
  if (message.ok === true) entry.resolve(message.value);
  else entry.reject(new Error(message.error || 'Host request failed'));
});

export function requestHost(method, params = {}) {
  if (pending.size >= 64) return Promise.reject(new Error('Too many concurrent host requests'));
  const rpcId = randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(rpcId, { resolve, reject });
    send({ rpcId, method, params }, error => {
      if (!error) return;
      pending.delete(rpcId);
      reject(error);
    });
  });
}
