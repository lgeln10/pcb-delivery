"""第15章 / p122 p135: impedance-controlled traces are compensated by their own calculation
("阻抗线依照设计值加大"), never by the blanket +1 mil. The order spec names them by width (and
optionally layer); this module tells the compensation check and the native op which strokes are
impedance lines so they are left alone and raised as an EQ."""

from __future__ import annotations

import re
from typing import Any

MIL = 0.0254
WIDTH_TOL_MM = 0.6 * MIL  # design width ± 0.6 mil: Gerber rounding, never a neighbouring width class


def _layer_index(v: Any) -> int | None:
    """``"L3"`` / ``"3"`` / ``3`` → 3; ``top``/``gtl`` → 1; anything else (None, ``all``, ``bottom``) → None (= every layer)."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip().lower()
    if s in ("top", "gtl", "l1"):
        return 1
    m = re.search(r"(\d+)", s)
    return int(m.group(1)) if m else None


def impedance_entries(order_spec: dict[str, Any] | None, layer_index: int | None) -> list[dict[str, Any]]:
    """The impedance rows that apply to a copper layer (by index; rows without a layer apply to all)."""
    rows = (order_spec or {}).get("impedance") or []
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        w = r.get("trace_mil")
        if w is None:
            continue
        li = _layer_index(r.get("layer"))
        if li is None or layer_index is None or li == layer_index:
            out.append(r)
    return out


def is_impedance_width(width_mm: float | None, entries: list[dict[str, Any]]) -> bool:
    if width_mm is None:
        return False
    return any(abs(width_mm - float(r["trace_mil"]) * MIL) <= WIDTH_TOL_MM for r in entries)


def describe(entries: list[dict[str, Any]]) -> str:
    return "、".join(f"{r.get('trace_mil')}mil{'/' + str(r.get('space_mil')) + 'mil' if r.get('space_mil') else ''} {r.get('target_ohm', '?')}Ω {r.get('type', '')}".strip() for r in entries)
