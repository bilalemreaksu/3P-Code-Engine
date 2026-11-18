import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "ranking-test",
  version: "1.0.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server-v0.3.mjs"],
  cwd: process.cwd()
});

try {
  await client.connect(transport);

  for (const scope of ["source", "tests", "all"]) {
    const response = await client.callTool({
      name: "search_context",
      arguments: {
        root: "C:\\MyCourses\\EnTici",
        query: "AppDbContext",
        scope,
        maxFiles: 5,
        contextLines: 4,
        maxOutputChars: 16000
      }
    });

    if (response.isError) {
      console.log(scope, "ERROR:", response.content[0].text);
      continue;
    }

    const data = JSON.parse(response.content[0].text);

    console.log("\nSCOPE:", scope);
    console.log("VERSION:", data.version);
    console.log("DURATION:", data.durationMs, "ms");
    console.log("CANDIDATES:", data.candidateFiles);
    console.log("INSPECTED:", data.inspectedFiles);

    for (const f of data.files) {
      console.log({
        file: f.file,
        score: f.score,
        matches: f.matches,
        definitions: f.definitions
      });
    }
  }
} finally {
  await client.close();
}
