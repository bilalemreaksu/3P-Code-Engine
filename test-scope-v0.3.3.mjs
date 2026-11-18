import { searchContext } from "./search-context-v0.3.mjs";

const root = "C:\\MyCourses\\EnTici";
let failures = 0;

function isTest(file) {
  return /(^|[\\/])(?:tests?|__tests__|[^\\/]+\.tests?)(?:[\\/]|$)/i
    .test(file) ||
    /(?:Tests?|Specs?)\.(?:cs|ts|tsx|js|jsx)$/i.test(file);
}

for (const scope of ["source", "tests", "all"]) {
  const result = await searchContext({
    root,
    query: "AppDbContext",
    scope,
    maxFiles: 5,
    contextLines: 4,
    maxOutputChars: 16000
  });

  const valid = result.files.length > 0 &&
    result.files.every(f =>
      scope === "all" ||
      (scope === "tests" ? isTest(f.file) : !isTest(f.file))
    );

  console.log(
    valid ? "PASS" : "FAIL",
    scope,
    "files:", result.files.length,
    "duration:", result.durationMs + "ms"
  );

  if (!valid) failures++;
}

process.exitCode = failures ? 1 : 0;
