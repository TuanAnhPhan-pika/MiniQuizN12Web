const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
function load(relative, overrides = {}, env = {}) {
  const filename = path.join(root, relative);
  const realRequire = createRequire(filename);
  const context = {
    module: { exports: {} }, __dirname: path.dirname(filename), Buffer, URL,
    process: { env }, console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval() {},
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}
module.exports = { load, root };
