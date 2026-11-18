import { searchContext } from "./search-context-v0.3.mjs";

const root = "C:\\MyCourses\\EnTici";
let failed = 0;

async function check(name, fn) {
  try {
    if (await fn()) {
      console.log("PASS", name);
    } else {
      console.log("FAIL", name);
      failed++;
    }
  } catch (error) {
    console.log("FAIL", name, error.message);
    failed++;
  }
}

await check("Outside root rejected", async () => {
  try {
    await searchContext({
      root: "C:\\Windows",
      query: "system"
    });
    return false;
  } catch {
    return true;
  }
});

await check("Traversal rejected", async () => {
  try {
    await searchContext({
      root: root + "\\..\\..\\Windows",
      query: "system"
    });
    return false;
  } catch {
    return true;
  }
});

await check("Output bounded", async () => {
  const result = await searchContext({
    root,
    query: "AppDbContext",
    scope: "source",
    maxFiles: 5,
    contextLines: 4,
    maxOutputChars: 5000
  });

  return JSON.stringify(result).length <= 5000;
});

await check("Correct definition ranked", async () => {
  const result = await searchContext({
    root,
    query: "AppDbContext",
    scope: "source",
    maxFiles: 5,
    contextLines: 4,
    maxOutputChars: 16000
  });

  return result.files[0]?.file.endsWith(
    "\\Core.Persistence\\Context\\AppDbContext.cs"
  ) === true;
});

console.log("\nRESULT:", 4 - failed, "/ 4 passed");
process.exitCode = failed ? 1 : 0;
