import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { loadCodePolicy } from './code-mode-policy.mjs';

// The bundled policy is the default for every surface (MCP server, terminal,
// docker worker) that does not set CODE_MODE_POLICY_PATH. VolApp's VDB
// guardrails (AGENTS.md: no DDL on any VDB* database, read-only diagnosis)
// must live here as explicit deny rules, not in prose.
const dir = await mkdtemp(path.join(process.cwd(), 'code-mode-policy-test-'));
const configuredPolicy = process.env.CODE_MODE_POLICY_PATH;
try {
  delete process.env.CODE_MODE_POLICY_PATH;
  const check = await loadCodePolicy(dir, undefined, 'bypassPermissions');
  // Deny blocks in every mode, including bypassPermissions (the live surface mode).
  for (const command of [
    'sqlcmd -S localhost -d VDB_AKSU01 -Q "ALTER TABLE Sales ADD COLUMN Note NVARCHAR(100)"',
    'sqlcmd -S localhost -Q "ALTER TABLE Sales ADD COLUMN Note NVARCHAR(100)" -d VDB_TEST01',
    'sqlcmd -S localhost -Q "DROP TABLE dbo.Legacy" -d VDB_TEST01',
    'sqlcmd -S localhost -d VDB_URUNGO01 -Q "CREATE TABLE Audit (Id INT)"',
    'sqlcmd -S localhost -d VDB_TEST02 -Q "TRUNCATE TABLE Staging"',
  ]) {
    await assert.rejects(check('Bash', { command }), /policy denied/, command);
  }
  // Legitimate VolApp flows stay open: read-only diagnosis on the test DB,
  // dotnet test, and code search that only mentions a DDL keyword.
  for (const command of [
    'sqlcmd -S localhost -d VDB_TEST01 -Q "SELECT TOP 10 * FROM Sales"',
    'dotnet test tests/VolApp.Tests --filter Category=Integration',
    'git grep "ALTER TABLE" src',
  ]) {
    await check('Bash', { command });
  }
  console.log('PASS: bundled policy denies VDB DDL in bypassPermissions and leaves test/inspect flows open');
} finally {
  if (configuredPolicy === undefined) delete process.env.CODE_MODE_POLICY_PATH; else process.env.CODE_MODE_POLICY_PATH = configuredPolicy;
  await rm(dir, { recursive: true, force: true });
}
