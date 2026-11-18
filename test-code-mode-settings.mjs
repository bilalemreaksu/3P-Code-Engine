import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const dir = await mkdtemp(path.join(process.cwd(), 'code-mode-settings-test-'));
const dataDir = path.join(dir, 'state');
process.env.CODE_MODE_DATA_DIR = dataDir;
process.env.CODE_MODE_POLICY_PATH = path.join(dir, 'policy.json');
process.env.CODE_MODE_ISOLATION = 'off';
process.env.CODE_MODE_APPROVAL_TIMEOUT_MS = '1500';
process.env.CODE_MODE_PERMISSION_MODE = 'rules';
await writeFile(process.env.CODE_MODE_POLICY_PATH, '{}');
const { settingsPath, loadSettings, isProjectEnabled, setProjectEnabled, projectKey } = await import('./code-mode-settings.mjs');

try {
  // The trusted user setting lives beside the execution data, never in the
  // project. A missing file means the feature is off everywhere.
  assert.equal(settingsPath(dataDir), path.join(dataDir, 'settings.json'));
  assert.deepEqual(await loadSettings(dataDir), { enabled: {} });
  await assert.rejects(setProjectEnabled(dataDir, 'relative-path'), /absolute/);

  // Enabling is explicit and persisted; the initial state check is per project.
  await setProjectEnabled(dataDir, dir);
  const stored = JSON.parse(await readFile(settingsPath(dataDir), 'utf8'));
  assert.equal(stored.version, 1);
  assert.ok(Object.values(stored.enabled).includes(true));
  assert.equal(isProjectEnabled(await loadSettings(dataDir), dir), true);
  // path.sep: a trailing backslash is a separator on Windows but a literal
  // file-name character on POSIX; the platform's own separator is the honest
  // cross-platform form of "same project".
  assert.equal(isProjectEnabled(await loadSettings(dataDir), dir + path.sep), true, 'trailing separator is the same project');
  assert.equal(path.join(dataDir, 'settings.json') === settingsPath(dataDir), true);

  // Disabling removes the project; re-enabling restores it.
  await setProjectEnabled(dataDir, dir, false);
  assert.deepEqual(await loadSettings(dataDir), { enabled: {} });
  await setProjectEnabled(dataDir, dir);
  assert.equal(isProjectEnabled(await loadSettings(dataDir), dir), true);

  // Corrupted or foreign settings fail closed with a clear reason — they must
  // not silently enable or disable anything.
  await writeFile(settingsPath(dataDir), '{not json');
  await assert.rejects(loadSettings(dataDir), /settings are corrupted/);
  await writeFile(settingsPath(dataDir), JSON.stringify({ version: 99, enabled: {} }));
  await assert.rejects(loadSettings(dataDir), /settings are corrupted/);
  await writeFile(settingsPath(dataDir), JSON.stringify({ version: 1, enabled: 'nope' }));
  await assert.rejects(loadSettings(dataDir), /settings are corrupted/);
  // A corrupted file is not silently rewritten: even an explicit enablement
  // fails closed until the user repairs the record.
  await assert.rejects(setProjectEnabled(dataDir, dir), /settings are corrupted/);
  await writeFile(settingsPath(dataDir), JSON.stringify({ version: 1, enabled: {} }));
  await setProjectEnabled(dataDir, dir);
  assert.equal(isProjectEnabled(await loadSettings(dataDir), dir), true);

  // ---- Manager integration: the initial state check gates every surface ----
  const { startExecution, resumeSession, dataDir: managerDataDir } = await import('./execution-manager.mjs');
  assert.equal(managerDataDir, dataDir, 'the gate uses the same trusted data directory');
  // Fail-closed initial state: no trusted enablement → refused with a reason.
  await setProjectEnabled(dataDir, dir, false);
  await assert.rejects(startExecution({ cwd: dir, code: 'return 1' }), /not enabled for/);
  // An untrusted project file cannot enable the feature.
  await writeFile(path.join(dir, '.code-mode.json'), JSON.stringify({ enabled: true }));
  await assert.rejects(startExecution({ cwd: dir, code: 'return 1' }), /not enabled for/);
  // Explicit trusted enablement opens a new session.
  await setProjectEnabled(dataDir, dir);
  const fresh = await startExecution({ cwd: dir, code: 'return 41 + 1' });
  assert.equal((await fresh.promise).result, '42');
  // A session resumes while enabled; disabling the project blocks both
  // resume and continuation with the same clear reason; re-enabling restores.
  const sess = await startExecution({ cwd: dir, code: 'state.n = 1; return state.n', sessionId: 'settings-test', mode: 'rules', decide: () => {} });
  await sess.promise;
  assert.equal(resumeSession('settings-test').mode, 'rules');
  await setProjectEnabled(dataDir, dir, false);
  await assert.throws(() => resumeSession('settings-test'), /not enabled for/);
  await assert.rejects(startExecution({ cwd: dir, code: 'return state.n', sessionId: 'settings-test' }), /not enabled for/);
  await setProjectEnabled(dataDir, dir);
  const again = await startExecution({ cwd: dir, code: 'return state.n', sessionId: 'settings-test' });
  assert.equal((await again.promise).result, '1');
  // Corrupted settings fail closed even for an enabled project.
  await writeFile(settingsPath(dataDir), '{broken');
  await assert.rejects(startExecution({ cwd: dir, code: 'return 1' }), /settings are corrupted/);
  await writeFile(settingsPath(dataDir), JSON.stringify({ version: 1, enabled: { [projectKey(dir)]: true } }));
  // The same-permission-mode requirement on resume is relaxed: a different
  // effective mode continues the session instead of erroring, and the
  // session re-records the mode it ran with.
  process.env.CODE_MODE_PERMISSION_MODE = 'default';
  const relaxed = await startExecution({ cwd: dir, code: 'return state.n', sessionId: 'settings-test' });
  assert.equal((await relaxed.promise).result, '1');
  assert.equal(resumeSession('settings-test').mode, 'default', 'session re-records the effective mode');
  process.env.CODE_MODE_PERMISSION_MODE = 'rules';

  // ---- Terminal agent resume: marker validation with clear reasons ----
  const { CodeModeAgent } = await import('./code-mode-agent.mjs');
  const endpoint = 'http://127.0.0.1:9/v1';
  const chatPath = id => path.join(dataDir, `chat-${createHash('sha256').update(id).digest('hex')}.json`);
  await assert.rejects(CodeModeAgent.resume('no-such-session', { endpoint, model: 'fixture' }), /Unknown Code Mode session/);
  await writeFile(chatPath('corrupt-sess'), '{broken');
  await assert.rejects(CodeModeAgent.resume('corrupt-sess', { endpoint, model: 'fixture' }), /corrupted \(invalid JSON\)/);
  await writeFile(chatPath('foreign-sess'), JSON.stringify({ version: 1, codeMode: false, id: 'foreign-sess', cwd: dir, mode: 'rules', messages: [], jobs: [] }));
  await assert.rejects(CodeModeAgent.resume('foreign-sess', { endpoint, model: 'fixture' }), /not a Code Mode session/);
  await writeFile(chatPath('old-sess'), JSON.stringify({ version: 9, codeMode: true, id: 'old-sess', cwd: dir, mode: 'rules', messages: [], jobs: [] }));
  await assert.rejects(CodeModeAgent.resume('old-sess', { endpoint, model: 'fixture' }), /unsupported version 9/);
  const agent = new CodeModeAgent({ endpoint, model: 'fixture', cwd: dir });
  await agent.save();
  await setProjectEnabled(dataDir, dir, false);
  await assert.rejects(CodeModeAgent.resume(agent.id, { endpoint, model: 'fixture' }), /not enabled for/);
  await setProjectEnabled(dataDir, dir);
  const resumedAgent = await CodeModeAgent.resume(agent.id, { endpoint, model: 'fixture' });
  assert.equal(resumedAgent.mode, 'rules');
  // An explicit --permission-mode at resume moves the session; it is no
  // longer a mismatch error.
  const movedAgent = await CodeModeAgent.resume(agent.id, { endpoint, model: 'fixture', permissionMode: 'default' });
  assert.equal(movedAgent.mode, 'default');
  await agent.close(); await resumedAgent.close(); await movedAgent.close();
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log('PASS: Code Mode enablement is a trusted user setting per project with fail-closed corruption handling');