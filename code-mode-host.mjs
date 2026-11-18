// Trusted container bridge. Never accept policy, mode, hook definitions,
// executable paths or permission verdicts from the untrusted worker.
import path from 'node:path';
import { policyCheck } from './code-mode-policy.mjs';
import { mcpDefinitions, withMcp } from './code-mode-mcp.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

// The container sees only the project mounted at /work; map a host path the
// hook may have produced back to the guest path the worker executes against.
// Paths outside the project are returned as-is: the container simply cannot
// see them, so the execution fails there instead of on the host.
const guestPath = (p, cwd) => {
  const host = path.resolve(p);
  if (host === cwd) return '/work';
  if (host.startsWith(cwd + path.sep)) return '/work/' + host.slice(cwd.length + 1).split(path.sep).join('/');
  return p;
};

export function createHostBridge({ policy, cwd, sessionId, mode, code, decide, signal }) {
  const check = policyCheck(policy, cwd, sessionId, mode, decide, signal);
  let repl;
  const ready = () => repl ??= check('REPL', { code });
  return {
    hasOutputHooks: check.hasOutputHooks,
    checkOutput: output => check.output(output),
    async request(method, params) {
      signal.throwIfAborted();
      if (!object(params) || Buffer.byteLength(JSON.stringify(params)) > 256 * 1024) throw new Error('Invalid host request arguments');
      if (!['checkTool', 'listMcpServers', 'listMcpTools', 'callMcp'].includes(method)) throw new Error('Unknown host request');
      await ready();
      signal.throwIfAborted();
      if (method === 'checkTool') {
        if (!['REPL', 'Read', 'Write', 'Edit', 'Bash'].includes(params.tool) || !object(params.input)) throw new Error('Invalid helper permission request');
        let input = params.input;
        if (params.tool !== 'REPL' && typeof input.file_path === 'string') {
          // The Docker worker reports guest /work paths; evaluate file rules
          // against the mounted project (the host cwd) they refer to.
          const guest = input.file_path.replace(/\\/g, '/');
          if (guest === '/work' || guest.startsWith('/work/')) {
            const rel = guest.slice('/work/'.length);
            input = { ...input, file_path: rel ? path.join(cwd, rel) : cwd };
          }
        }
        // REPL always uses the actual submitted code (checked in ready()),
        // never worker-supplied code.
        const { input: checked, context } = params.tool === 'REPL'
          ? { input, context: [] }
          : await check(params.tool, input);
        // A hook may have replaced the input; map the host-side paths it
        // carried back to the guest /work paths before returning them.
        let guestInput = checked;
        if (typeof checked.file_path === 'string') guestInput = { ...guestInput, file_path: guestPath(checked.file_path, cwd) };
        if (params.tool === 'Bash' && typeof checked.cwd === 'string') guestInput = { ...guestInput, cwd: guestPath(checked.cwd, cwd) };
        return { input: guestInput, context };
      }
      if (method === 'listMcpServers') return Object.keys(await mcpDefinitions());
      if (!name(params.server)) throw new Error('Invalid MCP server name');
      if (method === 'listMcpTools') {
        const { input } = await check('McpListTools', { server: params.server });
        if (typeof input?.server !== 'string' || !input.server) throw new Error('updated list input must carry a server name');
        signal.throwIfAborted();
        return withMcp(input.server, client => client.listTools(undefined, { signal, timeout: 60000 }), signal);
      }
      if (!name(params.tool) || !object(params.args)) throw new Error('Invalid MCP tool arguments');
      // Check here immediately before dispatch; a forged RPC cannot bypass
      // deny/ask/hooks by skipping the worker's helper permission checks.
      // A hook may replace the arguments; that replacement is what dispatches.
      const { input: mcpArgs } = await check(`mcp__${params.server}__${params.tool}`, params.args);
      if (!object(mcpArgs)) throw new Error('updated MCP arguments must be an object');
      signal.throwIfAborted();
      return withMcp(params.server, client => client.callTool({ name: params.tool, arguments: mcpArgs }, undefined, { signal, timeout: 60000 }), signal);
    },
  };
}
