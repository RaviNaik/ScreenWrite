# On-Screen Writer

A lightweight Chrome extension (Manifest V3) that lets you draw, highlight,
underline, and annotate directly on top of any webpage — pen, highlighter,
underline, eraser, shapes, and a text tool, with adjustable color/width and
a transparent-or-dark drawing surface. Nothing is injected until you
explicitly turn it on; drawings live only in memory for that tab.

## Install from a release

Every push/merge to `main` publishes a GitHub Release with two files:

- **`on-screen-writer-vX.Y.Z.zip`** — works on every OS. Unzip it, then
  follow the *Load unpacked* steps below and select the unzipped folder.
- **`on-screen-writer-vX.Y.Z.crx`** — signed package. With Developer mode on,
  drag it onto `chrome://extensions`. Chrome on Windows and macOS blocks
  `.crx` files that aren't from the Chrome Web Store (unless allowed via
  enterprise policy), so use the `.zip` there.

## Install (unpacked, for development)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (`on_screen_writer/`).
4. Pin the extension (puzzle-piece icon → pin) for one-click access.

## Using it

- Click the toolbar icon and press **Start Annotating**, or use the global
  shortcut below, on any normal `http(s)://` page.
- The page stays fully clickable/scrollable until you pick a drawing tool —
  picking "no tool" (click the active tool again, or press `Esc`) hands
  control back to the page instantly.
- Drag the small floating toolbar by its grip handle; collapse it to a
  single dot with the `–` button when you want it out of the way.
- **Export as PNG** before navigating away or reloading if you want to keep
  what you drew — drawings are intentionally session-only (see below).

## Keyboard shortcuts

| Shortcut | Scope | Action |
|---|---|---|
| `Ctrl+Shift+E` (`⌘+Shift+E` on Mac) | Global | Toggle the overlay on/off |
| `Ctrl+Shift+X` (`⌘+Shift+X` on Mac) | Global | Clear the current drawing (undoable) |
| `Ctrl+Z` | In-page | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | In-page | Redo |
| `P` `H` `U` `E` `R` `O` `L` `A` `T` | In-page | Pen / Highlighter / Underline / Eraser / Rectangle / Ellipse / Line / Arrow / Text |
| `[` / `]` | In-page | Decrease / increase stroke or eraser width |
| `B` | In-page | Toggle transparent ↔ dark background |
| `Ctrl+S` | In-page | Export the current drawing as a PNG |
| `Esc` | In-page | Deactivate the current tool (or cancel an in-progress text note) |

The two **global** shortcuts work anywhere (even from inside a page's own
input box) and are remappable at `chrome://extensions/shortcuts`. The
**in-page** shortcuts only fire while the overlay is mounted, and are
automatically suppressed while you're typing into the page's own inputs or
into the extension's own text-tool note (so typing "h" types the letter,
it doesn't switch tools).

## Known limitations (v1)

- **Can't run on**: `chrome://` pages, the Chrome Web Store, and Chrome's
  built-in PDF viewer — Chrome doesn't allow script injection there. The
  popup and the action-icon badge will tell you when a tab is unsupported.
- **Viewport-anchored, not scroll-anchored**: the canvas is
  `position: fixed`, so ink stays where you drew it on screen — it does not
  scroll with the page content underneath.
- **Top frame only**: drawing visually covers iframes fine, but the
  extension doesn't inject into cross-origin iframe documents (not needed
  for a drawing overlay).
- **SPA navigations**: a soft (pushState) navigation within a single-page
  app does *not* clear the overlay — only a full reload/navigation does.
  This is intentional (your ink survives in-app route changes) rather than
  a bug.
- **Session-only drawings**: reloading or navigating the tab discards
  everything in memory, by design. Use **Export as PNG** first if you want
  to keep a copy. (Your last-used color, width, and background mode *are*
  remembered across sessions via `chrome.storage` — just never the strokes
  themselves.)
- **Export is annotation-only**: the PNG contains your ink (plus the dark
  backdrop fill, if that mode is on) but not the underlying page's pixels.

## Manual verification checklist

