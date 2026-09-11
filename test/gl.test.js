'use strict';
const test = require('node:test');
const assert = require('node:assert');
const GL = require('../gl.js');

test('physicalLens returns the slot label unchanged when not swapped', () => {
  assert.strictEqual(GL.physicalLens({ swap: false }, 'A'), 'A');
  assert.strictEqual(GL.physicalLens({ swap: false }, 'B'), 'B');
});

test('physicalLens returns the other lens label when swapped', () => {
  assert.strictEqual(GL.physicalLens({ swap: true }, 'A'), 'B');
  assert.strictEqual(GL.physicalLens({ swap: true }, 'B'), 'A');
});
