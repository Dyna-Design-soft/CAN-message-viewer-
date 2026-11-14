# Industrial Data Analyzer

Working product built on the V12.2 reference UI. `reference.html` is the original file, kept unchanged.
`index.html` is the same file plus one line that loads `analyzer-import.js`, which adds a real multi-format importer.

Open `index.html` in a browser (works from `file://`, fully offline). Click **＋ Open Data** or drag a file onto the page.

| Format | Extensions | Notes |
|---|---|---|
| Excel / OpenDocument | .xlsx .xlsm .xlsb .xls .ods | Pick a worksheet; date/time columns keep millisecond precision |
| CSV / TSV / Text | .csv .tsv .txt .dat .log | Detects `,` `;` tab `\|` or whitespace, decimal comma, header and units rows, `#` comments |
| NI TDMS | .tdms | Pick a group; time from a time channel or `wf_increment` |
| MS Access | .mdb .accdb | Pick a table |
| SQLite | .db .sqlite .sqlite3 .db3 | Pick a table or type a `SELECT` query |
| SQL script | .sql | Runs CREATE/INSERT dumps (MySQL/SQL Server syntax is cleaned up), then pick a table |
| JSON | .json | Array of records, array of arrays, or `{column: [...]}` |

The time axis is chosen from a column named like Time/Timestamp/Date or any date-time column; otherwise row index.
Units are read from headers like `Pressure [bar]` or `Speed (rpm)`.

Rebuild after editing `src/importers.js`: `npm install && npm run build`.
Test files for each format are in `samples/`.
