import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool('echo', { inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: 'text', text: message }] }));
server.registerTool('hook_check', {
  inputSchema: { hook_event_name: z.string(), source: z.string().optional(), prompt: z.string().optional(), mode: z.string().optional() },
}, async event => {
  if (event.mode === 'hang') await new Promise(resolve => setTimeout(resolve, 20000));
  if (event.mode === 'error') return { isError: true, content: [{ type: 'text', text: 'hook failure' }] };
  if (event.mode === 'invalid') return { content: [{ type: 'text', text: 'invalid-json' }] };
  return { content: [{ type: 'text', text: JSON.stringify(event.prompt?.includes('withheld-secret') ? { decision: 'block', reason: 'MCP output policy' } : {}) }] };
});
await server.connect(new StdioServerTransport());
