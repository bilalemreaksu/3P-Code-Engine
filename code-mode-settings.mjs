import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { readFileSync as readFileSyncSync } from 'node:fs';
import path from 'node:path';

// Code Mode enablement is a trusted USER setting, kept beside the execution
// data (CODE_MODE_DATA_DIR, a user-level directory). It is deliberately NOT
// read from the project directory: an untrusted project file can never turn
// the feature on. Each project path is enabled explicitly; a missing file
// means the feature is off everywhere (fail-closed initial state).

export const settingsPath = dir => path.join(dir, 'settings.json');

// Windows paths are case-insensitive; normalize keys so `C:\App` and
// `c:\app` are the same project.
export const projectKey = cwd => {
  const resolved = path.resolve(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function parseSettings(raw, dir) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`Code Mode settings are corrupted (invalid JSON: ${error.message}); refusing to start (fail closed). Fix or delete ${settingsPath(dir)}.`); }
  let detail;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) detail = 'the top level must be an object';
  else if (parsed.version !== 1) detail = `unsupported version ${String(parsed.version)}`;
  else if (parsed.enabled !== undefined && (!parsed.enabled || typeof parsed.enabled !== 'object' || Array.isArray(parsed.enabled))) detail = 'enabled must be an object of project paths';
  if (detail) throw new Error(`Code Mode settings are corrupted (${detail}); refusing to start (fail closed). Fix or delete ${settingsPath(dir)}.`);
  return { enabled: { ...(parsed.enabled ?? {}) } };
}

export function loadSettingsSync(dir) {
  let raw;
  try { raw = readFileSyncSync(settingsPath(dir), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: {} }; throw error; }
  return parseSettings(raw, dir);
}

export async function loadSettings(dir) {
  let raw;
  try { raw = await readFile(settingsPath(dir), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: {} }; throw error; }
  return parseSettings(raw, dir);
}

export function isProjectEnabled(settings, cwd) {
  return settings.enabled[projectKey(cwd)] === true;
}

// The single initial-state check used by every surface: a project must be
// enabled in the trusted settings; a corrupted file fails closed.
export function assertProjectEnabled(dir, cwd) {
  if (!isProjectEnabled(loadSettingsSync(dir), cwd)) {
    throw new Error(`Code Mode is not enabled for ${cwd}. Enable it in the trusted user settings (settings.json in CODE_MODE_DATA_DIR, e.g. terminal: --enable --cwd <path>); a project file cannot enable Code Mode.`);
  }
}

// Same transient-failure handling as the session save: a rename can hit
// EPERM while the target is locked, or ENOENT when the temp file vanishes.
// Each attempt uses a fresh temp; the budget is bounded.
async function atomicWrite(target, text) {
  for (let delay = 150; ; delay *= 2) {
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, target);
      return;
    } catch (error) {
      await rm(temp, { force: true });
      if (!['EPERM','EACCES','EBUSY','ENOENT'].includes(error.code) || delay > 1200) throw error;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

export async function setProjectEnabled(dir, cwd, enabled = true) {
  if (!path.isAbsolute(cwd)) throw new Error('Project path must be absolute');
  const settings = await loadSettings(dir); // corruption fails closed before any write
  const key = projectKey(cwd);
  if (enabled) settings.enabled[key] = true;
  else delete settings.enabled[key];
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicWrite(settingsPath(dir), JSON.stringify({ version: 1, enabled: settings.enabled }, null, 1));
}
