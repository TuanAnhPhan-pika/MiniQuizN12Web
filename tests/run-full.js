const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mode = (process.argv[2] || 'full').toLowerCase();

const coreTestFiles = [
  // 1. Unit & Frontend Importer / DOM Logic
  'tests/unit/auth.unit.test.js',
  'tests/unit/room.unit.test.js',
  'tests/unit/system-core.unit.test.js',
  'tests/unit/frontend-and-importer.test.js',

  // 2. Full SQLite Relational DB & Migration Integration (Zero PostgreSQL/Supabase required)
  'tests/integration/db-sqlite-full.integration.test.js',

  // 3. Full-Stack HTTP API Integration
  'tests/integration/auth.integration.test.js',
  'tests/integration/room.integration.test.js',
  'tests/integration/storage.integration.test.js',
  'tests/integration/api-full.integration.test.js',

  // 4. Security, Fuzzing, Type-Confusion & Protocol Boundaries
  'tests/security/security-and-fuzzing.test.js',

  // 5. Concurrency, Race Conditions & Idempotency
  'tests/integration/concurrency.integration.test.js',
];

const e2eTestFiles = [
  // 6. Real Browser E2E (Playwright + Headless Edge/Chrome/Chromium)
  'tests/e2e/auth.e2e.test.js',
  'tests/e2e/full-system.e2e.test.js',
];

const env = { ...process.env, NODE_ENV: 'test', DATA_BACKEND: 'pg', RUN_DB_TESTS: '0' };

function runStep(title, args) {
  console.log('\n====================================================================');
  console.log(`  ${title}`);
  console.log('====================================================================\n');
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
  if (res.status !== 0) {
    process.exit(typeof res.status === 'number' ? res.status : 1);
  }
}

if (mode === 'fast') {
  runStep(
    'MiniQuizN12Web - Full Core Suite (Unit + Frontend + SQLite DB + API + Security + Concurrency)',
    ['--no-warnings', '--test', '--test-reporter=spec', ...coreTestFiles]
  );
  process.exit(0);
}

if (mode === 'full') {
  runStep(
    'MiniQuizN12Web - Full System Suite (Unit + Frontend + SQLite DB + API + Security + Concurrency + Playwright E2E)',
    ['--no-warnings', '--test', '--test-reporter=spec', ...coreTestFiles, ...e2eTestFiles]
  );
  process.exit(0);
}

if (mode === 'all') {
  runStep('Step 1/3 - Syntax Check (scripts/check-syntax.js)', ['scripts/check-syntax.js']);
  runStep('Step 2/3 - Existing Project Test Suite (Test Suite/run.cjs all)', [path.join('Test Suite', 'run.cjs'), 'all']);
  runStep(
    'Step 3/3 - Full System SQLite + Security + Concurrency + Playwright E2E Suite',
    ['--no-warnings', '--test', '--test-reporter=spec', ...coreTestFiles, ...e2eTestFiles]
  );
  process.exit(0);
}

if (mode === 'coverage') {
  const c8Bin = require.resolve('c8/bin/c8.js');
  const coverageConfig = path.join('Test Suite', 'coverage.json');
  runStep(
    'MiniQuizN12Web - Combined Code Coverage Gate (c8 >= 80% across src/ & public/js/)',
    [
      c8Bin,
      '--config',
      coverageConfig,
      '--check-coverage',
      process.execPath,
      path.join('tests', 'run-full.js'),
      '_coverage-inner',
    ]
  );
  process.exit(0);
}

if (mode === '_coverage-inner') {
  const legacyRes = spawnSync(process.execPath, [path.join('Test Suite', 'run.cjs'), 'all'], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
  if (legacyRes.status !== 0) process.exit(legacyRes.status ?? 1);

  const fullRes = spawnSync(
    process.execPath,
    ['--no-warnings', '--test', ...coreTestFiles],
    { cwd: ROOT, stdio: 'inherit', env }
  );
  process.exit(fullRes.status ?? 1);
}

console.error('Usage: node tests/run-full.js [full | fast | all | coverage]');
process.exit(2);
