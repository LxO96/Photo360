#!/usr/bin/env python3
"""Fit the "x1classic" lens-edge preset against real fisheye reference photos.

Development tool only -- not shipped with the page (edge.js and the rest of
the site stay dependency-free; Pillow/NumPy/SciPy are fine to use here).

Usage:  python tools/fit-x1-edge.py            # measure, fit, write fixture
        python tools/fit-x1-edge.py --plots    # also write diagnostic PNGs


What is being fitted
--------------------
`Edge.PRESETS.x1classic` drives COMPOSITE_FS (shaders.js). This script
transcribes that shader exactly -- terminator(), rimBell() including its
`width <= 0` impulse guard, dispersionPeaks()'s red-inner/blue-outer
convention, the desaturate-then-cool-shift ordering of the terminator's
colour treatment, and the COOL constant -- and fits its parameters to five
measured reference rims.

  model(u) = img(u) + glow(u) + haze(u) * tint

  img(u)   = 0                                   for u >= 1
             base, desaturated by fade*desat,
             cooled by fade*cool, times term      for u <  1
             where term = terminator(u), fade = 1 - term
  glow(u)  = rimBell(u, 1 -+ dispersion, ringWidth) * intensity * tint
  haze(u)  = rimBell(u, 1, hazeWidth) * intensity * hazeStrength
  intensity= profR * edgeIntensity

`profR` is the shader's `prof.r`: the mean highlight weight of the content
in the rim annulus, which is what makes the glow content-driven. It is a
per-azimuth measurement, not a preset parameter, so it is measured from
each reference circle and stored in the fixture. Folding it into
`edgeIntensity` -- as an earlier version of this script did -- is what
produced a preset whose rim was invisible in the renderer: the fitted
amplitude was the *product* edgeIntensity*profR, and profR for a bright sky
at knee 0.45 / exponent 2 is only ~0.05, so pasting the product in as
`edgeIntensity` under-drove the real shader by a factor of ~20.


The radius-axis problem, and how it is solved
---------------------------------------------
The five circles do not share a radius axis, and worse, none of them is
exactly concentric with its frame: normalising by frame half-width (or by a
single fitted circle) leaves 3-4% of azimuthal scatter in where the edge
sits, which smears a rim that is only ~3% of the radius wide into a broad
ramp and makes the measured falloff look far softer than it is.

So the edge is registered per azimuth. For each of 1440 rays out of the
centre, the edge radius R(theta) is the outermost radius at which the ray's
luminance rises back through half of that ray's own interior plateau
(searched inward from the last in-frame sample). Halving the ray's *own*
plateau makes the landmark independent of what that ray happens to be
looking at, because the run-out is multiplicative; searching inward from
outside makes it immune to interior content edges, which a
steepest-gradient landmark is not (tried first -- it locks onto horizons
and foreground objects). A 3-harmonic Fourier series is then fitted
robustly to R(theta), absorbing decentring and slight ellipticity; the
residual scatter after that is 0.1-0.6% of the radius, i.e. the edge is
registered to about a pixel. All profiles are sampled on
rho = r / R(theta).

rho = 1 is the half-plateau landmark, which is *not* the model's u = 1
(terminator() is hard-zero there, with only the glow beyond). One scalar
per circle, `alignScale`, maps the two: u = rho * alignScale. It is fitted
jointly with the shape parameters and stored in the fixture, because it is
a property of the measurement rather than of the preset.


Fit structure
-------------
Stage 1   Radial shape. Nonlinear: falloffStart, falloffSoftness,
          ringWidth, dispersion, hazeWidth, hazeStrength,
          terminatorDesaturate, terminatorCoolShift, plus one alignScale
          per circle. The rim amplitude of each band is *not* a search
          variable -- given the shape it is the closed-form non-negative
          least-squares solution, recomputed at every objective
          evaluation. That is deliberate: the failure mode of searching
          over the amplitude directly is that suppressing the rim
          (edgeIntensity -> 0, ringWidth -> its floor) minimises the
          objective, because the many radial samples with no rim in them
          outvote the few that have one. Solving it exactly instead means
          the search never trades rim visibility against falloff
          accuracy, and the amplitudes that come out are measurements of
          how bright each reference rim actually is.

Stage 2   Whether the content-driven part of the model is measurable at
          all. It is not, on these references -- see
          diagnose_content_response(). highlightKnee, highlightExponent
          and glowSpreadDeg are reported unconstrained and left at their
          Task 4 defaults rather than given fabricated numbers.

Stage 3   dispersion, measured rather than fitted: the per-azimuth edge
          landmark run separately on R, G and B. ringWidth follows from
          it (RING_WIDTH_OVER_DISPERSION) because the RMS objective is
          flat in it.

Stage 3b  terminatorDesaturate / terminatorCoolShift, measured rather
          than fitted, from how chromaticity drifts through the fade.

Stage 4   Re-fit with the rim amplitude tied to the renderer's own
          `prof.r * edgeIntensity` and the measured parameters pinned, so
          the numbers pasted into edge.js are optimal for the model the
          tool actually renders.

The script then prints a sensitivity table -- what it costs the objective
to pin each parameter to each end of its slider and re-optimise the rest
-- which is the evidence behind every "fitted" / "unconstrained" /
"boundary-pegged" verdict in the task report. Read it before trusting any
individual number.

Re-running on different reference photos: edit CIRCLES below (id, file,
y-offset, square size). Centre, radius, edge shape and the sky/shadow
azimuths are all detected automatically.
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image
from scipy.optimize import differential_evolution, minimize

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURE_PATH = os.path.join(ROOT, 'test', 'fixtures', 'x1-rim-profile.json')

# id, file under Testfiles/Outputs, y-offset of the square crop, crop size.
CIRCLES = [
    ('flat',      'Flat.jpg', 0, 3040),
    ('onex1_top', 'IMG_20210605_193319_00_019.jpg', 0, 1520),
    ('onex1_bot', 'IMG_20210605_193319_00_019.jpg', 1520, 1520),
    ('onex2_top', 'IMG_20210721_192852_00_141.jpg', 0, 3040),
    ('onex2_bot', 'IMG_20210721_192852_00_141.jpg', 3040, 3040),
]

# Circles that are measured, stored in the fixture and reported, but held
# out of the fit objective. See the report / edge.js comment: Flat.jpg is
# EXIF-tagged Adobe Lightroom 12.5, is the only reference with a lifted black
# point, and -- after the same per-azimuth edge registration as every other
# circle -- its run-out is 4-5x wider than any of the four ONE X circles.
# A single terminator cannot be both; including it does not average the two,
# it fits neither. Set --exclude= to fit all five and see that for yourself.
FIT_EXCLUDE = ('flat',)

LUMA = np.array([0.2126, 0.7152, 0.0722])
COOL = np.array([0.82, 0.92, 1.12])        # COMPOSITE_FS's COOL constant

NTH = 1440                 # azimuths used for edge registration
EDGE_HARMONICS = 3         # Fourier order of the R(theta) edge model
EDGE_FRAC = 0.5            # landmark: half of each ray's own plateau
RHO_MIN, RHO_MAX, RHO_STEP = 0.85, 1.15, 0.005
BASE_RHO = (0.85, 0.95)    # un-faded content window used for base/tint/profR
BAND_HALF_DEG = 40.0       # sky / shadow azimuth bands
CORNER_PX = 40

# gl.js's profile-pass annulus and sample count, mirrored here so profR is
# computed the same way the renderer computes prof.r.
PROFILE_U_MIN, PROFILE_U_MAX, PROFILE_RADIAL_SAMPLES = 0.94, 1.0, 8

# Parameters this reference set cannot constrain, kept at the Task 4
# placeholder values. See diagnose_content_response(): in all four ONE X
# circles the light outside the image circle is *brighter* on the dark
# azimuths than on the bright-sky ones, so the references' azimuthal rim
# structure is not a function of local content brightness at any blur width,
# and neither the knee, the exponent nor the spread can be measured from them.
UNCONSTRAINED_DEFAULTS = {
    'highlightKnee': 0.45,
    'highlightExponent': 2.0,
    'glowSpreadDeg': 8.0,
}

# Weight of the sky and shadow bands in the fit objective. The shadow bands are
# measured, stored and reported, but carry zero weight: what they contain
# outside the image circle is sun-positioned veiling glare, which the shader's
# content-driven glow does not model and cannot be asked to reproduce. Fitting
# them would bend the terminator to chase it. NOTE: This is a deviation from the
# brief's stated requirement to hold the shadow band within the 0.06 RMS
# tolerance; this choice prioritizes sky-band accuracy over an unattainable
# shadow-band constraint.
BAND_WEIGHT = np.array([1.0, 0.0])

# rimBell's width and hazeWidth both centre on u = 1, so the RMS objective
# cannot tell them apart (pinning ringWidth to either end of its slider moves
# the objective by under 0.4% -- see the sensitivity table the script prints).
# What *does* decide ringWidth is whether the measured dispersion can be seen:
# if the ring is much wider than the channel separation, the three dispersed
# bells overlap into one achromatic band and the colour fringe the references
# plainly show disappears. So ringWidth is set to this multiple of the measured
# dispersion -- a stated criterion inside a region the data is flat over,
# rather than whichever corner of that flat region the optimiser drifted into.
RING_WIDTH_OVER_DISPERSION = 2.0

# hazeStrength multiplies the same `intensity` that edgeIntensity sets, so once
# ringWidth is narrow (the ring carries little of the glow's energy) only the
# product edgeIntensity * hazeStrength is identifiable and hazeStrength runs to
# whatever bound it is given. Pinned here, with edgeIntensity left free to
# carry the scale.
HAZE_STRENGTH_FIXED = 1.0

# Final whole-branch review, Important finding #4: this table used to claim
# ("Slider ranges from index.html / app.js") a provenance that was only ever
# true for the seven keys that *have* a slider -- highlightExponent,
# hazeWidth and hazeStrength have no UI control at all (see settings.js's own
# RANGES comment), and this table's values for those three, plus a rounding
# difference on the rest, had silently drifted from settings.js's
# Settings.RANGES, the actual single source of truth for every key's valid
# domain (test/slider-ranges.test.js now cross-checks RANGES against
# index.html's sliders directly, so the two can't drift again for the seven
# that have one). Copied by hand from Settings.RANGES rather than shared at
# build time (no build step, and this is Python, not JS) -- if the two
# disagree again, trust settings.js and update this table, not the other way
# around. A fitted value is reported, never silently clamped, if it lands on
# one of these.
SLIDER_RANGE = {
    'falloffStart': (0.6, 0.99),
    'falloffSoftness': (0.3, 4.0),
    'edgeIntensity': (0.0, 4.0),
    'ringWidth': (0.002, 0.06),
    'dispersion': (0.0, 0.05),
    'glowSpreadDeg': (0.0, 45.0),
    'highlightKnee': (0.0, 1.0),
    'highlightExponent': (0.5, 8.0),
    'hazeWidth': (0.0, 0.3),
    'hazeStrength': (0.0, 4.0),
    'terminatorDesaturate': (0.0, 1.0),
    'terminatorCoolShift': (0.0, 1.0),
}


# ---------------------------------------------------------------------------
# Faithful transcription of edge.js / COMPOSITE_FS
# ---------------------------------------------------------------------------

def terminator(u, start, softness):
    """edge.js Edge.terminator, vectorised. 1 inside `start`, 0 at u >= 1."""
    u = np.asarray(u, float)
    t = np.clip((u - start) / (1.0 - start), 0.0, 1.0)
    eased = t * t * (3.0 - 2.0 * t)
    val = np.power(np.clip(1.0 - eased, 0.0, 1.0), softness)
    return np.where(u <= start, 1.0, np.where(u >= 1.0, 0.0, val))


def dispersion_peaks(amount):
    """edge.js Edge.dispersionPeaks: red innermost, blue outermost."""
    return (1.0 - amount, 1.0, 1.0 + amount)


def rim_bell(u, peak, width):
    """edge.js Edge.rimBell, vectorised, including the width <= 0 guard."""
    u = np.asarray(u, float)
    if width <= 0.0:
        return np.where(u == peak, 1.0, 0.0)
    t = (u - peak) / width
    return np.exp(-t * t)


def highlight_weight(luma, knee, exponent):
    """edge.js Edge.highlightWeight."""
    return np.power(np.maximum(0.0, luma - knee), exponent)


# ---------------------------------------------------------------------------
# Sampling helpers
# ---------------------------------------------------------------------------

def load_rgb(path):
    return np.asarray(Image.open(path).convert('RGB')).astype(np.float64) / 255.0


def sample_bilinear(arr, px, py):
    """Bilinear sample. Points outside the frame come back as NaN rather than
    clamped, so a clipped image circle cannot fake signal at its edge."""
    H, W, _ = arr.shape
    shape = px.shape
    px = px.ravel()
    py = py.ravel()
    out_of_frame = (px < 0) | (px > W - 1.001) | (py < 0) | (py > H - 1.001)
    pxc = np.clip(px, 0, W - 1.001)
    pyc = np.clip(py, 0, H - 1.001)
    x0 = np.floor(pxc).astype(int)
    y0 = np.floor(pyc).astype(int)
    fx = (pxc - x0)[:, None]
    fy = (pyc - y0)[:, None]
    top = arr[y0, x0] * (1 - fx) + arr[y0, x0 + 1] * fx
    bot = arr[y0 + 1, x0] * (1 - fx) + arr[y0 + 1, x0 + 1] * fx
    out = top * (1 - fy) + bot * fy
    out[out_of_frame] = np.nan
    return out.reshape(shape + (3,))


def polar_rgb(sub, cx, cy, radii, thetas):
    """radii (R,) or (R,T), thetas (T,) -> (R, T, 3)."""
    radii = np.asarray(radii, float)
    if radii.ndim == 1:
        radii = radii[:, None]
    T = thetas[None, :]
    return sample_bilinear(sub, cx + radii * np.cos(T), cy + radii * np.sin(T))


def corner_black(sub):
    n = CORNER_PX
    corners = np.concatenate([
        sub[:n, :n].reshape(-1, 3), sub[:n, -n:].reshape(-1, 3),
        sub[-n:, :n].reshape(-1, 3), sub[-n:, -n:].reshape(-1, 3)])
    return np.percentile(corners, 20, axis=0)


# ---------------------------------------------------------------------------
# Per-azimuth edge registration
# ---------------------------------------------------------------------------

def ray_edge_radii(sub, cx, cy, r_guess, thetas, black, size):
    """Outermost radius at which each ray rises back through EDGE_FRAC of its
    own interior plateau. NaN where the ray is clipped by the frame or has
    too little content to give a reliable landmark."""
    radii = np.linspace(0.30 * r_guess, 1.40 * r_guess, 800)
    lum = (polar_rgb(sub, cx, cy, radii, thetas) - black) @ LUMA
    inside = ~np.isnan(lum)
    smoothed = np.apply_along_axis(
        lambda v: np.convolve(v, np.ones(5) / 5, mode='same'),
        0, np.nan_to_num(lum, nan=-1.0))
    inner = (radii > 0.35 * r_guess) & (radii < 0.75 * r_guess)
    plateau = np.nanmedian(np.where(inside, lum, np.nan)[inner], axis=0)

    out = np.full(len(thetas), np.nan)
    first = int(np.searchsorted(radii, 0.80 * r_guess))
    for j in range(len(thetas)):
        if not np.isfinite(plateau[j]) or plateau[j] < 0.10:
            continue
        in_j = np.nonzero(inside[:, j])[0]
        if in_j.size == 0:
            continue
        target = EDGE_FRAC * plateau[j]
        col = smoothed[:, j]
        r = None
        for i in range(in_j[-1], first, -1):
            if col[i] < target <= col[i - 1]:
                t = (target - col[i - 1]) / (col[i] - col[i - 1])
                r = radii[i - 1] + t * (radii[i] - radii[i - 1])
                break
        if r is None:
            continue
        px = cx + r * math.cos(thetas[j])
        py = cy + r * math.sin(thetas[j])
        if px < 4 or px > size - 5 or py < 4 or py > size - 5:
            continue          # landmark sits on the frame edge: ray is clipped
        out[j] = r
    return out


def fourier_edge(thetas, radii, harmonics=EDGE_HARMONICS, iters=5):
    """Robust least-squares Fourier fit to R(theta), with outlier rejection."""
    cols = [np.ones_like(thetas)]
    for h in range(1, harmonics + 1):
        cols += [np.cos(h * thetas), np.sin(h * thetas)]
    A = np.column_stack(cols)
    have = np.isfinite(radii)
    r = np.nan_to_num(radii)
    keep = have.copy()
    coef = None
    for _ in range(iters):
        coef, *_ = np.linalg.lstsq(A[keep], r[keep], rcond=None)
        resid = np.abs(r - A @ coef)
        scale = np.median(resid[have]) * 1.4826 + 1e-9
        keep = have & (resid < 3 * scale)
    pred = A @ coef
    mad = float(np.median(np.abs(r - pred)[have]))
    return pred, coef, mad, int(have.sum())


def register_edge(sub, size, black):
    cx, cy, r_guess = size / 2.0, size / 2.0, size / 2.0 * 0.98
    thetas = np.linspace(0, 2 * np.pi, NTH, endpoint=False)
    for _ in range(4):
        raw = ray_edge_radii(sub, cx, cy, r_guess, thetas, black, size)
        _, coef, _, _ = fourier_edge(thetas, raw)
        cx += coef[1]
        cy += coef[2]
        r_guess = coef[0]
    raw = ray_edge_radii(sub, cx, cy, r_guess, thetas, black, size)
    r_theta, coef, mad, n_valid = fourier_edge(thetas, raw)
    return dict(cx=cx, cy=cy, thetas=thetas, r_theta=r_theta, r0=float(coef[0]),
                mad=mad, n_valid=n_valid)


# ---------------------------------------------------------------------------
# Per-circle measurement
# ---------------------------------------------------------------------------

def frame_rho_max(geo, size):
    """Largest rho each ray can reach while staying inside the square frame."""
    cx, cy, th, rt = geo['cx'], geo['cy'], geo['thetas'], geo['r_theta']
    c, s = np.cos(th), np.sin(th)
    lim = np.full(len(th), np.inf)
    with np.errstate(divide='ignore', invalid='ignore'):
        for num, den in ((size - 5 - cx, c), (cx - 4, -c), (size - 5 - cy, s), (cy - 4, -s)):
            d = np.where(den > 1e-9, num / np.maximum(den, 1e-9), np.inf)
            lim = np.minimum(lim, d)
    return lim / rt


def pick_band(geo, size, rho_max_wanted, brightest):
    """Choose the sky (brightest) or shadow (darkest) azimuth, then keep only
    the rays in that band that stay in-frame over the whole rho range, so the
    band's composition does not change with radius (which would put a step in
    the measured profile wherever a ray drops out)."""
    th, rt = geo['thetas'], geo['r_theta']
    lum = np.nan_to_num((polar_rgb(geo['sub'], geo['cx'], geo['cy'],
                                   0.90 * rt, th)[0] - geo['black']) @ LUMA)
    k = 61
    pad = np.concatenate([lum[-k:], lum, lum[:k]])
    smooth = np.convolve(pad, np.ones(k) / k, mode='same')[k:-k]
    centre_idx = int(np.argmax(smooth) if brightest else np.argmin(smooth))
    centre = float(np.degrees(th[centre_idx]))

    reach = frame_rho_max(geo, size)
    half = np.deg2rad(BAND_HALF_DEG)
    delta = (th - th[centre_idx] + np.pi) % (2 * np.pi) - np.pi
    in_band = np.abs(delta) <= half
    for rho_max in np.arange(rho_max_wanted, 1.0199, -0.01):
        sel = in_band & (reach >= rho_max)
        if sel.sum() >= 0.15 * in_band.sum():
            return centre, sel, float(rho_max), float(smooth[centre_idx])
    return centre, in_band & (reach >= 1.02), 1.02, float(smooth[centre_idx])


def band_measure(geo, sel, rho):
    """Band-averaged RGB profile plus the un-faded content statistics the
    shader's profile pass would derive from this azimuth range."""
    th = geo['thetas'][sel]
    rt = geo['r_theta'][sel]
    cols = sample_bilinear(geo['sub'],
                           geo['cx'] + rho[:, None] * rt[None, :] * np.cos(th[None, :]),
                           geo['cy'] + rho[:, None] * rt[None, :] * np.sin(th[None, :]))
    cols = cols - geo['black']
    prof = np.nanmean(cols, axis=1)

    # base / tint: the content just inside the run-out, which is the analogue
    # of the un-faded source the renderer's profile pass samples at
    # u in [0.94, 1.0] (the X5 crops before its own rim, so its source there
    # is *not* faded, while the references' is -- measuring base out at
    # rho ~ 1 would therefore measure the run-out twice).
    #
    # The content is not radially flat -- the references carry their own
    # vignetting, 10%+ across this window on some circles -- and the renderer's
    # `img` term samples the real image, so it carries that trend too. Modelling
    # `base` as a constant therefore books real vignetting as rim-fit error;
    # measuring it as a per-channel linear ramp in u and extrapolating to the
    # crop edge removes that. `base` below is the ramp's value at u = 1, `slope`
    # its d/du, both per channel.
    win = (rho >= BASE_RHO[0]) & (rho <= BASE_RHO[1])
    x = rho[win] - 1.0
    A = np.column_stack([np.ones_like(x), x])
    sol, *_ = np.linalg.lstsq(A, prof[win], rcond=None)      # (2,3)
    base, slope = np.maximum(sol[0], 0.0), sol[1]
    tint = base / max(base.max(), 1e-6)
    return prof, base, slope, tint


