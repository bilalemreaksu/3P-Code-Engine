import { realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const ROOTS = [
  "C:\\MyCourses\\EnTici",
  "C:\\MyCourses\\VolApp"
];

const MAX_CAPTURE = 2 * 1024 * 1024;
const MAX_CANDIDATES = 3000;
const MAX_INSPECT = 40;
const CONCURRENCY = 6;
const TIMEOUT = 15000;

export const searchContextSchema = {
  root: z.string(),
  query: z.string().min(1).max(300),
  scope: z.enum(["source", "tests", "all"]).default("source"),
  maxFiles: z.number().int().min(1).max(20).default(5),
  contextLines: z.number().int().min(0).max(20).default(8),
  maxOutputChars: z.number().int().min(1000).max(60000)
    .default(16000)
};

function inside(file, root) {
  const rel = path.relative(
    root.toLowerCase(), file.toLowerCase()
  );
  return rel === "" ||
    (rel !== ".." &&
     !rel.startsWith(".." + path.sep) &&
     !path.isAbsolute(rel));
}

function isTest(file) {
  return /(^|[\\/])(?:tests?|__tests__|[^\\/]+\.tests?)(?:[\\/]|$)/i
    .test(file) ||
    /(?:Tests?|Specs?)\.(?:cs|ts|tsx|js|jsx)$/i.test(file);
}

function rank(file, query, scope) {
  const name = path.basename(file).toLowerCase();
  const q = query.toLowerCase();
  const test = isTest(file);
  let score = 0;

  if (name === q + path.extname(name)) score += 100;
  if (name.startsWith(q + ".")) score += 100;
  else if (name.includes(q)) score += 35;

  if (scope === "source") score += test ? -100 : 100;
  if (scope === "tests") score += test ? 100 : -100;

  if (/[\\/]Core\.(?:Persistence|Application|Domain)[\\/]/i
      .test(file)) score += 12;

  if (/[\\/]Migrations[\\/]/i.test(file)) score -= 80;
  if (/\.g\.(cs|ts|js)$|\.generated\./i.test(file)) score -= 100;
  if (/ModelSnapshot\.cs$/i.test(file)) score -= 100;

  return score;
}

async function allowedRoot(input) {
  if (!path.isAbsolute(input)) {
    throw new Error("Absolute path required");
  }

  const actual = await realpath(input);
  if (!(await stat(actual)).isDirectory()) {
    throw new Error("Not a directory");
  }

  const allowed = await Promise.all(
    ROOTS.map(p => realpath(p).catch(() => null))
  );

  if (!allowed.some(p => p && inside(actual, p))) {
    throw new Error("Root outside allowed projects");
  }
  return actual;
}

const globs = [
  "-g", "*.{cs,ts,tsx,js,jsx,json,html,css}",
  "-g", "!**/.tmp/**",
  "-g", "!**/node_modules/**",
  "-g", "!**/bin/**",
  "-g", "!**/obj/**",
  "-g", "!**/dist/**",
  "-g", "!**/build/**",
  "-g", "!**/.claude/worktrees/**",
  "-g", "!**/.git/**"
];

function rg(args, cwd, maxBytes = MAX_CAPTURE) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn("rg", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const chunks = [];
    let size = 0;
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT);

    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });

    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString("utf8")).slice(-1000);
    });

    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut || overflow) {
        reject(new Error(
          timedOut ? "Search timeout" : "Search capture limit"
        ));
      } else if (code !== 0 && code !== 1) {
        reject(new Error("ripgrep failed: " + stderr));
      } else {
        resolve({
          text: Buffer.concat(chunks).toString("utf8"),
          durationMs: Math.round(performance.now() - started)
        });
      }
    });
  });
}

function parseContext(text, file, query) {
  const lines = new Map();
  let matches = 0;
  let definitions = 0;

  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }

    if (event.type !== "match" && event.type !== "context") {
      continue;
    }

    const number = event.data?.line_number;
    const value = event.data?.lines?.text;

    if (!Number.isInteger(number) || typeof value !== "string") {
      continue;
    }

    const match = event.type === "match";

    if (match) {
      matches++;
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const definition = new RegExp(
        "\\b(?:class|interface|record|struct|enum|type)\\s+" +
        escaped + "\\b", "i"
      );
      if (definition.test(value)) definitions++;
    }

    lines.set(number, {
      line: number,
      match,
      text: value.trimEnd().slice(0, 500)
    });
  }

  return {
    file,
    matches,
    definitions,
    lines: [...lines.values()].sort((a, b) => a.line - b.line)
  };
}

