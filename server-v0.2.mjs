import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpath, stat, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

const VERSION = "0.2.0";

const ROOTS = [
  "C:\\MyCourses\\EnTici",
  "C:\\MyCourses\\VolApp"
];

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINES = 100;
const MAX_MATCHES = 100;
const MAX_OPERATIONS = 10;
const TIMEOUT_MS = 15000;
const MAX_RG_BYTES = 1024 * 1024;

const server = new McpServer({
  name: "3p-code-engine",
  version: VERSION
});

const sameOrChild = (p, root) => {
  const relative = path.relative(
    root.toLowerCase(),
    p.toLowerCase()
  );
  return relative === "" ||
    (relative !== ".." &&
     !relative.startsWith(".." + path.sep) &&
     !path.isAbsolute(relative));
};

async function safePath(input) {
  if (!path.isAbsolute(input)) {
    throw new Error("Absolute path required");
  }

  const resolved = await realpath(input);

  const allowed = await Promise.all(
    ROOTS.map(r => realpath(r).catch(() => null))
  );

  if (!allowed.some(r => r && sameOrChild(resolved, r))) {
    throw new Error("Path outside allowed projects");
  }

  return resolved;
}

function runRg(root, pattern, limit) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const args = [
      "--files-with-matches",
      "--fixed-strings",
      "--ignore-case",
      "--no-messages",
      "--hidden",
      "--glob", "!.git/**",
      "--glob", "!.tmp/**",
      "--glob", "!**/node_modules/**",
      "--glob", "!**/bin/**",
      "--glob", "!**/obj/**",
      "--glob", "!**/dist/**",
      "--glob", "!**/build/**",
      "--glob", "!**/.claude/worktrees/**",
      "--glob", "*.cs",
      "--glob", "*.ts",
      "--glob", "*.tsx",
      "--glob", "*.js",
      "--glob", "*.jsx",
      "--glob", "*.json",
      "--glob", "*.html",
      "--glob", "*.css",
      "--max-filesize", "1M",
      "--",
      pattern,
      "."
    ];

    const child = spawn("rg", args, {
      cwd: root,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);

    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_RG_BYTES) {
        overflow = true;
        child.kill();
        return;
      }
      output += chunk.toString("utf8");
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8").slice(0, 2000);
    });

    child.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut || overflow) {
        return reject(new Error(
          timedOut ? "Search timeout" : "Search output limit"
        ));
      }

      if (code !== 0 && code !== 1) {
        return reject(new Error(
          "ripgrep failed: " + stderr.slice(0, 500)
        ));
      }

      const all = output.split(/\r?\n/).filter(Boolean);
      const selected = all.slice(0, limit);

      resolve({
        files: selected.map(p => path.resolve(root, p)),
        returned: selected.length,
        truncated: all.length > limit,
        durationMs: Math.round(performance.now() - started)
      });
    });
  });
}

async function search(root, pattern, limit) {
  const safeRoot = await safePath(root);
  const info = await stat(safeRoot);

  if (!info.isDirectory()) {
    throw new Error("Search root must be a directory");
  }

  const result = await runRg(safeRoot, pattern, limit);

  // Resolve every returned path again before exposing it.
  const safeFiles = [];
  let skipped = 0;

  for (const file of result.files) {
    try {
      safeFiles.push(await safePath(file));
    } catch {
      skipped++;
    }
  }

  return {
    ...result,
    files: safeFiles,
    returned: safeFiles.length,
    skippedUnsafePaths: skipped
  };
}

async function readLines(file, startLine, lineCount) {
  const started = performance.now();
  const safeFile = await safePath(file);
  const info = await stat(safeFile);

  if (!info.isFile()) {
    throw new Error("Not a regular file");
  }

  if (info.size > MAX_FILE_BYTES) {
    throw new Error("File exceeds 1 MiB");
  }

  const content = await readFile(safeFile, "utf8");
  const lines = content.split(/\r?\n/);

  const selected = lines
    .slice(startLine - 1, startLine - 1 + lineCount)
    .map((text, index) => ({
      line: startLine + index,
      text: text.slice(0, 1000)
    }));

  return {
    file: safeFile,
    totalLines: lines.length,
    lines: selected,
    durationMs: Math.round(performance.now() - started)
  };
}

const operationSchema = z.object({
  type: z.enum(["search", "read"]),
  root: z.string().optional(),
  pattern: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(MAX_MATCHES)
    .default(30),
  file: z.string().optional(),
  startLine: z.number().int().min(1).default(1),
  lineCount: z.number().int().min(1).max(MAX_LINES)
    .default(40)
});

server.tool(
  "code_execute",
  "Execute multiple safe read-only code operations",
  {
    operations: z.array(operationSchema)
      .min(1).max(MAX_OPERATIONS)
  },
  async ({ operations }) => {
    const started = performance.now();
    const results = [];

    for (const op of operations) {
      try {
        let result;

        if (op.type === "search") {
          if (!op.root || !op.pattern) {
            throw new Error("root and pattern required");
          }
          result = await search(
            op.root, op.pattern, op.limit
          );
        } else {
          if (!op.file) {
            throw new Error("file required");
          }
          result = await readLines(
            op.file, op.startLine, op.lineCount
          );
        }

        results.push({
          type: op.type,
          pattern: op.pattern,
          success: true,
          result
        });
      } catch (err) {
        results.push({
          type: op.type,
          pattern: op.pattern,
          success: false,
          error: err.message
        });
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          version: VERSION,
          durationMs: Math.round(
            performance.now() - started
          ),
          operationCount: operations.length,
          results
        }, null, 2)
      }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
