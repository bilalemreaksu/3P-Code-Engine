import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
// Keep this manifest in sync with the Dockerfile COPY inputs. Include the
// recipe, ignore rules and lockfile so dependency/build changes invalidate it.
export const workerImageInputs = [
  'worker-image/Dockerfile', '.dockerignore', 'package.json', 'package-lock.json',
  'code-mode-worker.mjs', 'code-mode-policy.mjs', 'code-mode-channel.mjs',
  'code-mode-hooks.mjs', 'code-mode-mcp.mjs', 'code-mode-rpc.mjs', 'code-mode-runtime.mjs', 'code-mode-rules.mjs',
];
export async function workerImageTag(directory = root) {
  const hash = createHash('sha256');
  for (const file of workerImageInputs) {
    const bytes = await readFile(path.join(directory, file));
    hash.update(`${file}\0${bytes.length}\0`).update(bytes);
  }
  return `3p-code-engine-worker:${hash.digest('hex')}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await workerImageTag());
}
