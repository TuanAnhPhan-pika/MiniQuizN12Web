const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const requestedGroup = process.argv[2] || 'all';
const group = requestedGroup === 'resilience' ? 'performance' : requestedGroup;
if (group === 'combined') {
  for (const part of ['all', 'database']) {
    const result = spawnSync(process.execPath, [__filename, part], { cwd: root, env: process.env, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
if (group === 'coverage:database') {
  if (!process.env.TEST_DATABASE_URL) { console.error('Set TEST_DATABASE_URL first.'); process.exit(2); }
  const result = spawnSync(process.execPath, [require.resolve('c8/bin/c8.js'), '--config', path.join(__dirname, 'coverage.json'),
    '--check-coverage', process.execPath, __filename, 'combined'], { cwd: root, env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const groups = ['backend', 'frontend', 'performance', 'database'];
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.test\.(?:js|cjs)$/.test(p) ? [p] : [];
  });
}
if (!['all', 'coverage', 'check', ...groups].includes(group)) {
  console.error('Groups: all, backend, frontend, performance (alias: resilience), database, coverage, check');
  process.exit(2);
}
const selectedGroups = ['all', 'coverage', 'check'].includes(group) ? ['backend', 'frontend', 'performance'] : [group];
const files = selectedGroups.flatMap(name => walk(path.join(__dirname, name)));
const env = { ...process.env, RUN_DB_TESTS: '0' };
let args = ['--test', ...files];
if (group === 'database') {
  if (!env.TEST_DATABASE_URL) {
    console.error('Set TEST_DATABASE_URL to run isolated PostgreSQL tests. No production default is used.');
    process.exit(2);
  }
  env.RUN_DB_TESTS = '1';
  args = ['--test', path.join(__dirname, 'database', 'postgres.test.cjs')];
}
if (group === 'coverage' || group === 'check') {
  args = [require.resolve('c8/bin/c8.js'), '--config', path.join(__dirname, 'coverage.json'),
    ...(group === 'check' ? ['--check-coverage'] : []), process.execPath, ...args];
}
const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
