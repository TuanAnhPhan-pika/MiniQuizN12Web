const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const testFiles = [
  'tests/unit/auth.unit.test.js',
  'tests/unit/room.unit.test.js',
  'tests/integration/auth.integration.test.js',
  'tests/integration/room.integration.test.js',
  'tests/integration/storage.integration.test.js',
  'tests/e2e/auth.e2e.test.js',
];

console.log('==============================================================');
console.log('  MiniQuizN12Web - Bo kiem thu Thuc hanh 5 (Unit + Int + E2E) ');
console.log('  DB Test: SQLite in-memory (node:sqlite) | E2E: Playwright   ');
console.log('==============================================================\n');

const result = spawnSync(
  process.execPath,
  ['--no-warnings', '--test', '--test-reporter=spec', ...testFiles],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', DATA_BACKEND: 'pg' },
  }
);

process.exit(typeof result.status === 'number' ? result.status : 1);
