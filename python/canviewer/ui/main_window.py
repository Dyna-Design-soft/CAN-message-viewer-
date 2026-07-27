"""CAN Message Viewer — desktop GUI (PySide6 + pyqtgraph).

Layout: a DBC-derived signal tree (checkboxes) on the left; a value table and a
stack of time-aligned plots (one per selected signal, shared X axis) on the
right; a draggable time cursor whose position drives the value table. Native
pyqtgraph mouse zoom/pan. Open DBC and log files from the toolbar.
"""
from __future__ import annotations

import os

import numpy as np
import pyqtgraph as pg
from PySide6 import QtCore, QtGui, QtWidgets

from ..core.dbc_model import DbcRegistry
from ..core.dbc_parser import parse_dbc
from ..core.decoder import value_label
from ..core.frame_store import FrameStore
from ..core.series import extract_series, value_at
from ..io.registry import load_all_readers, load_log_file
from ..demo import load_demo

SERIES_COLORS = ["#4da3ff", "#ffa94d", "#22c55e", "#e879f9", "#38e0d0",
                 "#f472b6", "#a3e635", "#fbbf24", "#818cf8", "#fb7185"]
CURSOR_PEN = pg.mkPen("#e0a83c", width=1)

pg.setConfigOptions(antialias=True, background="#0b0e14", foreground="#8a94a6")


