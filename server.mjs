import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const ROOTS = [
  "C:\\MyCourses\\EnTici",
  "C:\\MyCourses\\VolApp"
];

const server = new McpServer({
  name: "3p-code-engine",
  version: "0.1.0"
});

async function searchFiles(root, pattern, limit = 20) {
  const base = await realpath(root);
  const allowed = await Promise.all(
    ROOTS.map(r => realpath(r).catch(() => null))
  );

  if (!allowed.some(r => r &&
      (base.toLowerCase() === r.toLowerCase() ||
       base.toLowerCase().startsWith(
         r.toLowerCase() + path.sep
       )))) {
    throw new Error("Project root not allowed");
  }

  const matches = [];
  const queue = [base];
  const ignored = new Set([
    "node_modules", ".git", "bin", "obj",
    ".next", "dist", "build"
  ]);

  while (queue.length && matches.length < limit) {
    const dir = queue.shift();
    const entries = await readdir(dir, {
      withFileTypes: true
    });

    for (const entry of entries) {
      if (matches.length >= limit) break;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) {
          queue.push(full);
        }
      } else if (entry.isFile()) {
        if (!/\.(cs|ts|tsx|js|jsx|json|html|css)$/i
            .test(entry.name)) continue;

        const content = await readFile(full, "utf8")
          .catch(() => "");

        if (content.toLowerCase()
            .includes(pattern.toLowerCase())) {
          matches.push(full);
        }
      }
    }
  }

  return matches;
}

server.tool(
  "code_execute",
  "Run multiple read-only project searches",
  {
    root: z.string(),
    patterns: z.array(z.string().min(1))
      .min(1).max(10)
  },
  async ({ root, patterns }) => {
    const results = await Promise.all(
      patterns.map(async pattern => ({
        pattern,
        files: await searchFiles(root, pattern)
      }))
    );

    return {
      content: [{
        type: "text",
        text: JSON.stringify(results, null, 2)
      }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
