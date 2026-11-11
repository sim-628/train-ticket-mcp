// No new test dependency: compile isolated core modules, then use Node's built-in test runner.
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'train-ticket-mcp-test-'));
const localTsc = resolve(root, 'node_modules/typescript/bin/tsc');
let status = 1;
try {
  const args = ['--strict', '--target', 'ES2022', '--module', 'commonjs', '--lib', 'ES2022,DOM',
    '--outDir', out, 'src/types.ts', 'src/firecrawl.ts', 'src/flight-browser.ts', 'src/flights.ts', 'src/parser.ts'];
  const compile = existsSync(localTsc)
    ? spawnSync(process.execPath, [localTsc, ...args], { cwd: root, stdio: 'inherit' })
    : spawnSync('tsc', args, { cwd: root, stdio: 'inherit' });
  if (compile.status !== 0) throw new Error('Core TypeScript compilation failed; install project dependencies first.');
  writeFileSync(join(out, 'package.json'), '{"type":"commonjs"}');
  const tests = spawnSync(process.execPath, ['--test', 'test/flights.node.mjs'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, FLIGHT_TEST_BUILD: out }
  });
  status = tests.status ?? 1;
} finally { rmSync(out, { recursive: true, force: true }); }
process.exitCode = status;