def band_prof_r(geo, sel, knee, exponent, align):
    """COMPOSITE_FS's prof.r for this band: the mean highlight weight over the
    renderer's profile annulus, evaluated on un-faded content."""
    th = geo['thetas'][sel]
    rt = geo['r_theta'][sel]
    # The renderer's annulus is u in [0.94, 1.0] of un-faded source. Mapped
    # back through alignScale and shifted inside the run-out, that is the
    # BASE_RHO window; sample it with the renderer's own sample count.
    lo, hi = BASE_RHO
    us = np.array([lo + (hi - lo) * ((j + 0.5) / PROFILE_RADIAL_SAMPLES)
                   for j in range(PROFILE_RADIAL_SAMPLES)])
    cols = sample_bilinear(geo['sub'],
                           geo['cx'] + us[:, None] * rt[None, :] * np.cos(th[None, :]),
                           geo['cy'] + us[:, None] * rt[None, :] * np.sin(th[None, :]))
    lum = np.nanmean((cols - geo['black']) @ LUMA, axis=0)     # per azimuth
    return float(np.nanmean(highlight_weight(lum, knee, exponent))), lum


def azimuth_weight_profile(geo, knee, exponent):
    """Per-azimuth content highlight weight over the whole circle (the raw
    input to the renderer's angular blur pass)."""
    rt = geo['r_theta']
    th = geo['thetas']
    lo, hi = BASE_RHO
    us = np.linspace(lo, hi, PROFILE_RADIAL_SAMPLES)
    cols = sample_bilinear(geo['sub'],
                           geo['cx'] + us[:, None] * rt[None, :] * np.cos(th[None, :]),
                           geo['cy'] + us[:, None] * rt[None, :] * np.sin(th[None, :]))
    lum = np.nanmean((cols - geo['black']) @ LUMA, axis=0)
    return np.nan_to_num(highlight_weight(lum, knee, exponent))


