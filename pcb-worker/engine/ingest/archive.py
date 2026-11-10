"""Extract customer archives (zip / rar / 7z) into a job's ``src`` dir.

- zip member names that were stored without the UTF-8 flag come back cp437-decoded; those are
  re-decoded as GBK (Chinese Windows) when that round-trips, otherwise left as-is.
- Directory structure is flattened to forward-slash relative paths; a single common
  top-level folder (``board_v2/…``) is stripped. ``..``/absolute members are refused.
"""

from __future__ import annotations

import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from engine.storage import safe_relpath

ARCHIVE_SUFFIXES = (".zip", ".rar", ".7z")


@dataclass
class ExtractResult:
    files: list[str] = field(default_factory=list)  # relative paths under dest
    errors: list[str] = field(default_factory=list)
    renamed: dict[str, str] = field(default_factory=dict)  # original -> fixed names


def fix_zip_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    if info.flag_bits & 0x800:  # UTF-8 flag set: trust it
        return name
    try:
        raw = name.encode("cp437")
    except UnicodeEncodeError:
        return name
    for enc in ("utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return name


def _strip_common_root(names: list[str]) -> list[str]:
    parts = [n.split("/") for n in names]
    if len(parts) > 1 and all(len(p) > 1 for p in parts):
        roots = {p[0] for p in parts}
        if len(roots) == 1:
            return ["/".join(p[1:]) for p in parts]
    return names


def _is_junk(rel: str) -> bool:
    base = rel.rsplit("/", 1)[-1]
    return rel.startswith("__MACOSX/") or base in (".DS_Store", "Thumbs.db") or base.startswith("._")


def _extract_zip(src: Path, dest: Path, res: ExtractResult) -> None:
    with zipfile.ZipFile(src) as zf:
        members = [m for m in zf.infolist() if not m.is_dir()]
        fixed = []
        for m in members:
            name = fix_zip_name(m)
            if name != m.filename:
                res.renamed[m.filename] = name
            fixed.append(safe_relpath(name))
        stripped = _strip_common_root(fixed)
        for m, rel in zip(members, stripped, strict=True):
            if _is_junk(rel):
                continue
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(m) as f, open(out, "wb") as o:
                shutil.copyfileobj(f, o)
            res.files.append(rel)


def _extract_7z(src: Path, dest: Path, res: ExtractResult) -> None:
    import py7zr

    with py7zr.SevenZipFile(src, "r") as z:
        names = [n for n, isdir in ((i.filename, i.is_directory) for i in z.list()) if not isdir]
        fixed = [safe_relpath(n) for n in names]
        stripped = _strip_common_root(fixed)
        data = z.read(names)
        for name, rel in zip(names, stripped, strict=True):
            if _is_junk(rel) or name not in data:
                continue
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data[name].read())
            res.files.append(rel)


def _extract_rar(src: Path, dest: Path, res: ExtractResult) -> None:
    import rarfile

    try:
        with rarfile.RarFile(src) as rf:
            members = [m for m in rf.infolist() if not m.is_dir()]
            fixed = [safe_relpath(m.filename) for m in members]
            stripped = _strip_common_root(fixed)
            for m, rel in zip(members, stripped, strict=True):
                if _is_junk(rel):
                    continue
                out = dest / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(rf.read(m))
                res.files.append(rel)
    except rarfile.RarCannotExec as e:  # unrar / bsdtar missing on host
        res.errors.append(f"cannot extract {src.name}: rar tool missing ({e}); install `unrar`")


def extract_archive(src: Path, dest: Path) -> ExtractResult:
    res = ExtractResult()
    dest.mkdir(parents=True, exist_ok=True)
    suffix = src.suffix.lower()
    try:
        if suffix == ".zip" or zipfile.is_zipfile(src):
            _extract_zip(src, dest, res)
        elif suffix == ".7z":
            _extract_7z(src, dest, res)
        elif suffix == ".rar":
            _extract_rar(src, dest, res)
        else:
            res.errors.append(f"unsupported archive type: {src.name}")
    except Exception as e:  # noqa: BLE001 - reported as an error item, never crashes intake
        res.errors.append(f"failed to extract {src.name}: {type(e).__name__}: {e}")
    return res


CONTAINER_SUFFIXES = (".xlsx", ".xlsm", ".docx", ".pptx", ".odt", ".ods", ".jar", ".xls", ".doc", ".ppt", ".pcbdoc", ".pcb", ".schdoc", ".ddb")  # OLE/EDA files can carry a zip inside — never exploded  # zip-based, not archives


def is_archive(path: Path) -> bool:
    suffix = path.suffix.lower()
    if suffix in CONTAINER_SUFFIXES:
        return False  # an order-spec .xlsx must reach classify as an aux file, not be exploded
    return suffix in ARCHIVE_SUFFIXES or zipfile.is_zipfile(path)
