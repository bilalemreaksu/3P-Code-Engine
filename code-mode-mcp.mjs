import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function mcpDefinitions() {
  const desktop = process.env.CODE_MODE_MCP_CONFIG_PATH
    ? JSON.parse(await readFile(process.env.CODE_MODE_MCP_CONFIG_PATH, 'utf8')).mcpServers || {} : {};
  const merged = { ...desktop, ...JSON.parse(process.env.CODE_MODE_MCP_SERVERS || '{}') };
  delete merged['3p-code-mode'];
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value && !value.disabled && typeof value.command === 'string'));
}

export async function withMcp(serverName, callback, signal) {
  const definitions = await mcpDefinitions();
  if (typeof serverName !== 'string' || !Object.hasOwn(definitions, serverName)) throw new Error('MCP server is not configured');
  const config = definitions[serverName];
  if (!Array.isArray(config.args || [])) throw new Error('Invalid MCP server configuration');
  const client = new Client({ name: '3p-code-mode-bridge', version: '0.10.0' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args || [], ...(config.cwd ? { cwd: config.cwd } : {}), env: { ...getDefaultEnvironment(), ...(config.env || {}) }, stderr: 'ignore' });
  const abort = () => { void client.close().catch(() => {}); };
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await client.connect(transport);
    signal?.throwIfAborted();
    return await callback(client);
  } finally {
    signal?.removeEventListener('abort', abort);
    await client.close();
  }
}
