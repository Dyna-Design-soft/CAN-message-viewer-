"""Application entry point for the CAN Message Viewer desktop app.

Runs both as a module (`python -m canviewer`) and when the file is executed
directly (e.g. the PyCharm ▶ Run button on app.py). Direct execution has no
parent package, so we add the project's `python/` directory to sys.path and use
absolute imports instead of relative ones.
"""
from __future__ import annotations

import os
import sys


def main() -> int:
    # When run directly as a script there is no package context, so make the
    # `canviewer` package importable by adding python/ (two levels up) to the path.
    if __package__ in (None, ""):
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    from PySide6 import QtWidgets
    from canviewer.ui.main_window import MainWindow

    app = QtWidgets.QApplication(sys.argv)
    app.setApplicationName("CAN Message Viewer")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
