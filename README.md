# CAN Message Viewer

A browser-based CAN / CAN FD message viewer. Pure HTML/CSS/JavaScript — no build
step, no runtime internet dependency. It runs two ways:

- **Offline** — open recorded CAN log files (ASC, BLF, TDMS, MF4/MDF, CSV) for analysis.
- **Online (live)** — embedded in a Windows host application through a **WebView2**
  control; the host streams CAN frames as JSON and the viewer displays and records
  them. A built-in **simulator** lets you exercise live mode in a plain browser.

CAN FD (up to 64 data bytes) and both standard (11-bit) and extended (29-bit)
identifiers are supported throughout.

## Features

The app is a single page with three tabs plus a DBC manager:

- **DBC manager** (icon, top right) — load one or more `.dbc` files. Each file is a
  cluster; browse cluster → frame → signal, with full signal details (start bit,
  length, byte order, sign, factor/offset, min/max, default value, unit, value
  tables, receivers, comments). Files can be unloaded; parse errors are reported per
  line.
- **Workspaces** — keep multiple named setups (DBCs + signal selection + track
  layout + graph mode). Create/rename/delete/switch from the bar on the DBC tab;
  the current workspace auto-saves. **Import/Export** a workspace as a
  `.canws.json` file to share or back it up — the DBC source is included, the CAN
  log data is not.
- **Log File** — drag-and-drop or browse to open a log. Shows duration, frame count
  and rate, unique IDs, channels, CAN FD and error-frame counts, plus per-ID counts,
  cycle time and rate. Parsing runs in a Web Worker so the UI stays responsive on
  large files.
- **Analysis** — tick signals in the tree to add them to the value table and graphs.
  A playback clock (scrub slider, play/pause, speed) drives the table (configurable
  update interval). Add stacked **trend graphs** (auto-grouped onto multiple Y axes
  by unit) and **XY graphs**; zoom/pan is synchronized across the stack. Create
  **cursors** that move together on every graph, with a per-signal readout and a
  two-cursor delta. Boolean/enum signals render sample-and-hold with their `VAL_`
  state names (on the Y axis and in readouts). **Export CSV** dumps the selected
  signals over the current time window for Excel/MATLAB. The loaded DBC, signal
  selection, track layout, graph mode and active tab persist across reloads.
- **Live** — pick the source (host application or simulator), Start/Stop, and view
  incoming traffic as a **frame grid** (row per ID), **decoded signals**, a scrolling
  **trend**, or a **trace list**. **Record** to ASC, CSV, or BLF; recordings re-open
  in the Log File tab.

## Running

ES modules do not load over `file://`, so serve the folder over HTTP:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/index.html
```

Inside a WebView2 host, map the folder to a virtual host so modules load:

```csharp
webview.CoreWebView2.SetVirtualHostNameToFolderMapping(
    "canviewer.local", @"C:\path\to\CAN-message-viewer",
    CoreWebView2HostResourceAccessKind.Allow);
webview.CoreWebView2.Navigate("https://canviewer.local/index.html");
```

## Deploying to Render

The app is a static site (no server, no runtime backend), so it deploys as a
Render **Static Site**. Serving over HTTPS is also what enables the PWA install
prompt and the offline service worker.

A Blueprint (`render.yaml`) is included, so the whole thing is one click:

1. In the [Render dashboard](https://dashboard.render.com): **New → Blueprint**.
2. Connect this GitHub repo and select it. Render reads `render.yaml` and
   creates a static site named `can-message-viewer` — no build command, publish
   path `.`.
3. Click **Apply**. When the deploy finishes, the app is live at
   `https://can-message-viewer.onrender.com` (or your chosen name).

Notes:
- `render.yaml` deploys the `claude/can-message-viewer-hxuzmc` branch. After you
  merge to your default branch, change the `branch:` field (or set it in the
  dashboard) so pushes there redeploy automatically.
- No environment variables or secrets are needed — the viewer makes no
  cross-origin or runtime network calls.
- To deploy without the Blueprint: **New → Static Site**, pick the repo, leave
  **Build Command** blank, set **Publish Directory** to `.`.
