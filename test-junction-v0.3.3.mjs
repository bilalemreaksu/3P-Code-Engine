import { searchContext } from "./search-context-v0.3.mjs";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(tmpdir(), "3p-security-"));
const external = path.join(temp, "outside");
const link = "C:\\MyCourses\\EnTici\\3p-security-link";

try {
  await mkdir(external);
  await writeFile(
    path.join(external, "Outside.cs"),
    "class SecurityProbeOutside {}\n"
  );

  try {
    await symlink(external, link, "junction");
  } catch (error) {
    console.log("SKIP junction creation:", error.message);
    process.exitCode = 2;
    process.exit();
  }

  const result = await searchContext({
    root: "C:\\MyCourses\\EnTici",
    query: "SecurityProbeOutside",
    scope: "all",
    maxFiles: 5
  });

  const leaked = result.files.some(
    f => f.file.toLowerCase().includes("outside")
  );

  console.log(
    leaked ? "FAIL junction escape" : "PASS junction escape"
  );

  if (leaked) process.exitCode = 1;
} finally {
  await rm(link, { force: true }).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