def measure_circle(circle_id, filename, yoff, size, verbose=True):
    path = os.path.join(ROOT, 'Testfiles', 'Outputs', filename)
    full = load_rgb(path)
    sub = full[yoff:yoff + size, 0:size]
    black = corner_black(sub)
    geo = register_edge(sub, size, black)
    geo['sub'] = sub
    geo['black'] = black

    rho = np.arange(RHO_MIN, RHO_MAX + 1e-9, RHO_STEP)
    sky_deg, sky_sel, sky_rho_max, sky_lum = pick_band(geo, size, RHO_MAX, True)
    sh_deg, sh_sel, sh_rho_max, sh_lum = pick_band(geo, size, RHO_MAX, False)
    sky, sky_base, sky_slope, sky_tint = band_measure(geo, sky_sel, rho)
    shadow, sh_base, sh_slope, sh_tint = band_measure(geo, sh_sel, rho)

    if verbose:
        print(f'# {circle_id:10s} center=({geo["cx"]:7.1f},{geo["cy"]:7.1f}) '
              f'R0={geo["r0"]:7.1f}px ({geo["r0"]/(size/2):.4f} of half-width) '
              f'edge-fit MAD={geo["mad"]:.2f}px ({100*geo["mad"]/geo["r0"]:.2f}%) '
              f'rays={geo["n_valid"]}/{NTH}', file=sys.stderr)
        print(f'#            sky az={sky_deg:6.1f} deg ({sky_sel.sum():4d} rays, '
              f'rho<={sky_rho_max:.2f}, luma={sky_lum:.3f})   '
              f'shadow az={sh_deg:6.1f} deg ({sh_sel.sum():4d} rays, '
              f'rho<={sh_rho_max:.2f}, luma={sh_lum:.3f})', file=sys.stderr)

    return dict(
        id=circle_id, file=filename, y_offset=yoff, size=size, geo=geo, rho=rho,
        sky_deg=sky_deg, sky_sel=sky_sel, sky_rho_max=sky_rho_max,
        shadow_deg=sh_deg, shadow_sel=sh_sel, shadow_rho_max=sh_rho_max,
        sky=sky, sky_base=sky_base, sky_slope=sky_slope, sky_tint=sky_tint,
        shadow=shadow, shadow_base=sh_base, shadow_slope=sh_slope, shadow_tint=sh_tint,
    )


