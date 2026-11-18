import { spawn } from "node:child_process";
import {
  mkdtemp, writeFile, rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_DIFF_CHARS = 16000;

export async function unifiedDiff(before, after) {
  if (typeof before !== "string" ||
      typeof after !== "string") {
    throw new Error("Text inputs required");
  }

  const dir = await mkdtemp(
    path.join(tmpdir(), "3p-diff-")
  );

  const oldFile = path.join(dir, "before.txt");
  const newFile = path.join(dir, "after.txt");

  try {
    await writeFile(oldFile, before, "utf8");
    await writeFile(newFile, after, "utf8");

    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "--no-pager",
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--",
          oldFile,
          newFile
        ],
        {
          windowsHide: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"]
        }
      );

      let text = "";
      let bytes = 0;
      let overflow = false;
      let stderr = "";

      child.stdout.on("data", chunk => {
        bytes += chunk.length;

        if (bytes > 1024 * 1024) {
          overflow = true;
          child.kill();
          return;
        }

        text += chunk.toString("utf8");
      });

      child.stderr.on("data", chunk => {
        stderr += chunk.toString("utf8").slice(0, 1000);
      });

      child.on("error", reject);

      child.on("close", code => {
        if (overflow) {
          reject(new Error("Diff output too large"));
        } else if (code === 0 || code === 1) {
          resolve(text);
        } else {
          reject(new Error("Git diff failed: " + stderr));
        }
      });
    });

    const lines = output.split(/\r?\n/);

    const normalized = lines.map(line => {
      if (line.startsWith("diff --git ")) {
        return "diff --git a/source b/source";
      }
      if (line.startsWith("--- ")) {
        return "--- a/source";
      }
      if (line.startsWith("+++ ")) {
        return "+++ b/source";
      }
      return line;
    }).join("\n");

    return {
      diff: normalized.slice(0, MAX_DIFF_CHARS),
      truncated: normalized.length > MAX_DIFF_CHARS
    };
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
}
