import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "3p-engine-test",
  version: "1.0.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server.mjs"],
  cwd: process.cwd()
});

try {
  await client.connect(transport);

  const tools = await client.listTools();

  console.log("TOOLS:", tools.tools.map(t => t.name));

  const result = await client.callTool({
    name: "code_execute",
    arguments: {
      root: "C:\\MyCourses\\EnTici",
      patterns: ["SalesController", "DbContext"]
    }
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