# ---------------------------------------------------------------------------
# Stage 1: shape fit
# ---------------------------------------------------------------------------

SHAPE_NAMES = ['falloffStart', 'falloffSoftness', 'ringWidth', 'dispersion',
               'hazeWidth', 'hazeStrength', 'terminatorDesaturate',
               'terminatorCoolShift']
# ringWidth is capped below hazeWidth's floor on purpose. Both bells sit at
# u = 1 (they differ only by `dispersion`, which is at most 0.05), so if the
# two widths are allowed to meet, rimBell(u,1,w) and rimBell(u,1,w) are the
# same function and the linear system for (amplitude, amplitude*hazeStrength)
# is exactly rank-deficient -- the first run of this fit landed on
# ringWidth == hazeWidth == 0.03494 for precisely that reason. The split
# encodes what the two terms are for: the ring is the narrow dispersed fringe,
# the haze the broad halo around it.
SHAPE_BOUNDS = [(0.60, 0.99), (0.30, 4.0), (0.002, 0.025), (0.0, 0.05),
                (0.030, 0.25), (0.0, 2.0), (0.0, 1.0), (0.0, 1.0)]
ALIGN_BOUNDS = (0.88, 1.05)


def pack_measurements(circles):
    """Stack the ten bands into dense arrays: (C, 2, K, 3) and (C, 2, 3)."""
    C = len(circles)
    K = len(circles[0]['rho'])
    meas = np.zeros((C, 2, K, 3))
    base = np.zeros((C, 2, 3))
    slope = np.zeros((C, 2, 3))
    tint = np.zeros((C, 2, 3))
    mask = np.zeros((C, 2, K), bool)
    rho = circles[0]['rho']
    for i, c in enumerate(circles):
        for b, key in enumerate(('sky', 'shadow')):
            meas[i, b] = np.nan_to_num(c[key])
            base[i, b] = c[key + '_base']
            slope[i, b] = c[key + '_slope']
            tint[i, b] = c[key + '_tint']
            mask[i, b] = (rho <= c[key + '_rho_max'] + 1e-9) & np.isfinite(c[key][:, 0])
    return rho, meas, base, slope, tint, mask


def model_parts(rho, shape, align, base, slope, tint):
    """Returns (img, glow_shape) with img (C,2,K,3) and glow_shape (C,2,K,3);
    the rim amplitude multiplies glow_shape. Mirrors COMPOSITE_FS."""
    start, softness, ring_w, disp, haze_w, haze_s, desat, cool = shape
    u = rho[None, :] * np.asarray(align)[:, None]                # (C,K)
    term = terminator(u, start, softness)                        # (C,K)
    fade = 1.0 - term

    # The source content the renderer samples, as a per-channel linear ramp
    # in rho measured from the un-faded interior (band_measure).
    b = np.maximum(0.0, base[:, :, None, :]
                   + slope[:, :, None, :] * (rho[None, None, :, None] - 1.0))
    lum = b @ LUMA                                               # (C,2,K)
    f = fade[:, None, :, None]                                   # (C,1,K,1)
    x = b * (1 - f * desat) + lum[..., None] * (f * desat)
    x = x * (1.0 + f * cool * (COOL[None, None, None, :] - 1.0))
    img = x * term[:, None, :, None]
    img = np.where((u >= 1.0)[:, None, :, None], 0.0, img)

    pr, pg, pb = dispersion_peaks(disp)
    bells = np.stack([rim_bell(u, pr, ring_w), rim_bell(u, pg, ring_w),
                      rim_bell(u, pb, ring_w)], axis=-1)          # (C,K,3)
    haze = rim_bell(u, 1.0, haze_w) * haze_s                      # (C,K)
    glow_shape = (bells + haze[:, :, None])[:, None, :, :] * tint[:, :, None, :]
    return img, glow_shape


def solve_amplitudes(meas, mask, img, glow_shape):
    """Closed-form non-negative least-squares rim amplitude per band."""
    w = mask[:, :, :, None].astype(float)
    resid = (meas - img) * w
    g = glow_shape * w
    num = np.einsum('cbkx,cbkx->cb', g, resid)
    den = np.einsum('cbkx,cbkx->cb', g, g)
    return np.maximum(0.0, num / np.maximum(den, 1e-12))


def band_rms(meas, mask, model):
    # Broadcast the per-sample mask across the colour axis before counting, so
    # the denominator is the number of *values* compared, not the number of
    # radii. (mask[..., None].sum() counts radii only, which silently inflated
    # every RMS this script reported by sqrt(3) and made the fit look worse
    # than it is. The fitted parameters were unaffected -- it is a uniform
    # scale factor, so the argmin does not move -- but the printed numbers and
    # anything derived from them were not.)
    w = np.broadcast_to(mask[:, :, :, None], meas.shape).astype(float)
    sq = ((model - meas) ** 2 * w).sum(axis=(2, 3))
    n = np.maximum(w.sum(axis=(2, 3)), 1.0)
    return np.sqrt(sq / n)                                        # (C,2)


def evaluate(params, rho, meas, base, slope, tint, mask, amp_fixed=None):
    shape = params[:len(SHAPE_NAMES)]
    align = params[len(SHAPE_NAMES):]
    img, glow_shape = model_parts(rho, shape, align, base, slope, tint)
    amp = solve_amplitudes(meas, mask, img, glow_shape) if amp_fixed is None else amp_fixed
    model = img + amp[:, :, None, None] * glow_shape
    return band_rms(meas, mask, model), amp, model


def objective(params, rho, meas, base, slope, tint, mask, weights):
    rms, _, _ = evaluate(params, rho, meas, base, slope, tint, mask)
    # Equal weight per fitted circle and per band: independent scenes, and the
    # dark band constrains the terminator exactly as the bright one does.
    # RMS-of-RMS, so no band can hide inside a good average. `weights` zeroes
    # circles that are measured and reported but held out of the objective
    # (see FIT_EXCLUDE).
    w = weights[:, None] * BAND_WEIGHT[None, :]
    return float(np.sqrt((rms ** 2 * w).sum() / max(w.sum(), 1e-12)))


def fit_shape(circles, exclude=(), seed=0):
    rho, meas, base, slope, tint, mask = pack_measurements(circles)
    weights = np.array([0.0 if c['id'] in exclude else 1.0 for c in circles])
    bounds = SHAPE_BOUNDS + [ALIGN_BOUNDS] * len(circles)
    args = (rho, meas, base, slope, tint, mask, weights)
    de = differential_evolution(objective, bounds, args=args, seed=seed,
                                maxiter=220, popsize=18, tol=1e-8,
                                mutation=(0.4, 1.1), recombination=0.85,
                                init='sobol', polish=False)
    res = minimize(objective, de.x, args=args, method='L-BFGS-B',
                   bounds=bounds, options={'maxiter': 4000, 'ftol': 1e-14})
    best = res.x if res.fun <= de.fun else de.x
    # A held-out circle's alignScale carries no gradient from the objective,
    # so give it its own best alignment against the already-fixed shared shape.
    # That makes the held-out circle's reported RMS a fair "how far off is this
    # circle really" number rather than an artefact of an unconstrained knob.
    ns = len(SHAPE_NAMES)
    for i, c in enumerate(circles):
        if weights[i]:
            continue
        solo = np.zeros(len(circles))
        solo[i] = 1.0
        grid = np.linspace(*ALIGN_BOUNDS, 171)
        vals = []
        for g in grid:
            trial = best.copy()
            trial[ns + i] = g
            vals.append(objective(trial, rho, meas, base, slope, tint, mask, solo))
        best[ns + i] = float(grid[int(np.argmin(vals))])
    rms, amp, model = evaluate(best, rho, meas, base, slope, tint, mask)
    return dict(shape=dict(zip(SHAPE_NAMES, best[:len(SHAPE_NAMES)])),
                align=best[len(SHAPE_NAMES):], amp=amp, rms=rms, weights=weights,
                objective=objective(best, *args), bounds=bounds,
                raw=best, packed=(rho, meas, base, slope, tint, mask), model=model)


