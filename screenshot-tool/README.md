# BlackUI screenshot tool

Runs inside the end user's own GitHub repo (Actions). It opens an HTML app in headless Chromium,
finds the screens, and captures them at the device sizes given in `request.json`.

## One repo, many apps (jobs)
Each app gets its own folder: `jobs/<job>/app.html` + `jobs/<job>/request.json` (job = letters, digits, `-`, `_`).
Run the workflow with the `job` input (e.g. `magic-doodle`). Without `job` the legacy `screenshot-tool/input/` folder is used.
The run is named `Capture Screenshots - <job>` and the artifacts are `shots-preview-<job>` / `shots-full-<job>`.

## Files
- `jobs/<job>/app.html` — the app to capture (the dashboard overwrites this). Extra files (css, js, images) can sit next to it.
- `jobs/<job>/request.json` — what to capture (see below).
- `capture.mjs` — scanner + capture.
- `../.github/workflows/screenshots.yml` — the workflow (manual trigger only, so it never runs on push).

## Output (two artifacts)
- `shots-preview-<job>`: `manifest.json` + `thumbs/*.jpg` (320px wide). Small. The AI looks at these.
- `shots-full-<job>`: `<screenKey>__<deviceId>.png` at full resolution (opaque 24-bit PNG).

`manifest.json` lists every screen, the files per device, skipped items and warnings.
- `skipped[].reason` says which step failed, e.g. `step 3: not found: #guideGrid button.nope` (the button the AI named does not exist).
- `screens[].buttons` lists the buttons visible on that screen (first device only), so the AI can repair a plan in round 2.
- `screens[].files.<device>.looksLike` flags a screen that is nearly identical to an earlier one.
If a run fails, `manifest.json` still exists with `"ok": false` and an `error` message.

## request.json
```json
{
  "version": 1,
  "entry": "app.html",
  "devices": [
    { "id": "phone", "width": 360, "height": 640, "scale": 3, "mobile": true }
  ],
  "maxCandidates": 16,
  "minChange": 0.1,
  "maxDepth": 3,
  "settleMs": 800,
  "seed": { "localStorage": { "demo": "1" } },
  "blockedWords": ["withdraw"],
  "screens": [ { "key": "settings", "steps": [ { "click": "#btnSettings" } ] } ]
}
```
- `devices`: up to 4. Output pixels = width x height x scale. Nothing is forced to a store preset;
  Google Play rule hints show up in `warnings` only.
- `screens` (optional): an exact list. If given, nothing is scanned. **At most 20 screens per run** (extra ones are dropped with a warning). Every click/fill target is checked first; a missing button skips only that screen. Step types: `click`, `fill:[selector,value]`, `press`, `wait`, `drag:[[x,y],[x,y],...]` (draw on a canvas; CSS px).
- `seed.localStorage` (optional): demo data set before the app starts.
- `blockedWords` (optional): extra words that stop a button from being clicked while scanning.

## How screens are found (first match wins)
1. **plan** — `request.screens` is present (the normal case: the AI reads the app's code and writes the plan; see `examples/magic-doodle-plan.json`).
2. **hook** — the app defines `window.__shots = { screens: ['home','stats'], show(key) { ... } }`.
   Best option for AI-generated apps (reliable, also works for canvas games).
3. **scan** (fallback only) — click through buttons/tabs (depth <= `maxDepth`), keep screens that differ by at least
   `minChange` (4% by default) from every screen already kept. Buttons with words like delete, reset,
   buy, logout, install are never clicked. A `data-screen="name"` attribute on a screen's root element gives it a clean name.

## Landscape / games
Landscape is just a device with width > height (e.g. `{ "id": "land", "width": 740, "height": 360, "scale": 2 }`).
Some apps (e.g. racing games) show a "turn your phone" overlay in portrait, so use a landscape device for them.

## Limits to know about
- Canvas games with no hook and no clickable buttons will only give the first screen.
- Screens that need data (e.g. a filled list) need `seed.localStorage` or a hook.
- Time budget: about 11 minutes per run. `clickTimeoutMs` (default 1500) is how long to wait for a button before skipping it.
- A new screen counts as different if its pixels differ by `minChange` OR most of its visible words changed.
