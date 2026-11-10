"""Native EDA board files (Altium ``.PcbDoc``, Protel 99 SE ``.pcb``) → the Gerber/Excellon set the
factory engineer would have exported by hand (第1章 p42：客户给源文件时由工程师用 EDA 软件导出).

``read_board`` sniffs the format, ``export_gerbers`` writes an Altium-style file set into a folder.
"""

from __future__ import annotations

from pathlib import Path

from engine.cad.model import Board


def sniff(path: Path) -> str | None:
    """``"altium"`` / ``"protel99"`` / ``None`` for a file that is neither."""
    try:
        head = path.read_bytes()[:64]
    except OSError:
        return None
    if head[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":  # OLE compound document
        return "altium" if path.suffix.lower() in (".pcbdoc", ".pcb") or _ole_has_pcb(path) else None
    if head[:20] == b"\x13PCB 4.0 Binary File" or b"PCB 4.0 Binary" in head:
        return "protel99"
    return None


def _ole_has_pcb(path: Path) -> bool:
    try:
        import olefile

        with olefile.OleFileIO(path) as o:
            return o.exists("Board6/Data")
    except Exception:  # noqa: BLE001 — not an OLE file we can read
        return False


def read_board(path: Path) -> Board:
    kind = sniff(path)
    if kind == "altium":
        from engine.cad.altium import read_pcbdoc

        return read_pcbdoc(path)
    if kind == "protel99":
        from engine.cad.protel99 import read_protel99

        return read_protel99(path)
    raise ValueError(f"{path.name}: not an Altium PcbDoc or Protel 99 SE PCB file")


def export_gerbers(board: Board, out_dir: Path, stem: str, **options) -> list[str]:
    from engine.cad.export import export_board

    return export_board(board, out_dir, stem, **options)


__all__ = ["Board", "export_gerbers", "read_board", "sniff"]
