import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "3p-v03-test",
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
  console.log("TOOLS:", tools.tools.map(t => t.name));

  const response = await client.callTool({
    name: "search_context",
    arguments: {
      root: "C:\\MyCourses\\EnTici",
      query: "AppDbContext",
      maxFiles: 5,
      contextLines: 8,
      maxOutputChars: 16000
    }
  });

  if (response.isError) {
    throw new Error(response.content[0].text);
  }

  const data = JSON.parse(response.content[0].text);

  console.log("VERSION:", data.version);
  console.log("DURATION:", data.durationMs, "ms");
  console.log("FILES:", data.returnedFiles);
  console.log("CANDIDATES:", data.candidateFiles);
  console.log("TRUNCATED:", data.truncated);
  console.log("UNSAFE SKIPPED:", data.skippedUnsafePaths);

  for (const file of data.files) {
    console.log(
      file.file,
      "matches:", file.matches,
      "lines:", file.lines.length
    );
  }
} finally {
  await client.close();
}
