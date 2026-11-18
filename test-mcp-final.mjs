import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "3p-final-test",
  version: "1.0.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server-v0.3.mjs"],
  cwd: process.cwd()
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map(t => t.name);

  console.log("TOOLS:", names);

  if (!names.includes("code_execute") ||
      !names.includes("search_context")) {
    throw new Error("Required MCP tools missing");
  }

  const response = await client.callTool({
    name: "search_context",
    arguments: {
      root: "C:\\MyCourses\\EnTici",
      query: "AppDbContext",
      scope: "source",
      maxFiles: 3,
      contextLines: 4
    }
  });

  if (response.isError) {
    throw new Error(response.content[0]?.text ?? "MCP tool error");
  }

  const result = JSON.parse(response.content[0].text);

  console.log("VERSION:", result.version);
  console.log("FILES:", result.returnedFiles);
  console.log("DURATION:", result.durationMs, "ms");
  console.log("FIRST:", result.files[0]?.file);

  if (result.version !== "0.3.3") {
    throw new Error("Unexpected version");
  }

  console.log("PASS MCP integration");
} finally {
  await client.close();
}