1. Load unpacked as above; open a normal `https://` page.
2. Toggle via the popup button and via `Ctrl+Shift+E`; confirm the page
   stays fully interactive until a tool is picked.
3. Try every tool: Pen, Highlighter (translucent), Underline (straightens
   as you draw), Eraser (removes whole strokes/shapes, not pixel holes),
   Rectangle/Ellipse/Line/Arrow (drag to draw, live preview), Text (click,
   type, click elsewhere to commit).
4. Adjust the width slider and color (presets + custom picker) mid-session.
5. Toggle Background to Dark — page should be hidden behind the scrim and
   uninteractable; toggle back to Transparent — page interaction resumes.
6. `Ctrl+Z` / `Ctrl+Shift+Z` through draws, erases, and a Clear-All; confirm
   `Ctrl+Shift+X` itself undoes in one step.
7. Export a PNG in both background modes; confirm content/transparency.
8. Resize the window and zoom in/out (`Ctrl+`/`Ctrl-`) mid-drawing; strokes
   should stay correctly placed (not lost or offset).
9. Drag and collapse/expand the toolbar without affecting the drawing.
10. Toggle on/off rapidly (5+ times); check DevTools that `#osw-root` /
    `#osw-toolbar-host` never duplicate and no console errors appear.
11. Reload the page — overlay and drawings should be completely gone.
12. Try toggling on `chrome://extensions` — should show a graceful
    "unavailable" state, not an error.
13. Confirm both global shortcuts are listed and remappable at
    `chrome://extensions/shortcuts`.

## Project layout

```
manifest.json
background/service-worker.js   # command/message routing, on-demand injection
content/
  overlay-controller.js        # mount/teardown, DOM, pointer + resize wiring
  canvas-engine.js              # vector data model, undo/redo, render, export
  toolbar.js                    # Shadow DOM floating toolbar
  shortcuts.js                  # in-page keyboard shortcuts
popup/                          # toolbar-icon popup (start/stop + cheat-sheet)
shared/constants.js              # tools, colors, message types, shared config
icons/                           # extension icons
scripts/build.mjs                # packages dist/*.zip and dist/*.crx
.github/workflows/build.yml      # CI build + GitHub Release on main
```

The source is plain HTML/CSS/JS, loaded directly by Chrome — no bundling or
transpiling. The build step only *packages* it.

## Building

Requires Node.js 22.2+ and no npm dependencies.

```sh
npm run build        # or: node scripts/build.mjs
```

This writes to `dist/`:

| File | Use |
|---|---|
| `on-screen-writer-v<version>.zip` | Chrome Web Store upload, or unzip + *Load unpacked* |
| `on-screen-writer-v<version>.crx` | Signed CRX3 package |

The version comes from `manifest.json`. Dotfiles, `*.md`, `*.pem`,
`package.json`, and the `dist/`, `scripts/`, and `node_modules/` folders are
left out of the package.

### Signing key

The `.crx` is signed with an RSA private key, and that key sets the
extension ID. The build script looks for it in this order:

1. The `CRX_PRIVATE_KEY` environment variable (PEM contents)
2. The file named by `CRX_KEY_PATH`
3. `./key.pem`

If it finds none, it generates `./key.pem` and uses it. `*.pem` is
gitignored. **Never commit the key.** Anyone who has it can sign updates as
this extension.

## CI / releases

`.github/workflows/build.yml` runs on:

- **Pull requests to `main`**: builds the package and attaches it as a
  workflow artifact, so you can check it before merging. No release is made.
- **Pushes to `main`** (including merged PRs) and manual runs: builds the
  package and publishes a GitHub Release tagged
  `v<manifest version>-build.<run number>` with the `.zip` and `.crx` as
  assets.

One-time setup, so the extension ID stays the same across builds:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out key.pem
gh secret set CRX_PRIVATE_KEY < key.pem   # or: Settings → Secrets and variables → Actions
```

Keep `key.pem` somewhere safe. Without the secret, CI signs each build with a
new throwaway key, so every release gets a different extension ID and Chrome
treats it as a different extension.

When you ship a meaningful change, bump `version` in `manifest.json`.
