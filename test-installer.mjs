import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('SKIP: Windows installer test');
} else {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const dir = await mkdtemp(path.join(os.tmpdir(), '3p-install-test-'));
  const config = path.join(dir, 'desktop config.json');
  try {
    await writeFile(config, JSON.stringify({ extra: 'preserved', mcpServers: { other: { command: 'other' }, '3p-code-engine-reader': { command: 'old-reader' }, '3p-code-mode': { command: 'old', env: { EXISTING: 'preserved' } } } }));
    const install = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'install-code-mode.ps1'), '-ConfigPath', config, '-NodePath', process.execPath, '-ModelEndpoint', 'http://127.0.0.1:1234/v1', '-ModelName', 'local-model'], { cwd: root, encoding: 'utf8', windowsHide: true });
    install(); install();
    const after = JSON.parse(await readFile(config, 'utf8'));
    assert.equal(after.extra, 'preserved');
    assert.equal(after.mcpServers.other.command, 'other');
    assert.equal(Object.hasOwn(after.mcpServers, '3p-code-engine-reader'), false);
    assert.equal(after.mcpServers['3p-code-mode'].command.toLowerCase(), process.execPath.toLowerCase());
    assert.equal(after.mcpServers['3p-code-mode'].args[0], path.join(root, 'server-code-mode.mjs'));
    assert.equal(after.mcpServers['3p-code-mode'].env.EXISTING, 'preserved');
    assert.equal(after.mcpServers['3p-code-mode'].env.REVIEW_MODEL_NAME, 'local-model');
    assert.equal(after.mcpServers['3p-code-mode'].env.CODE_MODE_MCP_CONFIG_PATH, config);
    assert.equal((await readdir(dir)).filter(name => name.includes('.backup-code-mode-')).length, 2);
    const local = path.join(dir, 'local'), roaming = path.join(dir, 'roaming');
    await mkdir(path.join(local, 'Claude-3p'), { recursive: true });
    await mkdir(path.join(roaming, 'Claude'), { recursive: true });
    const autoConfig = path.join(local, 'Claude-3p', 'claude_desktop_config.json');
    await writeFile(autoConfig, '{"otherSetting":true}');
    const env = { ...process.env, LOCALAPPDATA: local, APPDATA: roaming };
    const autoArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'install-code-mode.ps1'), '-NodePath', process.execPath];
    execFileSync('powershell.exe', autoArgs, { cwd: root, env, stdio: 'pipe', windowsHide: true });
    assert.equal(JSON.parse(await readFile(autoConfig, 'utf8')).otherSetting, true);
    assert.ok(JSON.parse(await readFile(autoConfig, 'utf8')).mcpServers['3p-code-mode']);
    await writeFile(path.join(roaming, 'Claude', 'claude_desktop_config.json'), '{}');
    assert.throws(() => execFileSync('powershell.exe', autoArgs, { cwd: root, env, stdio: 'pipe', windowsHide: true }));
    console.log('PASS: portable installer, existing configuration, model settings and backups');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
