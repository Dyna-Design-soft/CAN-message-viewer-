# CAN Message Viewer — Python desktop app

A native desktop port of the browser CAN Message Viewer, built with
**PySide6 (Qt)** and **pyqtgraph**. It shares the same hand-written core as the
web app — DBC parser, decode engine (Intel/Motorola, signed, multiplexing),
and the ASC/BLF/TDMS/MF4/CSV readers (including the NI-XNET TDMS fix and the
MF4 bus-logging layout).

## Features (v1)

- **Open DBC** file(s) — each becomes a cluster; browse cluster → frame → signal.
- **Open log** — Vector ASC, Vector BLF, NI TDMS (XNET), ASAM MDF v4 (MF4), CSV.
- **Signal tree** with a filter box and per-signal checkboxes.
- **Value table** — decoded value / unit / raw / message at the cursor time,
  with `VAL_` enum/state labels.
- **Stacked plots** — one time-aligned plot per selected signal, sharing the X
  axis, with a **draggable time cursor** synced across all plots. Native
  pyqtgraph mouse **zoom** (drag / wheel) and **pan** (right-drag).
- **Status bar** — duration, frame count, unique IDs, CAN FD and error counts.

## Install & run

```bash
cd python
python3 -m pip install -r requirements.txt
python3 -m canviewer          # or:  python3 __main__.py
```

Requires Python 3.9+. On a headless Linux box, install the Qt runtime libs
(`libegl1 libgl1 libxkbcommon0`) or run with a display.

**PyCharm:** you can also just press ▶ Run on `canviewer/app.py` — it adds the
project root to `sys.path` itself, so both the Run button and `python -m
canviewer` work. Point the run configuration's interpreter at a venv where
`pip install -r requirements.txt` has been run.

## Layout

```
python/
  canviewer/
    core/    frame_store, dbc_model, dbc_parser, decoder, series
    io/      registry + asc/csv/tdms/blf/mdf readers
    ui/      main_window (PySide6 + pyqtgraph)
    demo.py  embedded sample DBC + synthetic log (first-run)
    app.py   entry point
  tests/     pytest: decoder golden vectors, DBC parse, MF4 round-trip
  requirements.txt
```

## Tests

```bash
cd python
python3 -m pytest tests/ -q
```

Golden-vector decode tests, DBC parse (incl. multiplexing + VAL_), and a
synthetic MF4 round-trip. The ASC/BLF/TDMS readers were validated to produce
identical frame counts and duration to the web app on the same capture files.

## Scope vs the web app

This v1 covers the offline analysis workflow (DBC + log → tree, table, plots).
Not yet ported: workspaces, live/WebView2, recording, XY plots, frame
extract/export, A→B cursor-region statistics. The core and readers are shared
in spirit with the web version, so those can be added incrementally.
