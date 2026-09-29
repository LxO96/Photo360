(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./detail.js'), require('./noise.js'));
  } else {
    root.DevCpu = factory(root.Detail, root.Noise);
    (root.DevFactories = root.DevFactories || {}).DevCpu = factory;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Detail, Noise) {
  'use strict';

  // The develop step on the CPU (the "cpu" path of devplan.js): when the
  // GPU has no memory to spare, detail.js itself develops each lens in
  // tiles on worker threads and the GPU only receives the results. A tile
  // job carries everything it needs -- its piece of the source, the
  // settings and the layer sigmas -- and gives back its core: linear
  // camera RGB (RGBA float) for raw, display bytes (RGBA8) for a JPEG,
  // what the GPU passes would have written (gl.js developLens).

  // The piece of a raw plane that `region` needs: the region plus 2 px
  // (the demosaic's reach, clamped at the frame), from an even origin so
  // the CFA pattern keeps its phase.
  function rawSub(plane, w, h, region) {
    const px = Math.max(0, region.x - 2), py = Math.max(0, region.y - 2);
    const pw = Math.min(w, region.x + region.w + 2) - px, ph = Math.min(h, region.y + region.h + 2) - py;
    const sub = new Uint16Array(pw * ph);
    for (let y = 0; y < ph; y++) sub.set(plane.subarray((py + y) * w + px, (py + y) * w + px + pw), y * pw);
    return { plane: sub, pw, ph, px, py };
  }

  // Raw input, as DEV_INPUT_RAW_FS: demosaiced, linearised (not clamped),
  // variance-stabilised, to opponent values; region-sized.
  function rawInput(raw, region) {
    const out = new Float32Array(region.w * region.h * 3);
    const range = raw.white - raw.black;
    for (let y = 0; y < region.h; y++) {
      for (let x = 0; x < region.w; x++) {
        const c = Noise.demosaicAt(raw.plane, raw.pw, raw.ph, raw.cfa, region.x + x - raw.px, region.y + y - raw.py);
        const r = Noise.vst((c[0] - raw.black) / range, raw.a, raw.b);
        const g = Noise.vst((c[1] - raw.black) / range, raw.a, raw.b);
        const b = Noise.vst((c[2] - raw.black) / range, raw.a, raw.b);
        out.set(Detail.toOpp(r, g, b), (y * region.w + x) * 3);
      }
    }
    return out;
  }

  // JPEG input, as DEV_INPUT_RGB_FS: RGBA8 display values to opponent.
  function rgbaInput(rgba, w, h) {
    const out = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      out.set(Detail.toOpp(rgba[i * 4] / 255, rgba[i * 4 + 1] / 255, rgba[i * 4 + 2] / 255), i * 3);
    }
    return out;
  }

  // Develops one tile. job: { kind: 'raw' | 'rgba', region, core (both in
  // frame pixels), params, sigmas, raw: rawSub(...) + { cfa, black,
  // white, a, b } | rgba: region-sized RGBA8 }. Returns { core, data }.
  function developTile(job) {
    const { region: r, core: c } = job;
    const raw = job.kind === 'raw';
    const img = raw ? rawInput(job.raw, r) : rgbaInput(job.rgba, r.w, r.h);
    const d = Detail.develop(img, r.w, r.h, job.params, job.sigmas);
    const data = raw ? new Float32Array(c.w * c.h * 4) : new Uint8Array(c.w * c.h * 4);
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const i = ((c.y - r.y + y) * r.w + (c.x - r.x + x)) * 3, o = (y * c.w + x) * 4;
        const rgb = Detail.fromOpp(d[i], d[i + 1], d[i + 2]);
        for (let ch = 0; ch < 3; ch++) {
          data[o + ch] = raw
            ? Noise.vstInverse(rgb[ch], job.raw.a, job.raw.b)
            : Math.round(Math.min(1, Math.max(0, rgb[ch])) * 255);
        }
        data[o + 3] = raw ? 1 : 255;
      }
    }
    return { core: c, data };
  }

  // A JPEG's layer noise, as measured for the GPU paths too: `crops` are
  // devplan.js sigmaCrops regions as opponent images ({ opp, w, h, inner }
  // with `inner` relative to the region); each layer is read inside
  // `inner` only, where it equals the whole frame's.
  function measureJpegSigmas(crops) {
    const layers = crops.map((c) => Detail.atrous(c.opp, c.w, c.h, Detail.LEVELS).details);
    const out = [];
    for (let k = 0; k < Detail.LEVELS; k++) {
      const parts = crops.map((c, j) => {
        const n = c.inner, d = new Float32Array(n.w * n.h * 3);
        for (let y = 0; y < n.h; y++) d.set(layers[j][k].subarray(((n.y + y) * c.w + n.x) * 3, ((n.y + y) * c.w + n.x + n.w) * 3), y * n.w * 3);
        return { d, w: n.w, h: n.h };
      });
      out.push(Noise.jpegSigma(k, Noise.capLuma(Noise.estimateSigma(parts, 3), out[k - 1])));
    }
    return out;
  }

  // A worker's script, built from the modules' own factories (a Blob URL:
  // no separate file to fetch, so it works from file:// too).
  function workerSource(factories) {
    return 'self.Detail = (' + factories.Detail + ')();\n' +
      'self.Noise = (' + factories.Noise + ')();\n' +
      'self.DevCpu = (' + factories.DevCpu + ')(self.Detail, self.Noise);\n' +
      'self.onmessage = function (e) {\n' +
      '  var r = self.DevCpu.developTile(e.data.job);\n' +
      '  self.postMessage({ id: e.data.id, result: r }, [r.data.buffer]);\n' +
      '};\n';
  }

  // Runs tile jobs on `size` workers, or one at a time on this thread
  // (yielding between jobs) where workers can't be made. run(job,
  // transfer) -> Promise of the result; clear(pred) drops the jobs not
  // yet started (those whose job pred(job) is true, or all), which resolve
  // to null; close() ends the workers.
  function createPool(opts) {
    const size = Math.max(1, opts.size || 1);
    const queue = [];
    const idle = [];
    const busy = new Map();
    let serial = 0, url = null, inThread = true;
    if (typeof Worker !== 'undefined' && opts.factories) {
      try {
        url = URL.createObjectURL(new Blob([workerSource(opts.factories)], { type: 'text/javascript' }));
        for (let i = 0; i < size; i++) {
          const wk = new Worker(url);
          wk.onmessage = (e) => {
            const t = busy.get(wk);
            busy.delete(wk);
            idle.push(wk);
            t.resolve(e.data.result);
            pump();
          };
          wk.onerror = (e) => {
            const t = busy.get(wk);
            busy.delete(wk);
            idle.push(wk);
            if (t) t.reject(new Error('develop worker: ' + (e.message || 'failed')));
            pump();
          };
          idle.push(wk);
        }
        inThread = false;
      } catch (e) {
        for (const wk of idle) wk.terminate();
        idle.length = 0;
      }
    }
    let running = false;
    function pump() {
      if (inThread) {
        if (running || !queue.length) return;
        running = true;
        setTimeout(() => {
          const t = queue.shift();
          running = false;
          if (t) {
            try { t.resolve(developTile(t.job)); } catch (e) { t.reject(e); }
          }
          pump();
        }, 0);
        return;
      }
      while (idle.length && queue.length) {
        const wk = idle.pop(), t = queue.shift();
        busy.set(wk, t);
        wk.postMessage({ id: ++serial, job: t.job }, t.transfer || []);
      }
    }
    return {
      size: inThread ? 1 : size,
      workers: !inThread,
      run(job, transfer) {
        return new Promise((resolve, reject) => {
          queue.push({ job, transfer, resolve, reject });
          pump();
        });
      },
      clear(pred) {
        for (let i = queue.length - 1; i >= 0; i--) {
          if (!pred || pred(queue[i].job)) queue.splice(i, 1)[0].resolve(null);
        }
      },
      close() {
        this.clear();
        for (const wk of idle) wk.terminate();
        for (const wk of busy.keys()) wk.terminate();
        idle.length = 0;
        busy.clear();
        if (url) URL.revokeObjectURL(url);
      },
    };
  }

  return { rawSub, rawInput, rgbaInput, developTile, measureJpegSigmas, workerSource, createPool };
});
