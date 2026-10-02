const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '../extension');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

test('every file referenced by the manifest exists', () => {
  const files = [
    manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap(script => script.js),
  ];
  for (const file of files) assert.ok(fs.existsSync(path.join(dir, file)), `${file} missing`);
});
