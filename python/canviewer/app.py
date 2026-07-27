"""Application entry point for the CAN Message Viewer desktop app."""
from __future__ import annotations

import sys


def main() -> int:
    from PySide6 import QtWidgets
    from .ui.main_window import MainWindow

    app = QtWidgets.QApplication(sys.argv)
    app.setApplicationName("CAN Message Viewer")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