- On a phone, open the deployed HTTPS URL in Chrome (Android) → **Install app**,
  or Safari (iOS) → Share → **Add to Home Screen**.

## WebView2 live protocol

The viewer and host exchange JSON objects, each with a `type` field. The host uses
`CoreWebView2.PostWebMessageAsJson(...)`; the viewer receives them via
`window.chrome.webview` and replies with `window.chrome.webview.postMessage(...)`
(delivered to the host's `WebMessageReceived` handler). `src/live/sim-source.js`
implements the same protocol and is the reference for message shapes.

### Host → Web

`hello` — sent once at connect. `t0Epoch` (Unix seconds) is the time base; every
frame `t` is seconds relative to it.

```json
{ "type": "hello", "protocolVersion": 1, "hostVersion": "1.2.0",
  "t0Epoch": 1752998400.123,
  "channels": [ { "ch": 1, "name": "CAN1", "fd": true, "bitrate": 500000, "dataBitrate": 2000000 } ] }
```

`frames` — a batch of frames. **Batch every 50–100 ms** rather than sending one
message per frame. `data` is uppercase hex (0–64 bytes); omit or empty for error
frames. `seq` is a monotonic counter so the viewer can detect gaps.

```json
{ "type": "frames", "seq": 417, "frames": [
  { "t": 12.3456781, "ch": 1, "id": 419364321, "ext": true,
    "fd": true, "brs": true, "esi": false, "rtr": false,
    "dir": "rx", "err": false, "data": "8D01FF00A2B4C6D8" } ] }
```

`busStatus` (optional) and `error` (optional):

```json
{ "type": "busStatus", "ch": 1, "state": "errorActive", "busLoad": 34.2, "rxErrCount": 0, "txErrCount": 0 }
{ "type": "error", "message": "adapter disconnected" }
```

### Web → Host

```json
{ "type": "ready", "protocolVersion": 1 }          // wait for this before sending frames
{ "type": "control", "action": "start" }            // also "stop" | "pause"
```

## Project layout

```
index.html            app shell (tabs, DBC modal)
css/app.css
src/core/             FrameStore, DBC model/parser, decoder, signal series, channel map
src/io/               format registry, ASC/BLF/TDMS/MF4/CSV readers, ASC/BLF/CSV writers, parse worker
src/live/             WebView2 bridge, simulator, ingest, recorder
src/graph/            uPlot (vendored), graph manager, cursor plugin
src/ui/               DBC modal, log/analysis/live panels
test/                 browser (test.html) + Node (run-node.mjs) test suites and fixtures
```

## Tests

```bash
node test/run-node.mjs           # headless: decoder/parser/round-trip/mapping
# or open test/test.html in a served browser
```

## Format notes / limitations

- **ASC** — classic and CAN FD lines, error frames, `date`/`base` headers.
- **BLF** — reads LOG_CONTAINER (zlib), CAN_MESSAGE, CAN_FD_MESSAGE(_64), CAN_ERROR;
  writes classic as CAN_MESSAGE and FD as CAN_FD_MESSAGE inside zlib containers.
  Self-round-trip is verified; validate against a Vector capture if exact CANoe
  fidelity is required.
- **TDMS** — generic segments/metadata + contiguous raw data, with an NI-XNET
  mapper. Recognizes the NI-XNET raw-frame stream (single byte channel with
  `NI_network_*` properties; payload padded to an 8-byte boundary) and a per-field
  channel layout. Interleaved and DAQmx raw data are not supported.
- **MF4 (ASAM MDF v4)** — reads CAN bus-logging files: channel groups whose
  channels follow the standard `CAN_DataFrame` / `CAN_ErrorFrame` naming. Supports
  sorted and unsorted data groups and uncompressed (`##DT`), compressed (`##DZ`,
  deflate incl. transposed) and block-list (`##DL`/`##HL`) data. Generic (non-bus)
  signal MDF, array/VLSD channels and MDF3 are out of scope.
- **DBC** — simple `m<N>` multiplexing is decoded; extended multiplexing
  (`SG_MUL_VAL_`) is parsed with a warning but not decoded.
