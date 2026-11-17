const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { root } = require('./load.cjs');
function browser(html = '<!doctype html><body></body>', options = {}) {
  const dom = new JSDOM(html, { url: 'https://quiz.test/', runScripts: 'outside-only', ...options });
  const w = dom.window;
  w.Headers = Headers;
  w.fetch = async () => { throw new Error('Unexpected fetch: provide a test response'); };
  return {
    window: w,
    run(file) { const filename = path.join(root, file); vm.runInContext(fs.readFileSync(filename, 'utf8'), dom.getInternalVMContext(), { filename }); },
    close() { w.close(); },
  };
}
module.exports = { browser };
