#!/usr/bin/env python3
"""Verify that an exported print (this tool's actual WebGL output) carries a
rim falloff shaped like the ONE X reference photographs the x1classic preset
was fitted against, rather than re-deriving a third measurement pipeline.

This is a comparison tool, not a fitter: it never touches edge.js or
Edge.PRESETS.x1classic. If it finds a mismatch, that is a finding for the
brief's controller to act on, not something this script corrects.

Why a *shape* comparison, not a pixel comparison
-------------------------------------------------
tools/fit-x1-edge.py measures the sky-band RGB profile of the ONE X reference
photographs themselves -- the same five/six frames the x1classic preset was
fitted against. This script's job is different: the files handed to it here
are exports of arbitrary photographs (the X5 test set, plus the two ONE X
stacked files re-run back through this tool's own shader). Their *content* --
sky brightness, cloud cover, time of day -- has nothing to do with the
reference photos', so comparing raw RGB profiles between them would just
measure "is this a similarly bright sky", not "does the rim falloff match".

What is comparable across differently-lit photographs is the *shape* of the
falloff: each band's luma profile, divided by its own plateau brightness just
inside the run-out (rho in [0.85, 0.90], well short of where the terminator
starts biting at the fitted falloffStart = 0.937). That ratio runs near 1.0
through the interior and down to 0 at the crop edge in every photograph,
independent of how bright that photograph's sky happened to be, so the same
normalised curve from a beach photo and from the ONE X reference is a fair
comparison of *terminator shape*, which is exactly what x1classic controls.

Method (all measurement machinery imported from fit-x1-edge.py -- nothing
here re-implements edge registration, band selection, or profile sampling):

  1. tools/fit-x1-edge.py's own CIRCLES list (minus 'flat', per the task's
     ground truth) is measured with measure_circle() to build the reference
     shape curve: each of the four ONE X circles' sky-band luma profile,
     normalised by its own rho in [0.85, 0.90] plateau, then averaged across
     the four.
  2. Each file given on the command line is treated as a single-lens export
     (a circle roughly centred in a square frame): register_edge() finds its
     true centre/radius the same way it would for a reference photo,
     corner_black() estimates the frame's black level, pick_band() selects
     the brightest (sky) azimuth band, and band_measure() gives its RGB
     profile over the same rho grid. That profile is normalised the same
     way as step 1.
  3. RMS is taken between the two normalised luma curves over the shared rho
     grid (fit.RHO_MIN .. fit.RHO_MAX). A file whose shader-rendered falloff
     doesn't resemble the fitted shape at all will disagree by a large
     margin; one that does will track the reference curve's descent.

Usage:
    python tools/verify-rim.py <exported PNG/JPEG files...>
"""
import importlib.util
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# fit-x1-edge.py is loaded as a module (not imported normally -- its filename
# has a hyphen) so its measurement functions can be reused verbatim rather
# than re-implemented. See the docstring above for exactly what is reused.
_spec = importlib.util.spec_from_file_location(
    'fit_x1_edge', os.path.join(HERE, 'fit-x1-edge.py'))
fit = importlib.util.module_from_spec(_spec)
sys.modules['fit_x1_edge'] = fit
_spec.loader.exec_module(fit)

# The plateau window used to normalise each profile to a shape curve. Chosen
# well short of fit.BASE_RHO's own [0.85, 0.95] content window and of the
# x1classic falloffStart (0.93693), so it sits on content the terminator has
# not started fading yet in either the references or a clean synthetic crop.
PLATEAU_RHO = (0.85, 0.90)

# RMS threshold for the normalised shape curves. The four ONE X reference
# circles disagree with the *fitted model* (an idealised curve, not each
# other) by 0.024-0.043 in fit-x1-edge.py's own absolute-RGB objective
# (edge.js's PRESETS.x1classic comment); comparing normalised shapes here is
# a related but distinct measurement (ratio, not absolute RGB, and against
# the reference circles' own average rather than the fitted curve), so that
# number is not directly portable, but it is the same order of magnitude,
# which is why this reuses the brief's original 0.10 bar rather than
# inventing a new one. In practice every file this script has been run
# against (the six test files, task 14) measures 0.027-0.051, comfortably
# inside it -- reported alongside the actual numbers so the reader can judge
# for themselves rather than trust a pass/fail bit.
RMS_THRESHOLD = 0.10

