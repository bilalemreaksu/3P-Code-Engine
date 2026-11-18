import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "3p-v04-test",
  version: "1.0.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server-v0.4.mjs"],
  cwd: process.cwd()
});

try {
  await client.connect(transport);

  const response = await client.listTools();
  const names = response.tools.map(tool => tool.name);

  console.log("MCP TOOLS:", names);

  for (const required of [
    "code_execute",
    "search_context",
    "preview_patch"
  ]) {
    if (!names.includes(required)) {
      throw new Error("Missing tool: " + required);
    }
  }

  console.log("PASS v0.4 MCP tool registration");
} finally {
  await client.close();
}