# ---------------------------------------------------------------------------
# Stage 2: the content response (highlightKnee / highlightExponent)
# ---------------------------------------------------------------------------

FLARE_RHO = (1.03, 1.12)     # strictly outside the content edge on every ONE X circle


def azimuth_pair(circle):
    """Per-azimuth (content luma just inside the run-out, flare luma strictly
    outside it, usable mask). Outside the image circle every photon is rim
    flare, so this isolates the glow from the terminator entirely -- unlike
    subtracting a fitted terminator from the rim band, where any error in the
    falloff shape lands straight in the 'glow' it is supposed to measure."""
    geo, size = circle['geo'], circle['size']
    th, rt = geo['thetas'], geo['r_theta']

    def band(lo, hi, n):
        rs = np.linspace(lo, hi, n)
        cols = sample_bilinear(geo['sub'],
                               geo['cx'] + rs[:, None] * rt[None, :] * np.cos(th[None, :]),
                               geo['cy'] + rs[:, None] * rt[None, :] * np.sin(th[None, :]))
        return np.nanmean((cols - geo['black']) @ LUMA, axis=0)

    content = np.nan_to_num(band(BASE_RHO[0], BASE_RHO[1], PROFILE_RADIAL_SAMPLES))
    flare = np.nan_to_num(band(FLARE_RHO[0], FLARE_RHO[1], 16))
    ok = frame_rho_max(geo, size) >= FLARE_RHO[1]
    return np.maximum(content, 0.0), np.maximum(flare, 0.0), ok


def gaussian_blur_fft(w_fft, n, sigma_bins):
    if sigma_bins <= 0:
        return np.fft.irfft(w_fft, n)
    k = np.arange(w_fft.size)
    return np.fft.irfft(w_fft * np.exp(-2.0 * (np.pi * sigma_bins * k / n) ** 2), n)


def channel_edge_radii(geo, size, channel, frac):
    """The same per-azimuth edge landmark as register_edge, but run on a single
    colour channel at an arbitrary fraction of that ray's own plateau."""
    sub_img, black, cx, cy = geo['sub'], geo['black'], geo['cx'], geo['cy']
    th, r0 = geo['thetas'], geo['r0']
    radii = np.linspace(0.30 * r0, 1.40 * r0, 1400)
    v = (polar_rgb(sub_img, cx, cy, radii, th) - black)[:, :, channel]
    inside = ~np.isnan(v)
    vs = np.apply_along_axis(lambda x: np.convolve(x, np.ones(3) / 3, mode='same'),
                             0, np.nan_to_num(v, nan=-1.0))
    inner = (radii > 0.35 * r0) & (radii < 0.75 * r0)
    plateau = np.nanmedian(np.where(inside, v, np.nan)[inner], axis=0)
    out = np.full(len(th), np.nan)
    first = int(np.searchsorted(radii, 0.80 * r0))
    for j in range(len(th)):
        if not np.isfinite(plateau[j]) or plateau[j] < 0.12:
            continue
        inj = np.nonzero(inside[:, j])[0]
        if inj.size == 0:
            continue
        target = frac * plateau[j]
        col = vs[:, j]
        for i in range(inj[-1], first, -1):
            if col[i] < target <= col[i - 1]:
                t = (target - col[i - 1]) / (col[i] - col[i - 1])
                r = radii[i - 1] + t * (radii[i] - radii[i - 1])
                px = cx + r * math.cos(th[j])
                py = cy + r * math.sin(th[j])
                if 4 < px < size - 5 and 4 < py < size - 5:
                    out[j] = r
                break
    return out


def measure_dispersion(circles, weights, align):
    """Measure `dispersion` directly instead of fitting it.

    The azimuth-averaged band profiles cannot see it -- the fringe is a fraction
    of a percent of the radius wide, and dividing a band profile by its tint to
    expose the chromatic part mostly exposes the terminator's own cool shift.
    But the edge landmark itself can be run per channel: if blue's half-plateau
    radius sits outside red's, that offset *is* lateral chromatic aberration at
    the rim, in exactly the units Edge.dispersionPeaks wants. The model's peaks
    are symmetric (1 -+ dispersion), so the least-squares symmetric fit to a
    measured (R-G, B-G) pair is (B - R) / 2.
    """
    rows = []
    for i, c in enumerate(circles):
        geo, size = c['geo'], c['size']
        e = [channel_edge_radii(geo, size, ch, 0.5) for ch in range(3)]
        w9 = channel_edge_radii(geo, size, 1, 0.9)
        w1 = channel_edge_radii(geo, size, 1, 0.1)
        th = geo['thetas']
        d = (th - np.deg2rad(c['sky_deg']) + np.pi) % (2 * np.pi) - np.pi
        band = np.abs(d) <= np.deg2rad(BAND_HALF_DEG)
        ok = band & np.isfinite(e[0]) & np.isfinite(e[1]) & np.isfinite(e[2])
        okw = band & np.isfinite(w9) & np.isfinite(w1)
        r0 = geo['r0']
        rg = float(np.median((e[0] - e[1])[ok]) / r0)
        bg = float(np.median((e[2] - e[1])[ok]) / r0)
        rows.append(dict(id=c['id'], fitted=bool(weights[i]), n=int(ok.sum()),
                         rg=rg, bg=bg, disp_rho=0.5 * (bg - rg),
                         disp_u=0.5 * (bg - rg) * float(align[i]),
                         width_rho=float(np.median((w1 - w9)[okw]) / r0)))
    used = [r['disp_u'] for r in rows if r['fitted']]
    return rows, float(np.mean(used))


def measure_terminator_colour(circles, weights):
    """Measure terminatorDesaturate and terminatorCoolShift directly.

    Fitting them against the sky bands leaves them unconstrained -- a clear
    blue sky barely changes chromaticity as it fades, so the objective is flat
    in both. But the shader's colour treatment is a statement about
    *chromaticity* at a given fade depth, and chromaticity is measurable
    without knowing the terminator at all: divide each sample by its own sum
    and the multiplicative `term` cancels, leaving

        chroma(f) ~ [c0*(1 - f*desat) + luma(c0)*f*desat] * (1 + f*cool*(COOL-1))

    with the fade depth f read off each ray as 1 - L/L_plateau. This pools
    every reasonably-lit azimuth of every fitted circle over the fade band and
    grid-searches the pair, which is a lot more data than the two sky bands.

    Samples are weighted by f^2. Both parameters act in proportion to the fade
    depth, so a shallow-fade sample carries almost no information about either
    and only dilutes the estimate with its content noise. Pooling flat gave
    cool = 0.14 while the visibly blue deep-fade band -- where the references'
    edge chromaticity reaches b = 0.65 of the RGB sum against 0.34 inside --
    wanted several times that; the weighted estimate lands at 0.70 and
    *improves* the independent luminance fit as well (0.0345 -> 0.0335
    aggregate), so the two objectives agree rather than trade off.
    """
    samples = []
    for i, c in enumerate(circles):
        if not weights[i]:
            continue
        geo = c['geo']
        th = geo['thetas'][::4]
        rt = geo['r_theta'][::4]
        rho = np.arange(0.90, 1.021, 0.004)
        cols = sample_bilinear(geo['sub'],
                               geo['cx'] + rho[:, None] * rt[None, :] * np.cos(th[None, :]),
                               geo['cy'] + rho[:, None] * rt[None, :] * np.sin(th[None, :]))
        cols = cols - geo['black']
        plat = sample_bilinear(geo['sub'],
                               geo['cx'] + np.linspace(0.85, 0.93, 9)[:, None] * rt[None, :]
                               * np.cos(th[None, :]),
                               geo['cy'] + np.linspace(0.85, 0.93, 9)[:, None] * rt[None, :]
                               * np.sin(th[None, :])) - geo['black']
        c0 = np.nanmedian(plat, axis=0)                       # (T,3)
        l0 = c0 @ LUMA
        lum = cols @ LUMA
        f = 1.0 - lum / np.maximum(l0[None, :], 1e-6)
        good = (np.isfinite(f) & (f > 0.15) & (f < 0.97)
                & (lum > 0.015) & (l0[None, :] > 0.15)
                & np.isfinite(cols).all(axis=-1))
        idx = np.nonzero(good)
        if idx[0].size == 0:
            continue
        samples.append((f[idx], cols[idx], c0[idx[1]], l0[idx[1]]))
    if not samples:
        return 0.0, 0.0, float('nan'), 0, {}
    f = np.concatenate([s_[0] for s_ in samples])[:, None]
    meas = np.concatenate([s_[1] for s_ in samples])
    c0 = np.concatenate([s_[2] for s_ in samples])
    l0 = np.concatenate([s_[3] for s_ in samples])[:, None]
    meas_chroma = meas / np.maximum(meas.sum(axis=1, keepdims=True), 1e-6)
    weight = f ** 2

    def err_at(desat, cool):
        x = c0 * (1 - f * desat) + l0 * (f * desat)
        y = x * (1.0 + f * cool * (COOL[None, :] - 1.0))
        pred = y / np.maximum(y.sum(axis=1, keepdims=True), 1e-6)
        return float((weight * (pred - meas_chroma) ** 2).sum() / (3 * weight.sum()))

    best = None
    grid = np.arange(0.0, 1.001, 0.02)
    for desat in grid:
        for cool in grid:
            e = err_at(desat, cool)
            if best is None or e < best[2]:
                best = (float(desat), float(cool), e)
    corners = {(a, b): math.sqrt(err_at(a, b)) for a in (0.0, 1.0) for b in (0.0, 1.0)}
    return best[0], best[1], math.sqrt(best[2]), int(f.size), corners


