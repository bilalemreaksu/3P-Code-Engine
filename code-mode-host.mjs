// Trusted container bridge. Never accept policy, mode, hook definitions,
// executable paths or permission verdicts from the untrusted worker.
import path from 'node:path';
import { policyCheck } from './code-mode-policy.mjs';
import { mcpDefinitions, withMcp } from './code-mode-mcp.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

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
        // REPL always uses the actual submitted code, never worker-supplied code.
        if (params.tool !== 'REPL') await check(params.tool, input);
        return null;
      }
      if (method === 'listMcpServers') return Object.keys(await mcpDefinitions());
      if (!name(params.server)) throw new Error('Invalid MCP server name');
      if (method === 'listMcpTools') {
        await check('McpListTools', { server: params.server });
        signal.throwIfAborted();
        return withMcp(params.server, client => client.listTools(undefined, { signal, timeout: 60000 }), signal);
      }
      if (!name(params.tool) || !object(params.args)) throw new Error('Invalid MCP tool arguments');
      // Check here immediately before dispatch; a forged RPC cannot bypass
      // deny/ask/hooks by skipping the worker's helper permission checks.
      await check(`mcp__${params.server}__${params.tool}`, params.args);
      signal.throwIfAborted();
      return withMcp(params.server, client => client.callTool({ name: params.tool, arguments: params.args }, undefined, { signal, timeout: 60000 }), signal);
    },
  };
}