export async function searchContext(input) {
  const started = performance.now();
  const root = await allowedRoot(input.root);
  const scope = input.scope ?? "source";
  const maxFiles = input.maxFiles ?? 5;
  const contextLines = input.contextLines ?? 8;
  const maxOutputChars = input.maxOutputChars ?? 16000;

  // Phase 1: discover filenames without collecting code context.
  const discovery = await rg([
    "--files-with-matches",
    "--fixed-strings",
    "--ignore-case",
    "--no-messages",
    "--max-filesize", "1M",
    ...globs,
    "--", input.query, "."
  ], root);

  const candidates = discovery.text.split(/\r?\n/)
    .filter(Boolean)
    .map(p => path.resolve(root, p))
    .filter(p => inside(p, root))
    .filter(p =>
      scope === "all" ||
      (scope === "tests" ? isTest(p) : !isTest(p))
    )
    .slice(0, MAX_CANDIDATES)
    .sort((a, b) =>
      rank(b, input.query, scope) - rank(a, input.query, scope) ||
      a.localeCompare(b)
    );

  const inspected = [];
  let skippedUnsafePaths = 0;
  let contextDurationMs = 0;

  // Phase 2: bounded parallel inspection.
  const shortlist = candidates.slice(0, MAX_INSPECT);

  async function inspect(candidate) {
    try {
      const actual = await realpath(candidate);

      if (!inside(actual, root)) {
        return { unsafe: true };
      }

      const info = await stat(actual);
      if (!info.isFile() || info.size > 1024 * 1024) {
        return { unsafe: true };
      }

      const context = await rg([
        "--json",
        "--fixed-strings",
        "--ignore-case",
        "--max-count", "3",
        "--context", String(Math.min(contextLines, 8)),
        "--no-messages",
        "--max-filesize", "1M",
        "--", input.query, actual
      ], root, 256 * 1024);

      const item = parseContext(
        context.text, actual, input.query
      );

      if (item.matches === 0) {
        return { durationMs: context.durationMs };
      }

      item.score =
        rank(actual, input.query, scope) +
        Math.min(item.matches, 10) * 2 +
        item.definitions * 80;

      return {
        item,
        durationMs: context.durationMs
      };
    } catch (error) {
      return { error: String(error.message) };
    }
  }

  const failures = [];

  for (let i = 0; i < shortlist.length; i += CONCURRENCY) {
    const batch = shortlist.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(inspect));

    for (const result of results) {
      contextDurationMs += result.durationMs ?? 0;

      if (result.item) inspected.push(result.item);
      if (result.unsafe) skippedUnsafePaths++;
      if (result.error) failures.push(result.error);
    }
  }
  inspected.sort((a, b) =>
    b.score - a.score || a.file.localeCompare(b.file)
  );

  const files = inspected.slice(0, maxFiles);
  const result = {
    version: "0.3.3",
    query: input.query,
    scope,
    root,
    files,
    returnedFiles: files.length,
    candidateFiles: candidates.length,
    inspectedFiles: inspected.length,
    concurrency: CONCURRENCY,
    failedInspections: failures.length,
    truncated: candidates.length > files.length,
    skippedUnsafePaths,
    discoveryDurationMs: discovery.durationMs,
    contextDurationMs,
    durationMs: 0
  };

  function serialize() {
    result.durationMs = Math.round(performance.now() - started);
    return JSON.stringify(result);
  }

  let serialized = serialize();

  while (serialized.length > maxOutputChars && files.length) {
    const last = files.at(-1);
    if (last.lines.length > 1) last.lines.pop();
    else files.pop();

    result.truncated = true;
    result.returnedFiles = files.length;
    serialized = serialize();
  }

  if (serialized.length > maxOutputChars) {
    throw new Error("Output budget too small");
  }

  return result;
}
