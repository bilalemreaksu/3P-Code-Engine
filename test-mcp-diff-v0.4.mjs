import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "3p-diff-test",
  version: "1.0.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server-v0.4.mjs"],
  cwd: process.cwd()
});

try {
  await client.connect(transport);

  const response = await client.callTool({
    name: "preview_patch",
    arguments: {
      file: "C:\\MyCourses\\EnTici\\Core.Persistence\\Context\\AppDbContext.cs",
      oldText: "using Core.Domain.Entities;",
      newText: "using Core.Domain.Entities; /* PREVIEW ONLY */"
    }
  });

  if (response.isError) {
    throw new Error(response.content[0]?.text);
  }

  const result = JSON.parse(response.content[0].text);

  console.log("APPLIED:", result.applied);
  console.log("DIFF TRUNCATED:", result.diffTruncated);
  console.log("DIFF:");
  console.log(result.unifiedDiff);

  if (
    result.applied !== false ||
    !result.unifiedDiff?.includes("@@") ||
    !result.unifiedDiff.includes("-using Core.Domain.Entities;") ||
    !result.unifiedDiff.includes(
      "+using Core.Domain.Entities; /* PREVIEW ONLY */"
    )
  ) {
    throw new Error("MCP unified diff verification failed");
  }

  console.log("PASS MCP unified_diff");
} finally {
  await client.close();
}
