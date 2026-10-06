const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function check(target) {
  if (fs.statSync(target).isDirectory()) {
    for (const name of fs.readdirSync(target)) check(path.join(target, name));
  } else if (target.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', target], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
for (const target of ['server.js', 'src', 'public/js', 'scripts', 'tests']) check(target);
console.log('All JavaScript syntax checks passed.');
