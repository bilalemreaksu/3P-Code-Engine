import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "3p-security-test",
  version: "1.0.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server-v0.2.mjs"],
  cwd: process.cwd()
});

const tests = [
  {
    name: "Outside directory",
    operations: [{
      type: "search",
      root: "C:\\Windows",
      pattern: "Microsoft"
    }]
  },
  {
    name: "Outside file",
    operations: [{
      type: "read",
      file: "C:\\Windows\\win.ini"
    }]
  },
  {
    name: "Too many operations",
    operations: Array.from({length: 11}, () => ({
      type: "search",
      root: "C:\\MyCourses\\EnTici",
      pattern: "DbContext"
    }))
  },
  {
    name: "Invalid read limit",
    operations: [{
      type: "read",
      file: "C:\\MyCourses\\EnTici\\README.md",
      lineCount: 1000
    }]
  }
];

try {
  await client.connect(transport);

  let failures = 0;

  for (const test of tests) {
    const response = await client.callTool({
      name: "code_execute",
      arguments: { operations: test.operations }
    });

    let rejected = Boolean(response.isError);

    if (!rejected) {
      const data = JSON.parse(response.content[0].text);
      rejected = data.results?.some(r => !r.success);
    }

    console.log(
      `${rejected ? "PASS" : "FAIL"}: ${test.name}`
    );

    if (!rejected) failures++;
  }

  if (failures) process.exitCode = 1;
} finally {
  await client.close();
}