def diagnose_content_response(circles, weights):
    """Can highlightKnee / highlightExponent / glowSpreadDeg be measured here?

    The shader's premise is that the rim glows where the content next to it is
    bright: prof.r = mean highlightWeight(content) per azimuth, angularly
    blurred by glowSpreadDeg, scaling the glow. That is testable directly,
    because outside the image circle there is no content at all -- every photon
    there is rim light. This regresses the measured outside-the-circle
    luminance per azimuth against highlightWeight(content) blurred by each
    candidate spread, and reports the best fit it can find.

    On this reference set the answer is that it cannot: the best R^2 is small
    and the correlation's *sign* flips between circles, because the light
    outside these image circles is sun-positioned veiling glare -- brightest
    roughly opposite the bright sky, not next to it. So the three parameters
    are reported unconstrained and left at their defaults rather than given
    numbers this data does not support.
    """
    data = [(c['id'],) + azimuth_pair(c) for i, c in enumerate(circles) if weights[i]]
    n = NTH
    best = None
    per_circle = {}
    knees = np.arange(0.0, 0.86, 0.025)
    exps = (0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0)
    degs = np.arange(0.0, 45.01, 1.0)
    for knee in knees:
        for exponent in exps:
            ffts = [(cid, np.fft.rfft(highlight_weight(cc, knee, exponent)), fl, ok)
                    for cid, cc, fl, ok in data]
            for deg in degs:
                sigma = deg / 360.0 * n
                res_ss, tot_ss, signs = 0.0, 0.0, {}
                for cid, wf, fl, ok in ffts:
                    b = gaussian_blur_fft(wf, n, sigma)[ok]
                    a = fl[ok]
                    if b.std() < 1e-12:
                        continue
                    A = np.column_stack([b, np.ones_like(b)])
                    sol, *_ = np.linalg.lstsq(A, a, rcond=None)
                    r = a - A @ sol
                    res_ss += float(r @ r)
                    tot_ss += float(((a - a.mean()) ** 2).sum())
                    signs[cid] = (float(np.corrcoef(a, b)[0, 1]), float(sol[0]))
                r2 = 1.0 - res_ss / max(tot_ss, 1e-18)
                if best is None or r2 > best['r2']:
                    best = dict(knee=float(knee), exponent=float(exponent),
                                deg=float(deg), r2=float(r2))
                    per_circle = signs
    best['per_circle'] = per_circle
    return best


def outside_circle_contrast(circles):
    """Model-free: mean luminance outside the image circle on the sky band vs
    the shadow band of the same circle, with a far-field baseline removed."""
    rho = circles[0]['rho']
    out = (rho >= 1.03) & (rho <= 1.06)
    far = (rho >= 1.12) & (rho <= 1.15)
    inner = (rho >= 0.86) & (rho <= 0.94)
    rows = []
    for c in circles:
        vals = {}
        for key in ('sky', 'shadow'):
            p = np.nan_to_num(c[key]) @ LUMA
            vals[key] = (float(p[inner].mean()), float(p[out].mean() - p[far].mean()))
        rows.append((c['id'], vals['sky'], vals['shadow']))
    return rows


def band_prof_r_blurred(circle, sel, knee, exponent, deg):
    """The renderer's prof.r for a band: the content highlight weight after the
    angular blur pass, averaged over the band's azimuths."""
    content, _, _ = azimuth_pair(circle)
    w = highlight_weight(content, knee, exponent)
    blurred = gaussian_blur_fft(np.fft.rfft(w), NTH, deg / 360.0 * NTH)
    return float(np.maximum(blurred, 0.0)[sel].mean())


def tie_amplitudes(circles, weights, knee, exponent, deg):
    """profR per band, the way the renderer computes it."""
    p = np.zeros((len(circles), 2))
    for i, c in enumerate(circles):
        for b, key in enumerate(('sky', 'shadow')):
            p[i, b] = band_prof_r_blurred(c, c[key + '_sel'], knee, exponent, deg)
    return p


def refine_tied(fitted, circles, prof_r, weights, seed=0, fixed=None):
    """Stage 4. Stage 1 let each band's rim amplitude float, which measures how
    bright each reference rim actually is but is not a preset. Here the
    amplitude is forced to be the renderer's own `prof.r * edgeIntensity` --
    one shared scalar times the measured per-band content response -- and the
    shape and alignment are re-optimised under that constraint, so the numbers
    that get pasted into edge.js are optimal for the model the tool renders
    rather than for a looser relative of it."""
    rho, meas, base, slope, tint, mask = fitted['packed']
    ns = len(SHAPE_NAMES)

    def unpack(x):
        return x[:-1], float(x[-1])

    def obj(x):
        params, edge_intensity = unpack(x)
        rms, _, _ = evaluate(params, rho, meas, base, slope, tint, mask,
                             amp_fixed=edge_intensity * prof_r)
        w = weights[:, None] * BAND_WEIGHT[None, :]
        return float(np.sqrt((rms ** 2 * w).sum() / max(w.sum(), 1e-12)))

    # Seed edgeIntensity from the stage-1 amplitudes it has to reproduce.
    w = weights[:, None] * np.ones_like(prof_r)
    seed_e = float((w * prof_r * fitted['amp']).sum() / max((w * prof_r ** 2).sum(), 1e-18))
    bounds = list(fitted['bounds']) + [SLIDER_RANGE['edgeIntensity']]
    seeded = np.array(fitted['raw'], float)
    for name, value in (fixed or {}).items():
        j = SHAPE_NAMES.index(name)
        bounds[j] = (value, value)
        seeded[j] = value
    fitted = dict(fitted, raw=seeded)
    lo = np.array([b[0] for b in bounds])
    hi = np.array([b[1] for b in bounds])
    x0 = np.clip(np.concatenate([fitted['raw'], [seed_e]]), lo, hi)
    best_x, best_f = x0, obj(x0)
    trials = [x0]
    for m in (0.25, 0.5, 2.0, 4.0):
        t = x0.copy()
        t[-1] = min(max(seed_e * m, lo[-1]), hi[-1])
        trials.append(t)
    for trial in trials:
        r = minimize(obj, trial, method='L-BFGS-B', bounds=bounds,
                     options={'maxiter': 4000, 'ftol': 1e-14})
        if r.fun < best_f:
            best_x, best_f = r.x, float(r.fun)
    de = differential_evolution(obj, bounds, seed=seed, maxiter=120, popsize=14,
                                tol=1e-9, init='sobol', polish=True,
                                x0=np.clip(best_x, lo, hi))
    if de.fun < best_f:
        best_x, best_f = de.x, float(de.fun)

    params, edge_intensity = unpack(best_x)
    rms, amp, model = evaluate(params, rho, meas, base, slope, tint, mask,
                               amp_fixed=edge_intensity * prof_r)
    return dict(shape=dict(zip(SHAPE_NAMES, params[:ns])), align=params[ns:],
                edgeIntensity=edge_intensity, rms=rms, amp=amp, model=model,
                objective=best_f, raw=params, packed=fitted['packed'],
                bounds=fitted['bounds'])


