# BlackUI screenshot tool

Runs inside the end user's own GitHub repo (Actions). It opens an HTML app in headless Chromium,
finds the screens, and captures them at the device sizes given in `input/request.json`.

## Files
- `input/app.html` — the app to capture (the dashboard overwrites this). Extra files (css, js, images) can sit next to it.
- `input/request.json` — what to capture (see below).
- `capture.mjs` — scanner + capture.
- `../.github/workflows/screenshots.yml` — the workflow (manual trigger only, so it never runs on push).

## Output (two artifacts)
- `shots-preview`: `manifest.json` + `thumbs/*.jpg` (320px wide). Small. The AI looks at these.
- `shots-full`: `<screenKey>__<deviceId>.png` at full resolution (opaque 24-bit PNG).

`manifest.json` lists every screen, the files per device, skipped items and warnings.
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
- `screens` (optional): an exact list. If given, nothing is scanned. Step types: `click`, `fill:[selector,value]`, `press`, `wait`, `drag:[[x,y],[x,y],...]` (draw on a canvas; CSS px).
- `seed.localStorage` (optional): demo data set before the app starts.
- `blockedWords` (optional): extra words that stop a button from being clicked while scanning.

## How screens are found (first match wins)
1. **plan** — `request.screens` is present.
2. **hook** — the app defines `window.__shots = { screens: ['home','stats'], show(key) { ... } }`.
   Best option for AI-generated apps (reliable, also works for canvas games).
3. **scan** — click through buttons/tabs (depth <= `maxDepth`), keep screens that differ by at least
   `minChange` (10% by default) from every screen already kept. Buttons with words like delete, reset,
   buy, logout, install are never clicked. A `data-screen="name"` attribute on a screen's root element gives it a clean name.

## Landscape / games
Landscape is just a device with width > height (e.g. `{ "id": "land", "width": 740, "height": 360, "scale": 2 }`).
Some apps (e.g. racing games) show a "turn your phone" overlay in portrait, so use a landscape device for them.

## Limits to know about
- Canvas games with no hook and no clickable buttons will only give the first screen.
- Screens that need data (e.g. a filled list) need `seed.localStorage` or a hook.
- Time budget: about 11 minutes per run. `clickTimeoutMs` (default 1500) is how long to wait for a button before skipping it.
- A new screen counts as different if its pixels differ by `minChange` OR most of its visible words changed.