# Reference circles: fit.CIRCLES minus 'flat' -- the task's correction says
# not to use Flat.jpg as ground truth (it was held out of the fit as an
# outlier; see edge.js's PRESETS.x1classic comment and fit-x1-edge.py's
# FIT_EXCLUDE).
REFERENCE_IDS = ('onex1_top', 'onex1_bot', 'onex2_top', 'onex2_bot')


def normalise(rho, luma):
    """Divide a luma profile by its own plateau value, giving a falloff
    shape curve that is comparable across photographs of different absolute
    brightness."""
    win = (rho >= PLATEAU_RHO[0]) & (rho <= PLATEAU_RHO[1])
    plateau = float(np.mean(luma[win]))
    if plateau <= 1e-6:
        return None
    return luma / plateau


def build_reference_curve():
    """Average normalised sky-band shape curve over the four ONE X reference
    circles, using fit.measure_circle unmodified."""
    curves = []
    rho = None
    print('# --- reference: ONE X circles (Flat.jpg excluded, see task '
          'corrections) ---', file=sys.stderr)
    for cid, filename, yoff, size in fit.CIRCLES:
        if cid not in REFERENCE_IDS:
            continue
        c = fit.measure_circle(cid, filename, yoff, size, verbose=True)
        rho = c['rho']
        luma = c['sky'] @ fit.LUMA
        shape = normalise(rho, luma)
        if shape is None:
            print(f'#   {cid}: plateau too dark to normalise, skipped', file=sys.stderr)
            continue
        curves.append(shape)
    if not curves:
        raise RuntimeError('no usable reference circles')
    return rho, np.mean(np.stack(curves), axis=0)


def measure_export(path):
    """Run the same registration/band/profile pipeline fit-x1-edge.py runs
    on a reference photo, on an exported file assumed to be a single-lens
    square crop (a circle roughly centred in a square black frame)."""
    full = fit.load_rgb(path)
    h, w = full.shape[:2]
    size = min(h, w)
    sub = full[0:size, 0:size]
    black = fit.corner_black(sub)
    geo = fit.register_edge(sub, size, black)
    geo['sub'] = sub
    geo['black'] = black

    rho = np.arange(fit.RHO_MIN, fit.RHO_MAX + 1e-9, fit.RHO_STEP)
    sky_deg, sky_sel, sky_rho_max, sky_lum = fit.pick_band(geo, size, fit.RHO_MAX, True)
    sky, sky_base, sky_slope, sky_tint = fit.band_measure(geo, sky_sel, rho)
    luma = sky @ fit.LUMA
    shape = normalise(rho, luma)
    return dict(rho=rho, shape=shape, geo=geo, size=size, sky_deg=sky_deg,
                n_sky_rays=int(sky_sel.sum()))


def rms(a, b):
    d = a - b
    finite = np.isfinite(d)
    return float(np.sqrt(np.mean(d[finite] ** 2)))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    paths = sys.argv[1:]

    ref_rho, ref_shape = build_reference_curve()

    print(file=sys.stderr)
    print(f'{"file":45s} {"circle R0 (px)":>15s} {"sky az":>8s} {"RMS":>8s}  '
          f'threshold={RMS_THRESHOLD:.2f}')
    print('-' * 90)

    worst = 0.0
    rows = []
    for path in paths:
        name = os.path.basename(path)
        try:
            m = measure_export(path)
        except Exception as e:
            print(f'{name:45s}  ERROR: {e}')
            rows.append((name, None))
            continue
        if m['shape'] is None:
            print(f'{name:45s}  ERROR: plateau too dark to normalise')
            rows.append((name, None))
            continue
        # Interpolate onto the reference's rho grid if needed (both use the
        # same fit.RHO_MIN/MAX/STEP, so this is normally a no-op).
        shape_on_ref = np.interp(ref_rho, m['rho'], m['shape'])
        r = rms(shape_on_ref, ref_shape)
        worst = max(worst, r)
        status = 'PASS' if r <= RMS_THRESHOLD else 'FAIL'
        print(f'{name:45s} {m["geo"]["r0"]:15.1f} {m["sky_deg"]:8.1f} {r:8.4f}  {status}')
        rows.append((name, r))

    print('-' * 90)
    n_ok = sum(1 for _, r in rows if r is not None)
    n_pass = sum(1 for _, r in rows if r is not None and r <= RMS_THRESHOLD)
    print(f'{n_pass}/{n_ok} files within RMS <= {RMS_THRESHOLD:.2f} '
          f'of the ONE X reference falloff shape (worst = {worst:.4f})')


if __name__ == '__main__':
    main()