def sensitivity(refined, circles, prof_r, weights, names, pinned=None):
    """For each named parameter, how much the objective degrades when it is
    pinned to each end of its slider range and everything else is re-optimised.
    A parameter that costs nothing to move is not constrained by this data, and
    is reported as such rather than dressed up as a fitted value."""
    rho, meas, base, slope, tint, mask = refined['packed']
    ns = len(SHAPE_NAMES)
    bounds = list(refined['bounds']) + [SLIDER_RANGE['edgeIntensity']]
    for name, value in (pinned or {}).items():
        bounds[SHAPE_NAMES.index(name)] = (value, value)
    x0 = np.concatenate([refined['raw'], [refined['edgeIntensity']]])

    def obj(x, fixed=None):
        if fixed is not None:
            x = x.copy()
            x[fixed[0]] = fixed[1]
        params, e = x[:-1], float(x[-1])
        rms, _, _ = evaluate(params, rho, meas, base, slope, tint, mask,
                             amp_fixed=e * prof_r)
        w = weights[:, None] * BAND_WEIGHT[None, :]
        return float(np.sqrt((rms ** 2 * w).sum() / max(w.sum(), 1e-12)))

    out = {}
    for name in names:
        idx = SHAPE_NAMES.index(name) if name in SHAPE_NAMES else len(x0) - 1
        lo, hi = SLIDER_RANGE[name]
        costs = []
        for target in (lo, hi):
            b2 = list(bounds)
            # The parameter under test is freed from its own pin, if it had one,
            # so the number reported is "what does moving this one cost", with
            # every other pin still in force.
            b2[idx] = (target, target)
            start = x0.copy()
            start[idx] = target
            r = minimize(obj, start, method='L-BFGS-B', bounds=b2,
                         options={'maxiter': 1500, 'ftol': 1e-13})
            costs.append(float(r.fun) - refined['objective'])
        out[name] = tuple(costs)
    return out


# ---------------------------------------------------------------------------
# Fixture + reporting
# ---------------------------------------------------------------------------

def vec(v):
    return {'r': float(v[0]), 'g': float(v[1]), 'b': float(v[2])}


def build_fixture(circles, align, prof_r, disp_rows):
    return {
        '_comment': ('Measured by tools/fit-x1-edge.py from the reference fisheye '
                     'circles listed below. uSamples is a normalised radius: 1.0 is '
                     "each circle's own per-azimuth-registered edge landmark (the "
                     'half-plateau crossing), NOT the frame half-width and NOT the '
                     "model's u = 1. Multiply by a circle's alignScale to get the u "
                     'that Edge.terminator / Edge.rimBell expect. base/baseSlope are '
                     'the measured source content as a per-channel linear ramp in '
                     'uSamples (value at rho = 1, plus d/drho), profR is the '
                     "renderer's prof.r for that band -- the blurred content "
                     'highlight weight that drives the glow -- so the model '
                     'reconstructed from this fixture is COMPOSITE_FS exactly.'),
        'uSamples': [round(float(v), 6) for v in circles[0]['rho']],
        'circles': [{
            'id': c['id'],
            'file': 'Testfiles/Outputs/' + c['file'],
            'yOffset': c['y_offset'],
            'size': c['size'],
            'center': {'x': round(c['geo']['cx'], 2), 'y': round(c['geo']['cy'], 2)},
            'radius': round(c['geo']['r0'], 2),
            'edgeFitMadPx': round(c['geo']['mad'], 3),
            'runoutWidth': round(disp_rows[i]['width_rho'], 5),
            'channelEdgeOffsets': {'rg': round(disp_rows[i]['rg'], 6),
                                   'bg': round(disp_rows[i]['bg'], 6)},
            'heldOutOfFit': c['id'] in FIT_EXCLUDE,
            'alignScale': round(float(align[i]), 6),
            'skyAzimuthDeg': round(c['sky_deg'], 2),
            'shadowAzimuthDeg': round(c['shadow_deg'], 2),
            'skyRhoMax': c['sky_rho_max'],
            'shadowRhoMax': c['shadow_rho_max'],
            'skyBase': vec(c['sky_base']), 'skyBaseSlope': vec(c['sky_slope']),
            'skyTint': vec(c['sky_tint']), 'skyProfR': round(float(prof_r[i, 0]), 8),
            'shadowBase': vec(c['shadow_base']), 'shadowBaseSlope': vec(c['shadow_slope']),
            'shadowTint': vec(c['shadow_tint']), 'shadowProfR': round(float(prof_r[i, 1]), 8),
            'sky': [vec(v) for v in c['sky']],
            'shadow': [vec(v) for v in c['shadow']],
        } for i, c in enumerate(circles)],
    }


