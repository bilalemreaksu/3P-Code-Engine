import { randomUUID } from "node:crypto";
import {
  mkdir, writeFile, readFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { previewPatch } from "./patch-preview-v0.4.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QUEUE = path.join(HERE, ".patch-requests");

const TTL_MS = 15 * 60 * 1000;

export async function createPatchRequest({
  file,
  oldText,
  newText
}) {
  const preview = await previewPatch({
    file,
    oldText,
    newText
  });

  if (!preview.changed || preview.applied !== false) {
    throw new Error("Invalid preview state");
  }

  const id = randomUUID();
  const now = Date.now();

  const request = {
    id,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
    file: preview.file,
    originalSha256: preview.originalSha256,
    updatedSha256: preview.updatedSha256,
    oldText,
    newText,
    unifiedDiff: preview.unifiedDiff,
    diffTruncated: preview.diffTruncated
  };

  await mkdir(QUEUE, {
    recursive: true
  });

  const target = path.join(QUEUE, id + ".json");

  await writeFile(
    target,
    JSON.stringify(request, null, 2),
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    }
  );

  return {
    id,
    status: request.status,
    file: request.file,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    originalSha256: request.originalSha256,
    updatedSha256: request.updatedSha256,
    unifiedDiff: request.unifiedDiff,
    diffTruncated: request.diffTruncated,
    applied: false
  };
}

export async function getPatchRequest(id) {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(id)
  ) {
    throw new Error("Invalid request ID");
  }

  const target = path.join(QUEUE, id + ".json");
  const request = JSON.parse(
    await readFile(target, "utf8")
  );

  if (Date.now() > Date.parse(request.expiresAt)) {
    return {
      ...request,
      status: "expired"
    };
  }

  return request;
}
