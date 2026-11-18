import { unifiedDiff } from "./unified-diff-v0.4.mjs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOTS = [
  "C:\\MyCourses\\EnTici",
  "C:\\MyCourses\\VolApp"
];

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REPLACEMENT_BYTES = 256 * 1024;

function inside(file, root) {
  const relative = path.relative(
    root.toLowerCase(),
    file.toLowerCase()
  );

  return relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative)
    );
}

async function validateFile(file) {
  if (!path.isAbsolute(file)) {
    throw new Error("Absolute file path required");
  }

  const actual = await realpath(file);
  const roots = await Promise.all(
    ROOTS.map(root => realpath(root).catch(() => null))
  );

  if (!roots.some(root => root && inside(actual, root))) {
    throw new Error("File outside allowed projects");
  }

  const info = await stat(actual);

  if (!info.isFile() || info.size > MAX_FILE_BYTES) {
    throw new Error("Invalid file or size limit exceeded");
  }

  return actual;
}

function sha256(value) {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

export async function previewPatch({
  file,
  oldText,
  newText
}) {
  if (
    typeof oldText !== "string" ||
    typeof newText !== "string" ||
    !oldText.length ||
    oldText === newText
  ) {
    throw new Error("Invalid replacement");
  }

  if (
    Buffer.byteLength(oldText) > MAX_REPLACEMENT_BYTES ||
    Buffer.byteLength(newText) > MAX_REPLACEMENT_BYTES
  ) {
    throw new Error("Replacement too large");
  }

  const actual = await validateFile(file);

  const name = path.basename(actual).toLowerCase();

  const allowedExtensions = new Set([
    ".cs", ".ts", ".tsx", ".js", ".jsx",
    ".html", ".css", ".scss", ".razor",
    ".cshtml", ".sql"
  ]);

  if (!allowedExtensions.has(path.extname(actual).toLowerCase())) {
    throw new Error("File extension not allowed");
  }

  const parts = actual.toLowerCase().split(/[\\/]+/);

  if (parts.some(part => [
    ".git", ".vs", "node_modules", "bin", "obj",
    "dist", "build", ".ssh", ".aws"
  ].includes(part))) {
    throw new Error("Protected directory");
  }

  if (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === "appsettings.production.json" ||
    name === "appsettings.development.json" ||
    name === "secrets.json" ||
    /\.(pem|key|pfx|p12|jks|keystore)$/i.test(name)
  ) {
    throw new Error("Sensitive file blocked");
  }
  const originalBytes = await readFile(actual);
  const original = new TextDecoder("utf-8", {
    fatal: true
  }).decode(originalBytes);

  const first = original.indexOf(oldText);

  if (first === -1) {
    throw new Error("Old text not found");
  }

  if (original.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error("Old text is not unique");
  }

  const updated =
    original.slice(0, first) +
    newText +
    original.slice(first + oldText.length);

  if (Buffer.byteLength(updated) > MAX_FILE_BYTES) {
    throw new Error("Updated file exceeds size limit");
  }

  const diffResult = await unifiedDiff(original, updated);

  return {
    unifiedDiff: diffResult.diff,
    diffTruncated: diffResult.truncated,
    file: actual,
    originalSha256: sha256(originalBytes),
    updatedSha256: sha256(Buffer.from(updated)),
    oldText,
    newText,
    preview: {
      before: oldText,
      after: newText
    },
    changed: true,
    applied: false
  };
}
