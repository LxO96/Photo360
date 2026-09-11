'use strict';
// Loads every test file into one process so node:test reports each test by
// name with real counts, instead of one line per file.
const fs = require('node:fs');
const path = require('node:path');

for (const file of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
  require(path.join(__dirname, file));
}
