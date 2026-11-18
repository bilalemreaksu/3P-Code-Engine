import {
  createPatchRequest,
  getPatchRequest
} from "./patch-request-v0.4.1.mjs";

import { readFile } from "node:fs/promises";

const file =
  "C:\\MyCourses\\EnTici\\Core.Persistence\\Context\\AppDbContext.cs";

const before = await readFile(file);

const result = await createPatchRequest({
  file,
  oldText: "using Core.Domain.Entities;",
  newText: "using Core.Domain.Entities; /* REQUEST TEST */"
});

console.log("REQUEST ID:", result.id);
console.log("STATUS:", result.status);
console.log("APPLIED:", result.applied);
console.log("EXPIRES:", result.expiresAt);

const stored = await getPatchRequest(result.id);

console.log("STORED STATUS:", stored.status);
console.log("HASH MATCH:",
  stored.originalSha256 === result.originalSha256
);

const after = await readFile(file);

if (
  result.status !== "pending" ||
  result.applied !== false ||
  stored.status !== "pending" ||
  !before.equals(after)
) {
  throw new Error("Patch request test failed");
}

console.log("FILE UNCHANGED:", before.equals(after));
console.log("PASS patch_request");