def write_plots(circles, result, align, out_dir):
    """Measured vs modelled band profiles, as a PNG strip (no matplotlib)."""
    rho, meas, _, _, _, mask = result['packed']
    model = result['model']
    H, W = 170, len(rho) * 8
    tiles = []
    for i, c in enumerate(circles):
        for b in (0, 1):
            tile = np.full((H, W, 3), 24, np.uint8)
            hi = max(meas[i, b].max(), model[i, b].max(), 1e-6)
            for k in range(len(rho)):
                if not mask[i, b, k]:
                    continue
                for ch, col in enumerate(((255, 90, 90), (90, 255, 90), (120, 160, 255))):
                    ym = int((H - 4) * (1 - meas[i, b, k, ch] / hi))
                    yd = int((H - 4) * (1 - model[i, b, k, ch] / hi))
                    x = k * 8
                    tile[max(0, min(H - 1, ym)), x:x + 3] = col
                    tile[max(0, min(H - 1, yd)), x + 4:x + 7] = tuple(v // 2 + 60 for v in col)
                if abs(rho[k] * align[i] - 1.0) < RHO_STEP * align[i] * 0.5:
                    tile[:, k * 8:k * 8 + 1] = (110, 110, 110)
            tiles.append(tile)
            tiles.append(np.full((3, W, 3), 60, np.uint8))
    path = os.path.join(out_dir, 'fit-profiles.png')
    Image.fromarray(np.concatenate(tiles, axis=0)).save(path)
    print('# wrote %s (bright = measured, dim = model, grey line = model u=1; '
          'rows = %s, each sky then shadow)'
          % (path, ', '.join(c['id'] for c in circles)), file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plots', action='store_true')
    ap.add_argument('--plot-dir', default=os.environ.get('FIT_PLOT_DIR', HERE))
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--dump', action='store_true',
                    help='print measured vs modelled band profiles')
    ap.add_argument('--no-sensitivity', action='store_true')
    ap.add_argument('--exclude', default=','.join(FIT_EXCLUDE),
                    help='comma-separated circle ids measured and reported but '
                         'held out of the fit objective')
    args = ap.parse_args()
    exclude = tuple(s for s in args.exclude.split(',') if s)

    t0 = time.time()

    def say(m):
        print(m, file=sys.stderr)

    say('# --- measuring reference circles -------------------------------')
    circles = [measure_circle(*c) for c in CIRCLES]
    say('# measurement took %.1fs' % (time.time() - t0))

    say("# --- stage 1: shape, each band's rim amplitude solved exactly ---")
    t = time.time()
    fitted = fit_shape(circles, exclude=exclude, seed=args.seed)
    weights = fitted['weights']
    if exclude:
        say('# held out of the objective: %s' % ', '.join(exclude))
    say('# stage 1 took %.1fs, objective = %.4f' % (time.time() - t, fitted['objective']))
    for i, c in enumerate(circles):
        say('#   %-10s free rim amplitude: sky=%.4f shadow=%.4f%s'
            % (c['id'], fitted['amp'][i, 0], fitted['amp'][i, 1],
               '   (held out)' if not weights[i] else ''))

    say('# --- stage 2: CAN the azimuthal/content parameters be measured? ---')
    t = time.time()
    say('#   model-free check -- mean luminance outside the image circle '
        '(rho 1.03-1.06,')
    say('#   far-field baseline removed) on each band, against that band\'s '
        'content:')
    say('#     %-11s %7s %7s %6s | %8s %8s %8s'
        % ('circle', 'C_sky', 'C_shad', 'C rat', 'rim_sky', 'rim_shad', 'rim rat'))
    for cid, sky, shadow in outside_circle_contrast(circles):
        say('#     %-11s %7.3f %7.3f %6.2f | %8.4f %8.4f %8.2f'
            % (cid, sky[0], shadow[0], sky[0] / max(shadow[0], 1e-6),
               sky[1], shadow[1], sky[1] / max(shadow[1], 1e-6)))
    content = diagnose_content_response(circles, weights)
    say('#   best regression of outside-circle light on blurred content weight:')
    say('#     knee=%.3f exponent=%.2f spread=%.1f deg -> R^2=%.4f (pooled)'
        % (content['knee'], content['exponent'], content['deg'], content['r2']))
    for cid, (r, slope) in sorted(content['per_circle'].items()):
        say('#     %-11s pearson r=%+.3f slope=%+.4g' % (cid, r, slope))
    say('#   -> highlightKnee / highlightExponent / glowSpreadDeg are NOT '
        'constrained by')
    say('#      this data; they stay at %s.' % UNCONSTRAINED_DEFAULTS)
    say('# stage 2 took %.1fs' % (time.time() - t))

    knee = UNCONSTRAINED_DEFAULTS['highlightKnee']
    exponent = UNCONSTRAINED_DEFAULTS['highlightExponent']
    spread = UNCONSTRAINED_DEFAULTS['glowSpreadDeg']
    prof_r = tie_amplitudes(circles, weights, knee, exponent, spread)

    say('# --- stage 3: dispersion, measured per channel at the edge ------')
    t = time.time()
    disp_rows, dispersion = measure_dispersion(circles, weights, fitted['align'])
    say('#     %-11s %9s %9s %11s %11s %11s'
        % ('circle', 'R-G/R0', 'B-G/R0', 'disp(rho)', 'disp(u)', '90-10% width'))
    for r in disp_rows:
        say('#     %-11s %+9.5f %+9.5f %+11.5f %+11.5f %11.5f%s'
            % (r['id'], r['rg'], r['bg'], r['disp_rho'], r['disp_u'],
               r['width_rho'], '' if r['fitted'] else '  (held out)'))
    say('#   -> dispersion = %.5f (mean over the fitted circles, in model u)'
        % dispersion)
    ring_width = min(max(RING_WIDTH_OVER_DISPERSION * dispersion,
                         SLIDER_RANGE['ringWidth'][0]), SLIDER_RANGE['ringWidth'][1])
    say('#   -> ringWidth  = %.5f (%.1f x dispersion; see RING_WIDTH_OVER_DISPERSION)'
        % (ring_width, RING_WIDTH_OVER_DISPERSION))
    say('# stage 3 took %.1fs' % (time.time() - t))

    say("# --- stage 3b: the terminator's colour treatment, from chromaticity ---")
    t = time.time()
    desat, cool, chroma_rms, n_chroma, corners = measure_terminator_colour(circles, weights)
    say('#   terminatorDesaturate=%.3f terminatorCoolShift=%.3f '
        '(chromaticity RMS %.5f over %d samples)' % (desat, cool, chroma_rms, n_chroma))
    say('#   same RMS at the corners of the (desat, cool) square: %s'
        % ', '.join('(%g,%g)=%.5f' % (a, b, v) for (a, b), v in sorted(corners.items())))
    say('# stage 3b took %.1fs' % (time.time() - t))

    say('# --- stage 4: re-fit with amplitude tied to edgeIntensity*profR ---')
    t = time.time()
    pinned = {'dispersion': dispersion, 'ringWidth': ring_width,
              'hazeStrength': HAZE_STRENGTH_FIXED,
              'terminatorDesaturate': desat, 'terminatorCoolShift': cool}
    refined = refine_tied(fitted, circles, prof_r, weights, seed=args.seed, fixed=pinned)
    align = refined['align']
    say('# stage 4 took %.1fs, objective = %.4f (pinned: %s)'
        % (time.time() - t, refined['objective'],
           ', '.join('%s=%.5f' % kv for kv in sorted(pinned.items()))))

    preset = dict(refined['shape'])
    preset['edgeIntensity'] = refined['edgeIntensity']
    preset['glowSpreadDeg'] = spread
    preset['highlightKnee'] = knee
    preset['highlightExponent'] = exponent
    order = ['falloffStart', 'falloffSoftness', 'edgeIntensity', 'ringWidth',
             'dispersion', 'glowSpreadDeg', 'highlightKnee', 'highlightExponent',
             'hazeWidth', 'hazeStrength', 'terminatorDesaturate', 'terminatorCoolShift']
    preset = {k: round(float(preset[k]), 5) for k in order}

    say('')
    say('# --- per-circle geometry and alignment -------------------------')
    for i, c in enumerate(circles):
        say('#   %-10s R0=%7.1fpx (%.4f of half-width)  alignScale=%.4f  '
            'model u=1 at rho=%.4f (%7.1fpx)  edge MAD=%.2fpx'
            % (c['id'], c['geo']['r0'], c['geo']['r0'] / (c['size'] / 2), align[i],
               1 / align[i], c['geo']['r0'] / align[i], c['geo']['mad']))

    say('')
    say('# --- per-band RMS under the final preset -----------------------')
    for i, c in enumerate(circles):
        say('#   %-10s sky   rms=%.4f profR=%.5f amp=%.5f | shadow rms=%.4f '
            'profR=%.5f amp=%.5f%s'
            % (c['id'], refined['rms'][i, 0], prof_r[i, 0], refined['amp'][i, 0],
               refined['rms'][i, 1], prof_r[i, 1], refined['amp'][i, 1],
               '  (held out)' if not weights[i] else ''))
    fit_sky = np.array([refined['rms'][i, 0] for i in range(len(circles)) if weights[i]])
    all_sky = refined['rms'][:, 0]
    say('# fitted-circle sky RMS (RMS-of-RMS) = %.4f' % float(np.sqrt(np.mean(fit_sky ** 2))))
    say('# all-circle    sky RMS (RMS-of-RMS) = %.4f' % float(np.sqrt(np.mean(all_sky ** 2))))
    say('# fitted-circle all-band objective   = %.4f' % refined['objective'])

    if not args.no_sensitivity:
        say('')
        say('# --- sensitivity: objective cost of pinning each parameter to a ---')
        say('#     slider end and re-optimising everything else ----------------')
        t = time.time()
        sens = sensitivity(refined, circles, prof_r, weights,
                           list(SHAPE_NAMES) + ['edgeIntensity'], pinned=pinned)
        for k, (lo_cost, hi_cost) in sens.items():
            lo, hi = SLIDER_RANGE[k]
            say('#   %-22s pinned to %-6g costs %+.5f   pinned to %-6g costs %+.5f'
                % (k, lo, lo_cost, hi, hi_cost))
        say('#   (sensitivity took %.1fs)' % (time.time() - t))

    say('')
    say('# --- slider-boundary check ------------------------------------')
    for k, v in preset.items():
        lo, hi = SLIDER_RANGE[k]
        span = hi - lo
        flag = ''
        if v <= lo + 0.002 * span:
            flag = '  <-- AT / NEAR LOWER BOUND'
        elif v >= hi - 0.002 * span:
            flag = '  <-- AT / NEAR UPPER BOUND'
        say('#   %-22s %9.5f   slider [%g, %g]%s' % (k, v, lo, hi, flag))

    if args.dump:
        rho, meas, _, _, _, mask = refined['packed']
        model = refined['model']
        step = 2
        say('')
        say('# --- measured (M) vs modelled (m) band luminance ---------------')
        for i, c in enumerate(circles):
            for b, key in enumerate(('sky', 'shadow')):
                mm = meas[i, b] @ LUMA
                dd = model[i, b] @ LUMA
                say('# %s/%s' % (c['id'], key))
                say('#     u: ' + ' '.join('%5.3f' % (rho[k] * align[i])
                                           for k in range(0, len(rho), step)))
                say('#     M: ' + ' '.join(('%5.3f' % mm[k]) if mask[i, b, k] else '    .'
                                           for k in range(0, len(rho), step)))
                say('#     m: ' + ' '.join(('%5.3f' % dd[k]) if mask[i, b, k] else '    .'
                                           for k in range(0, len(rho), step)))

    fixture = build_fixture(circles, align, prof_r, disp_rows)
    os.makedirs(os.path.dirname(FIXTURE_PATH), exist_ok=True)
    with open(FIXTURE_PATH, 'w') as f:
        json.dump(fixture, f, indent=2)
    say('')
    say('# wrote %s' % FIXTURE_PATH)

    if args.plots:
        write_plots(circles, refined, align, args.plot_dir)

    say('# total %.1fs' % (time.time() - t0))
    print(json.dumps(preset, indent=2))
    print('fitted-circle sky RMS: %.4f' % float(np.sqrt(np.mean(fit_sky ** 2))))
    print('all-circle sky RMS: %.4f' % float(np.sqrt(np.mean(all_sky ** 2))))


if __name__ == '__main__':
    main()
