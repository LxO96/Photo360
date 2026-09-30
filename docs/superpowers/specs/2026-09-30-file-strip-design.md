# File strip — design

Date: 2026-09-30. First of three sub-projects (1. file strip, 2. bracket
merge, 3. HDR display/export); the merge builds on the strip's multi-file
handling.

## Goal

Open many photos at once, see them as thumbnails, and move between them,
with each photo keeping its own edits. It must stay light in the browser:
only the open photo holds full-size GPU data.

## What the user said / decided

- Open several files at once with previews; drop the idea if too heavy.
- Edits are per photo; a newly seen photo starts from the last-used
  settings (today's behaviour); copy/paste edits between photos.

## Loading

- The Open dialog (`multiple`) and drag-and-drop accept any number of
  `.insp` / `.jpg` / `.dng` files. Unsupported files are skipped with one
  note naming them.
- Each photo is a strip entry `{ id, file, key, thumb, settings, history,
  edited }`. `file` is the browser `File` (read lazily; not held in memory).
- The first file added opens straight away (when nothing is open); others
  just join the strip. Adding a file already in the strip (same key) does
  not duplicate it.
- Opening a photo runs the existing `loadFile` path, so only one photo's
  textures exist. Switching re-decodes (~1–2 s for a DNG). A load in flight
  is superseded by a newer switch (only the latest request commits).

## Photo key and per-photo settings

- `key = name + '|' + size + '|' + lastModified`.
- Per-photo settings are the persisted edit settings (PERSISTED_KEYS minus
  view/app-level keys: zoom, before view, panel state, key layout, and the
  like). They are stored in localStorage under
  `photo360.photo.v1.<key>`, with an LRU index capped at 500 photos so
  storage cannot grow without bound.
- Switching away saves the current photo's settings into its entry and to
  storage. Opening a photo applies, in order: stored settings for its key
  if any; else the last-used settings (current behaviour). File-derived
  fields (calibration, raw WB as shot, lens count…) still come from the
  file, exactly as `applyLoadedDescriptor` does today.
- The global `photo360.settings.v1` blob stays: it is the "last-used"
  settings and holds app-level preferences.
- Undo history is per photo and session-only (each entry keeps its own
  History instance; switching swaps it in).

## Thumbnails

Two stages, built in the background one file at a time (idle-time queue,
so the UI stays responsive):

1. **Quick preview**, on add:
   - `.insp` / `.jpg`: the embedded EXIF thumbnail (JPEG in APP1) when
     present, else `createImageBitmap(file, {resizeWidth})` of the whole
     image.
   - `.dng`: no embedded preview in these files, so a decimated read of the
     CFA data on the CPU: sample one 2×2 Bayer block every N pixels
     (target ~256 px long side), subtract black, scale by white, apply the
     as-shot neutral and an sRGB gamma. Only the needed rows are read from
     the file (`file.slice`), not the whole 37 MB.
   - The quick preview shows the raw capture (both fisheye circles), not
     the edited composition.
2. **Rendered preview**: once a photo has been opened, its thumbnail is a
   small snapshot (~256 px long side) of the actual composition with its
   edits, refreshed when an edit settles (the same settle point as undo
   history: 400 ms idle / pointerup). Rendered previews are session-only.

Thumbnails are stored as small blobs/object URLs (revoked on remove).

## Strip UI

- A horizontal filmstrip along the bottom of the stage, collapsible
  (state remembered as an app-level setting). Hidden when fewer than two
  photos are open.
- Each thumbnail: the image, file name on hover, a dot when the photo has
  been edited, a remove × on hover. The open photo is outlined; selected
  photos are highlighted.
- Click opens; Ctrl-click toggles selection; Shift-click selects a range.
  The open photo is always part of the selection.
- Removing the open photo opens its neighbour; removing the last photo
  returns to the empty drop screen.

## Copy / paste edits

- Ctrl+Shift+C copies the open photo's edit settings; Ctrl+Shift+V pastes
  them onto every selected photo (including the open one). Both are listed
  in the Keys help and work in the Swedish layout.
- Paste copies every edit, levelling (Camera roll, lens nudge) included
  (changed 2026-09-30 at the user's request). File-derived data
  (calibration, lens count) is never part of the edits.
- Pasting onto a photo that is not open updates its stored settings and
  marks its rendered preview stale (it falls back to the quick preview
  until opened again).
- Paste onto the open photo is one undo step.

## Navigation

- Ctrl+→ / Ctrl+← open the next / previous photo in the strip (shortcut
  table, both layouts).

## Export all

- When more than one photo is selected, the Export button reads
  "Export N". It opens, renders and saves each selected photo in turn with
  its own settings, then returns to the photo that was open. A progress
  note shows "Exporting 3 of 8"; Esc cancels after the current photo.
- Each file is downloaded under its usual export name (browser download,
  as today).

## Error handling

- A file that fails to decode keeps its strip entry with an error badge;
  opening it shows the existing load error message; other photos are
  unaffected.
- A failed thumbnail leaves a placeholder with the file name.
- localStorage full: per-photo settings fall back to session memory with
  one warning.

## Not included

- Remembering the strip across a page reload (the browser would have to
  ask for file access again). Edits are still restored when the same file
  is opened again.
- Sorting/filtering the strip, star ratings, folders.

## Testing

- Unit tests (node, as the existing `test/*.test.js`):
  - photo store: key, save/load, LRU cap, fallback to last-used;
  - paste filter: geometry keys left out, everything else copied;
  - DNG decimated preview: a synthetic CFA plane gives the expected
    colours, size and orientation; only the requested rows are read;
  - EXIF thumbnail extraction from a synthetic JPEG with an APP1 thumbnail.
- Headless Chrome run (cdp.py): open 3 test files at once, check three
  thumbnails appear, edit photo 1, switch to 2 and back, check each keeps
  its own settings; copy/paste to a selection; Export 2 writes two files.