class MainWindow(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("CAN Message Viewer")
        self.resize(1280, 820)
        load_all_readers()

        self.dbc = DbcRegistry()
        self.store = FrameStore()
        self.selection: list[str] = []          # qualified signal names (ordered)
        self._series: dict[str, tuple] = {}      # qname -> (t, v)
        self._colors: dict[str, str] = {}
        self._cursor_lines: list[pg.InfiniteLine] = []
        self._cursor_t = 0.0
        self._syncing = False

        self._build_ui()
        self._load_initial_demo()

    # ---- UI scaffolding ----
    def _build_ui(self):
        tb = self.addToolBar("Main")
        tb.setMovable(False)
        act_dbc = QtGui.QAction("Open DBC…", self)
        act_dbc.triggered.connect(self.open_dbc)
        act_log = QtGui.QAction("Open Log…", self)
        act_log.triggered.connect(self.open_log)
        act_demo = QtGui.QAction("Load demo", self)
        act_demo.triggered.connect(self._load_initial_demo)
        for a in (act_dbc, act_log, act_demo):
            tb.addAction(a)

        # left: filter + signal tree
        left = QtWidgets.QWidget()
        lv = QtWidgets.QVBoxLayout(left)
        lv.setContentsMargins(6, 6, 6, 6)
        self.filter_edit = QtWidgets.QLineEdit(placeholderText="Filter signals…")
        self.filter_edit.textChanged.connect(self._render_tree)
        self.tree = QtWidgets.QTreeWidget()
        self.tree.setHeaderHidden(True)
        self.tree.itemChanged.connect(self._on_item_changed)
        lv.addWidget(self.filter_edit)
        lv.addWidget(self.tree)

        # right: value table over the plot stack
        self.table = QtWidgets.QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["Signal", "Value", "Unit", "Raw", "Message"])
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.setEditTriggers(QtWidgets.QAbstractItemView.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        self.glw = pg.GraphicsLayoutWidget()

        right_split = QtWidgets.QSplitter(QtCore.Qt.Vertical)
        right_split.addWidget(self.table)
        right_split.addWidget(self.glw)
        right_split.setStretchFactor(1, 3)
        right_split.setSizes([200, 600])

        main_split = QtWidgets.QSplitter(QtCore.Qt.Horizontal)
        main_split.addWidget(left)
        main_split.addWidget(right_split)
        main_split.setStretchFactor(1, 1)
        main_split.setSizes([320, 960])
        self.setCentralWidget(main_split)

        self.status = self.statusBar()
        self.status.showMessage("Open a DBC and a log file to begin.")

    # ---- data loading ----
    def _load_initial_demo(self):
        cluster, store = load_demo()
        self.dbc = DbcRegistry()
        self.dbc.add(cluster)
        self.store = store
        self._series.clear()
        self._render_tree()
        self._update_status(fname="demo (sample data)", fmt="Demo")
        # preselect a few signals
        self._set_selection([
            "demo/EngineData/EngineSpeed",
            "demo/EngineData/VehicleSpeed",
            "demo/EngineData/EngineTemp",
        ])

    def open_dbc(self):
        paths, _ = QtWidgets.QFileDialog.getOpenFileNames(
            self, "Open DBC file(s)", "", "DBC files (*.dbc);;All files (*)")
        for path in paths:
            try:
                with open(path, "r", errors="replace") as fh:
                    text = fh.read()
                c = parse_dbc(text, os.path.basename(path))
                c.source = text
                self.dbc.add(c)
            except Exception as e:  # noqa: BLE001
                QtWidgets.QMessageBox.warning(self, "DBC error", f"{path}:\n{e}")
        if paths:
            self._series.clear()
            self._render_tree()
            self._rebuild_plots()

    def open_log(self):
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self, "Open CAN log", "",
            "CAN logs (*.asc *.blf *.tdms *.mf4 *.mdf *.csv);;All files (*)")
        if not path:
            return
        self.status.showMessage(f"Loading {os.path.basename(path)}…")
        QtWidgets.QApplication.processEvents()
        try:
            store, fmt = load_log_file(path)
        except Exception as e:  # noqa: BLE001
            QtWidgets.QMessageBox.warning(self, "Log error", f"{path}:\n{e}")
            self.status.showMessage("Load failed.")
            return
        self.store = store
        self._series.clear()
        self._update_status(fname=os.path.basename(path), fmt=fmt)
        self._rebuild_plots()

    def _update_status(self, fname, fmt):
        st = self.store.compute_stats()
        self.status.showMessage(
            f"{fname} [{fmt}]  —  {st['frame_count']:,} frames, "
            f"{st['duration']:.3f} s, {st['unique_ids']} IDs, "
            f"{st['fd_frames']} FD, {st['error_frames']} errors")

    # ---- signal tree ----
    def _render_tree(self):
        self.tree.blockSignals(True)
        self.tree.clear()
        flt = self.filter_edit.text().strip().lower()
        for cluster in self.dbc.clusters:
            c_item = QtWidgets.QTreeWidgetItem([cluster.name])
            cluster_has = False
            for msg in sorted(cluster.messages.values(), key=lambda m: m.id):
                m_item = QtWidgets.QTreeWidgetItem([
                    f"0x{msg.id:X}{'x' if msg.extended else ''}  {msg.name}"])
                msg_has = False
                for sig in msg.signals:
                    if flt and flt not in sig.name.lower() and flt not in msg.name.lower():
                        continue
                    label = sig.name + (f"  [{sig.unit}]" if sig.unit else "")
                    s_item = QtWidgets.QTreeWidgetItem([label])
                    s_item.setFlags(s_item.flags() | QtCore.Qt.ItemIsUserCheckable)
                    s_item.setCheckState(
                        0, QtCore.Qt.Checked if sig.qualified_name in self.selection
                        else QtCore.Qt.Unchecked)
                    s_item.setData(0, QtCore.Qt.UserRole, sig.qualified_name)
                    m_item.addChild(s_item)
                    msg_has = True
                if msg_has:
                    c_item.addChild(m_item)
                    cluster_has = True
            if cluster_has:
                self.tree.addTopLevelItem(c_item)
                c_item.setExpanded(len(self.dbc.clusters) == 1)
        self.tree.blockSignals(False)

    def _on_item_changed(self, item, _col):
        q = item.data(0, QtCore.Qt.UserRole)
        if not q:
            return
        checked = item.checkState(0) == QtCore.Qt.Checked
        if checked and q not in self.selection:
            self.selection.append(q)
        elif not checked and q in self.selection:
            self.selection.remove(q)
        self._rebuild_plots()

    def _set_selection(self, qnames):
        self.selection = [q for q in qnames if self.dbc.signal_by_qualified_name(q)]
        self._render_tree()
        self._rebuild_plots()

    # ---- plotting ----
    def _color(self, q):
        if q not in self._colors:
            self._colors[q] = SERIES_COLORS[len(self._colors) % len(SERIES_COLORS)]
        return self._colors[q]

    def _series_for(self, q):
        if q not in self._series:
            sig = self.dbc.signal_by_qualified_name(q)
            self._series[q] = extract_series(self.store, sig) if sig else (np.array([]), np.array([]))
        return self._series[q]

    def _rebuild_plots(self):
        self.glw.clear()
        self._cursor_lines = []
        plotted = [(q, *self._series_for(q)) for q in self.selection]
        plotted = [(q, t, v) for (q, t, v) in plotted if t.size]
        first = None
        for i, (q, t, v) in enumerate(plotted):
            sig = self.dbc.signal_by_qualified_name(q)
            p = self.glw.addPlot(row=i, col=0)
            p.showGrid(x=True, y=True, alpha=0.12)
            p.setLabel("left", q.split("/")[-1], units=sig.unit if sig and sig.unit else None)
            pen = pg.mkPen(self._color(q), width=1.6)
            try:
                p.plot(t, v, pen=pen, stepMode="right", connect="finite")
            except Exception:
                p.plot(t, v, pen=pen)
            if first is None:
                first = p
            else:
                p.setXLink(first)
            if i < len(plotted) - 1:
                p.getAxis("bottom").setStyle(showValues=False)
            line = pg.InfiniteLine(angle=90, movable=True, pen=CURSOR_PEN)
            line.setPos(self._cursor_t)
            line.sigPositionChanged.connect(self._on_cursor_moved)
            p.addItem(line)
            self._cursor_lines.append(line)
        self._rebuild_table()
        self._update_table_values()

    def _on_cursor_moved(self, moved_line):
        if self._syncing:
            return
        self._syncing = True
        self._cursor_t = moved_line.value()
        for line in self._cursor_lines:
            if line is not moved_line:
                line.setPos(self._cursor_t)
        self._syncing = False
        self._update_table_values()

    # ---- value table ----
    def _rebuild_table(self):
        self.table.setRowCount(len(self.selection))
        for row, q in enumerate(self.selection):
            sig = self.dbc.signal_by_qualified_name(q)
            self.table.setItem(row, 0, QtWidgets.QTableWidgetItem(q.split("/")[-1]))
            self.table.setItem(row, 2, QtWidgets.QTableWidgetItem(sig.unit if sig else ""))
            self.table.setItem(row, 4, QtWidgets.QTableWidgetItem(
                sig.message.name if sig and sig.message else ""))

    def _update_table_values(self):
        t = self._cursor_t
        for row, q in enumerate(self.selection):
            sig = self.dbc.signal_by_qualified_name(q)
            tt, vv = self._series_for(q)
            v = value_at(tt, vv, t)
            if v is None:
                val_str, raw_str = "—", "—"
            else:
                label = value_label(sig, v) if sig else None
                val_str = label if label is not None else _fmt(v)
                raw_str = str(round((v - sig.offset) / sig.factor)) if sig else "—"
            self.table.setItem(row, 1, QtWidgets.QTableWidgetItem(val_str))
            self.table.setItem(row, 3, QtWidgets.QTableWidgetItem(raw_str))


def _fmt(v):
    if v is None:
        return "—"
    if float(v).is_integer():
        return str(int(v))
    return f"{v:.6g}"
