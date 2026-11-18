import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";

const file =
  "C:\\MyCourses\\EnTici\\Core.Persistence\\Context\\AppDbContext.cs";

const before = await readFile(file);

const client = new Client({
  name: "3p-preview-integration-test",
  version: "1.0.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server-v0.4.mjs"],
  cwd: process.cwd()
});

let failures = 0;

async function check(name, args, validate) {
  try {
    const response = await client.callTool({
      name: "preview_patch",
      arguments: args
    });

    const payload = response.content.find(
      item => item.type === "text"
    )?.text ?? "";

    const valid = validate(response, payload);

    console.log(valid ? "PASS" : "FAIL", name);

    if (!valid) {
      console.log(payload.slice(0, 1000));
      failures++;
    }
  } catch (error) {
    console.log("FAIL", name, error.message);
    failures++;
  }
}

try {
  await client.connect(transport);

  await check(
    "Successful MCP preview",
    {
      file,
      oldText: "using Core.Domain.Entities;",
      newText: "using Core.Domain.Entities; /* PREVIEW ONLY */"
    },
    (response, payload) => {
      if (response.isError) return false;

      const result = JSON.parse(payload);

      return result.changed === true &&
        result.applied === false &&
        result.originalSha256 !== result.updatedSha256;
    }
  );

  await check(
    "Ambiguous replacement rejected",
    {
      file,
      oldText: "AppDbContext",
      newText: "ChangedContext"
    },
    (response, payload) =>
      response.isError === true &&
      payload.includes("Old text is not unique")
  );

  await check(
    "Outside project rejected",
    {
      file: "C:\\Windows\\win.ini",
      oldText: "fonts",
      newText: "changed"
    },
    (response, payload) =>
      response.isError === true &&
      payload.includes("outside allowed projects")
  );

  const after = await readFile(file);

  const unchanged = before.equals(after);

  console.log(
    unchanged ? "PASS" : "FAIL",
    "Original file unchanged"
  );

  if (!unchanged) failures++;

  console.log(
    "\nRESULT:",
    4 - failures,
    "/ 4 passed"
  );

  process.exitCode = failures ? 1 : 0;
} finally {
  await client.close();
}
