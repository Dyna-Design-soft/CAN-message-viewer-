# Industrial Data Analyzer

**`Industrial_Analyzer.html` is the whole app in one standalone file** (1.7 MB, no install, no internet, works from `file://`).
Copy it anywhere and double-click it. Click **＋ Open Data** or drag a file onto the page.

It is the V12.2 reference UI (`reference.html`, kept unchanged, all features intact) with the import and
large-data engine inlined at the end of the page.

| Format | Extensions | Notes |
|---|---|---|
| Excel / OpenDocument | .xlsx .xlsm .xlsb .xls .ods | Pick a worksheet; date/time columns keep millisecond precision |
| CSV / TSV / Text / LVM | .csv .tsv .txt .dat .log .lvm | Detects `,` `;` tab `\|` or whitespace, decimal comma, header and units rows, `#` comments |
| NI TDMS | .tdms | Pick a group; contiguous, interleaved and DAQmx raw data (with NI scaling); time from a time channel or `wf_increment` |
| MS Access | .mdb .accdb | Pick a table |
| SQLite | .db .sqlite .sqlite3 .db3 | Pick a table or type a `SELECT` query |
| SQL script | .sql | Runs CREATE/INSERT dumps (MySQL/SQL Server syntax is cleaned up), then pick a table |
| JSON | .json | Array of records, array of arrays, or `{column: [...]}` |

The time axis is chosen from a column named like Time/Timestamp/Date or any date-time column; otherwise row index.
Units are read from headers like `Pressure [bar]` or `Speed (rpm)`.

Sample rate is also read from header lines such as `Sample Rate: 20 kHz` or `dt = 5e-5`, and can be set by hand in the data bar.

## Mobile & tablet

Responsive on phones (≥320 px), tablets and desktops: on narrow screens the sidebar becomes a slide-in menu
(☰ button or swipe from the left edge), a sticky app bar shows the page title and an **＋ Open** button,
wide tables scroll inside their cards, grids stack, touch targets are enlarged, and the Full Record bar
becomes a collapsible bottom sheet. Implemented as an additive layer (`src/responsive.js`); the reference markup is untouched.

## Large DAQ records (e.g. 20 kS/s × many channels × minutes)

- Large text files are parsed straight from bytes into typed arrays (≈1.2 M rows × 5 columns in ~0.3 s);
  TDMS data is copied block-wise (2.4 M samples × 8 channels in ~0.6 s). Big records are stored as Float32 to halve memory.
- The full-resolution record stays in memory. The analyzer pages get a **min/max envelope** view of the selected
  time window (default 10,000 points per channel), so spikes and peaks are never lost and every page stays responsive.
  The envelope has uniform timestamps, so FFT/spectral tools still work. *Block average* mode is available too.
- The **Full record** bar at the bottom: drag the window on the overview track, type a start/end time, ◀ ▶ to page,
  ＋/－ to zoom. Narrow windows show every raw sample (full resolution).
- **Full-res stats** gives min/max/mean/RMS/SD/P-P over every raw sample in the window;
  **Export window CSV** writes the raw samples of the window.
- Browser memory is the practical limit (roughly a few hundred million samples in Chrome/Edge 64-bit).

Rebuild after editing `src/importers.js`: `npm install && npm run build` (writes `Industrial_Analyzer.html`).
Test files for each format are in `samples/`.
