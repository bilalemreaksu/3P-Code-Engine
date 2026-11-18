import { previewPatch } from "./patch-preview-v0.4.mjs";
import { readFile } from "node:fs/promises";

const file =
  "C:\\MyCourses\\EnTici\\Core.Persistence\\Context\\AppDbContext.cs";

const before = await readFile(file);
const content = before.toString("utf8");

const lines = content.split(/\r?\n/);

const oldText = lines.find(line =>
  line.trim().length >= 15 &&
  content.indexOf(line) === content.lastIndexOf(line)
);

if (!oldText) {
  throw new Error("Unique test line not found");
}

const result = await previewPatch({
  file,
  oldText,
  newText: oldText + " /* PREVIEW ONLY */"
});

const after = await readFile(file);

console.log("VERSION: preview-v0.4");
console.log("FILE:", result.file);
console.log("CHANGED:", result.changed);
console.log("APPLIED:", result.applied);
console.log("HASH CHANGED:",
  result.originalSha256 !== result.updatedSha256
);
console.log("FILE UNCHANGED:", before.equals(after));
console.log("PREVIEW:", JSON.stringify(result.preview));

if (
  !result.changed ||
  result.applied ||
  !before.equals(after) ||
  result.originalSha256 === result.updatedSha256
) {
  throw new Error("Preview verification failed");
}

console.log("PASS preview_patch");
