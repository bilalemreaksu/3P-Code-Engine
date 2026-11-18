import { previewPatch } from "./patch-preview-v0.4.mjs";
import { readFile } from "node:fs/promises";

const file =
  "C:\\MyCourses\\EnTici\\Core.Persistence\\Context\\AppDbContext.cs";

const content = await readFile(file, "utf8");
const oldText = "AppDbContext";
const newText = "AppDbContextPreviewTest";

const result = await previewPatch({
  file,
  oldText,
  newText
}).catch(error => ({
  error: error.message
}));

console.log(JSON.stringify(result, null, 2));
