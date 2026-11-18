import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "3p-v02-test",
  version: "1.0.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server-v0.2.mjs"],
  cwd: process.cwd()
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map(t => t.name));

  const result = await client.callTool({
    name: "code_execute",
    arguments: {
      operations: [
        {
          type: "search",
          root: "C:\\MyCourses\\EnTici",
          pattern: "DbContext",
          limit: 30
        },
        {
          type: "search",
          root: "C:\\MyCourses\\EnTici",
          pattern: "SalesController",
          limit: 30
        },
        {
          type: "search",
          root: "C:\\MyCourses\\EnTici",
          pattern: "IServiceCollection",
          limit: 30
        }
      ]
    }
  });

  const data = JSON.parse(result.content[0].text);

  console.log("VERSION:", data.version);
  console.log("DURATION MS:", data.durationMs);

  for (const item of data.results) {
    console.log({
      pattern: item.pattern,
      success: item.success,
      count: item.result?.returned,
      truncated: item.result?.truncated,
      error: item.error
    });
  }
} finally {
  await client.close();
}
