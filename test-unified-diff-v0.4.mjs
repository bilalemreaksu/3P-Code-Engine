import { unifiedDiff } from "./unified-diff-v0.4.mjs";

const before = [
  "using Core.Domain.Entities;",
  "public class Example",
  "{",
  "    public int Value => 1;",
  "}"
].join("\n") + "\n";

const after = before.replace(
  "public int Value => 1;",
  "public int Value => 2;"
);

const result = await unifiedDiff(before, after);

console.log(result.diff);
console.log("TRUNCATED:", result.truncated);

if (
  !result.diff.includes("-    public int Value => 1;") ||
  !result.diff.includes("+    public int Value => 2;") ||
  !result.diff.includes("@@")
) {
  throw new Error("Unified diff verification failed");
}

console.log("PASS unified_diff");
