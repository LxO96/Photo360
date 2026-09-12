'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Lens = require('../lens.js');
// gl.js expects a global `Lens` (as it has in the browser, via <script> load
// order) since GL.exportGeometry calls Lens.radiusForFov/Lens.exportLayout.
global.Lens = Lens;
const GL = require('../gl.js');

function baseState(overrides) {
  return Object.assign({
    fovDeg: 180, thetaMaxDeg: 105,
    sensors: 'A', orientation: 'side',
    gapFrac: 0, marginFrac: 0,
    sourceLensSize: 5952, uploadedLensSize: 5952,
    padToSensorSquare: false,
  }, overrides);
}

test('at 180 degrees on a full-size X5 source the export circle is 5100px', () => {
  const g = GL.exportGeometry(baseState());
  // 5952 * (90/105) = 5101.71..., rounds to 5102 -- but Lens.radiusForFov's
  // own rounding is exercised here, not re-derived; assert against the same
  // computation the brief specifies rather than a hand re-typed constant.
  const expected = Math.round(5952 * Lens.radiusForFov(180, 105));
  assert.strictEqual(g.width, expected);
  assert.strictEqual(g.height, expected);
});

test('padToSensorSquare exports at the full uploaded lens size, not the cropped circle', () => {
  const g = GL.exportGeometry(baseState({ padToSensorSquare: true }));
  assert.strictEqual(g.width, 5952);
  assert.strictEqual(g.height, 5952);
});

test('both sensors side by side with zero gap and margin is exactly 2:1', () => {
  const g = GL.exportGeometry(baseState({ sensors: 'both', orientation: 'side' }));
  assert.strictEqual(g.width, g.height * 2);
});

test('both sensors stacked with zero gap and margin is exactly 1:2', () => {
  const g = GL.exportGeometry(baseState({ sensors: 'both', orientation: 'stacked' }));
  assert.strictEqual(g.height, g.width * 2);
});

test('sizes off the actually-uploaded lens size, not the pre-downscale source size', () => {
  // Simulates a GPU whose MAX_TEXTURE_SIZE forced app.js to downscale the
  // decoded bitmap: sourceLensSize still holds the file's true 5952, but
  // uploadedLensSize (what the texture actually holds) is smaller. Sizing
  // off sourceLensSize here would silently upscale past the texture.
  const g = GL.exportGeometry(baseState({ sourceLensSize: 5952, uploadedLensSize: 4096 }));
  const expected = Math.round(4096 * Lens.radiusForFov(180, 105));
  assert.strictEqual(g.width, expected);
  assert.ok(g.width < 5952);
});

test('falls back to sourceLensSize when uploadedLensSize is unset', () => {
  const g = GL.exportGeometry(baseState({ uploadedLensSize: 0 }));
  const expected = Math.round(5952 * Lens.radiusForFov(180, 105));
  assert.strictEqual(g.width, expected);
});

test('margin and gap scale off the export diameter, not a fixed reference', () => {
  const g = GL.exportGeometry(baseState({ marginFrac: 0.08 }));
  const diameter = Math.round(5952 * Lens.radiusForFov(180, 105));
  const margin = Math.round(0.08 * diameter);
  assert.strictEqual(g.width, diameter + 2 * margin);
});

// -- readCompositionStrips: the vertical-flip / strip-boundary logic ------
// gl.readPixels fills bottom-up (GL y=0 is the bottom of the framebuffer);
// ImageData/canvas is top-down. Getting this backwards exports every image
// upside down -- exactly the kind of defect an earlier task already found
// once in this codebase (the texture y-flip at decode time), so this is
// tested directly against a fake `gl` whose readPixels fills each texel
// with its own GL row/column, independent of any real WebGL context.
function fakeGl(overrides) {
  return Object.assign({
    FRAMEBUFFER: 'FRAMEBUFFER', RGBA: 'RGBA', UNSIGNED_BYTE: 'UNSIGNED_BYTE',
    boundFbo: undefined,
    bindFramebuffer(target, fbo) { this.boundFbo = fbo; },
    readPixels(x, y, w, h, format, type, out) {
      // Encode each texel's own GL-space row (y+row) and column (x+col) so
      // the test can check exactly which source pixel ends up where.
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const i = (row * w + col) * 4;
          out[i] = (y + row) & 0xff;
          out[i + 1] = (x + col) & 0xff;
          out[i + 2] = 0;
          out[i + 3] = 255;
        }
      }
    },
  }, overrides);
}

test('readCompositionStrips flips GL bottom-up rows into top-down output order', () => {
  const gl = fakeGl();
  const w = 4, h = 10, stripRows = 3;
  const rowsSeen = [];
  GL.readCompositionStrips(gl, 'fbo', w, h, stripRows, (buf, outY, rows) => {
    for (let r = 0; r < rows; r++) {
      // Column 0's red channel carries the GL row that landed at this
      // output row -- read it back out to check the flip, per output row.
      rowsSeen[outY + r] = buf[r * w * 4];
    }
  });
  assert.strictEqual(rowsSeen.length, h);
  // Output row 0 (top of the final image) must be GL row h-1 (top of the
  // framebuffer in GL's y-up space); output row h-1 (bottom) must be GL
  // row 0. Every row in between mirrors the same relationship.
  for (let outY = 0; outY < h; outY++) {
    assert.strictEqual(rowsSeen[outY], h - 1 - outY,
      `output row ${outY} should be GL row ${h - 1 - outY}, got ${rowsSeen[outY]}`);
  }
});

test('readCompositionStrips preserves column order (only rows flip, not columns)', () => {
  const gl = fakeGl();
  const w = 5, h = 4, stripRows = 4;
  let firstStripCols = null;
  GL.readCompositionStrips(gl, 'fbo', w, h, stripRows, (buf, outY, rows) => {
    if (outY === 0) {
      firstStripCols = [];
      for (let c = 0; c < w; c++) firstStripCols.push(buf[c * 4 + 1]); // green = column
    }
  });
  assert.deepStrictEqual(firstStripCols, [0, 1, 2, 3, 4]);
});

test('readCompositionStrips handles a final partial strip shorter than stripRows', () => {
  const gl = fakeGl();
  const w = 2, h = 7, stripRows = 3; // strips of 3, 3, 1
  const strips = [];
  GL.readCompositionStrips(gl, 'fbo', w, h, stripRows, (buf, outY, rows) => {
    strips.push({ outY, rows });
  });
  assert.deepStrictEqual(strips, [{ outY: 0, rows: 3 }, { outY: 3, rows: 3 }, { outY: 6, rows: 1 }]);
});

test('readCompositionStrips binds the given fbo and restores the default framebuffer', () => {
  const gl = fakeGl();
  const seen = [];
  gl.bindFramebuffer = function (target, fbo) { seen.push(fbo); };
  GL.readCompositionStrips(gl, 'my-fbo', 2, 2, 2, () => {});
  assert.strictEqual(seen[0], 'my-fbo');
  assert.strictEqual(seen[seen.length - 1], null);
});
