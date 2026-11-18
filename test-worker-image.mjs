import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { workerImageInputs, workerImageTag } from './worker-image.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), '3p-image-test-'));
try {
  for (const file of workerImageInputs) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), await readFile(new URL(file, import.meta.url)));
  }
  const original = await workerImageTag();
  assert.equal(await workerImageTag(dir), original);
  for (const file of workerImageInputs) {
    const target = path.join(dir, file), contents = await readFile(target);
    await writeFile(target, Buffer.concat([contents, Buffer.from('\nchanged')]));
    assert.notEqual(await workerImageTag(dir), original, `${file} must invalidate the image`);
    await writeFile(target, contents);
  }
  // The manifest must cover every Dockerfile COPY input.
  const dockerfile = await readFile(new URL('worker-image/Dockerfile', import.meta.url), 'utf8');
  for (const line of dockerfile.split('\n').filter(line => line.startsWith('COPY '))) {
    for (const file of line.trim().split(/\s+/).slice(1, -1)) assert.ok(workerImageInputs.includes(file), `${file} missing from image manifest`);
  }
  console.log('PASS: image fingerprint changes for every build input, reproducible across paths');
} finally { await rm(dir, { recursive: true, force: true }); }
