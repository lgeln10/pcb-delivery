"""Factory-profile schema = the shape of ``default.yaml``.

There is no separate schema file to drift from: the default profile *is* the schema. A tenant
profile (YAML override) is valid when every key exists in the default with a compatible value
type. The trailing ``# …`` comments of ``default.yaml`` (page references, meaning) are exposed
as per-key documentation for the form view in AIOS.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any

import yaml

from engine.profiles import DEFAULT_PROFILE_PATH, load_profile

_KEY_LINE = re.compile(r"^(?P<indent>\s*)(?P<key>[A-Za-z_][A-Za-z0-9_]*):(?P<rest>.*)$")
# ``null`` is the safe runtime default for an optional rule, but its accepted subfields still
# need a schema so the profile editor can validate a factory that opts in.
_OPTIONAL_MAPPINGS: dict[str, dict[str, str]] = {
    "mask.coverage_on_pour": {"coverage_mm": "number", "ring_mm": "number", "pour_coverage_min": "number"},
    # 按表面处理分档的预大表：档名由厂给（hasl / other / …），``*`` 匹配一层
    "drill.oversize_by_finish": {
        "*.plated": "number", "*.non_plated": "number", "*.via": "number",
    },
}
_OPTIONAL_FIELDS: dict[str, str] = {
    "layer.rail_vcut_notch_mm": "list",
    "output.rout_on_mask_mm": "number",
    "copper.compensation_default_oz": "number",
}
# 默认值不在 default.yaml 里、但引擎确实读的键（写了才生效的可选写法）
_EXTRA_FIELDS: dict[str, str] = {
    # drill.py: extra_mm 是「在正常补偿上再加」，add_mm 是「直接取这个值」，两种写法都读
    "drill.oversize_large.add_mm": "number",
}
_ENUM_FIELDS: dict[str, set[str]] = {
    "release.mode": {"review", "certified"},
}
# 厂规开关的三档：默认值是 bool，但也收 auto|ask|off（洲旭 2026-09-16 要求这几类「可选 / 人工过目」）
_TRISTATE_FIELDS: dict[str, set[str]] = {
    "copper.inner.nfp_removal": {"auto", "ask", "off", "true", "false"},
    "copper.outer.nfp_removal": {"auto", "ask", "off", "true", "false"},
    "drill.overlap_confirm": {"auto", "ask", "off", "true", "false"},
}


@dataclass
class Field:
    key: str  # dotted path
    value: Any
    default: Any
    type: str  # number | bool | string | list | mapping
    doc: str
    overridden: bool


def _match_child(spec: dict[str, str], child: str) -> str | None:
    """Look ``child`` up in an optional mapping's spec; a ``*`` segment matches any one key."""
    if (want := spec.get(child)) is not None:
        return want
    parts = child.split(".")
    for pattern, want in spec.items():
        segs = pattern.split(".")
        if len(segs) == len(parts) and all(s == "*" or s == p for s, p in zip(segs, parts, strict=True)):
            return want
    return None


def _type_of(v: Any) -> str:
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "list"
    if isinstance(v, dict):
        return "mapping"
    return "null"


def default_docs() -> dict[str, str]:
    """dotted key -> comment text, from the default.yaml source (section comments inherit)."""
    docs: dict[str, str] = {}
    stack: list[tuple[int, str]] = []
    pending: list[str] = []
    for raw in DEFAULT_PROFILE_PATH.read_text("utf-8").splitlines():
        if not raw.strip():
            pending = []
            continue
        if raw.lstrip().startswith("#"):
            pending.append(raw.strip("# ").strip())
            continue
        m = _KEY_LINE.match(raw)
        if not m:
            continue
        indent = len(m.group("indent"))
        while stack and stack[-1][0] >= indent:
            stack.pop()
        key = ".".join([k for _, k in stack] + [m.group("key")])
        stack.append((indent, m.group("key")))
        rest = m.group("rest")
        inline = rest.split("#", 1)[1].strip() if "#" in rest else ""
        text = " ".join(x for x in ([*pending, inline] if inline else pending) if x)
        if text:
            docs[key] = text
        pending = []
    return docs


def flatten(d: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(flatten(v, key + "."))
        else:
            out[key] = v
    return out


def validate(profile_yaml: str | None) -> dict[str, Any]:
    """{"ok", "errors": [...], "fields": [Field...], "merged": {...}}"""
    errors: list[str] = []
    try:
        override = yaml.safe_load(profile_yaml) if profile_yaml and profile_yaml.strip() else {}
    except yaml.YAMLError as e:
        return {"ok": False, "errors": [f"YAML 语法错误：{e}"], "fields": [], "merged": None}
    if override is None:
        override = {}
    if not isinstance(override, dict):
        return {"ok": False, "errors": ["profile 必须是键值映射（mapping）"], "fields": [], "merged": None}
    default = load_profile(None)
    flat_default = flatten(default)
    flat_override = flatten(override)
    for key, v in flat_override.items():
        if key not in flat_default:
            if (want := _EXTRA_FIELDS.get(key)) is not None:
                if _type_of(v) != want:
                    errors.append(f"{key} 类型应为 {want}，给的是 {_type_of(v)}（{v!r}）")
                continue
            optional_parent = next((p for p in _OPTIONAL_MAPPINGS if key.startswith(p + ".")), None)
            if optional_parent:
                child = key.removeprefix(optional_parent + ".")
                want = _match_child(_OPTIONAL_MAPPINGS[optional_parent], child)
                if want is None:
                    errors.append(f"未知字段 {key}（{optional_parent} 不支持该键）")
                elif _type_of(v) != want:
                    errors.append(f"{key} 类型应为 {want}，给的是 {_type_of(v)}（{v!r}）")
                continue
            # allow overriding a whole mapping (e.g. mask.bridge_min_mm) only with known children
            parent = key.rsplit(".", 1)[0] if "." in key else None
            if parent in flat_default and isinstance(flat_default.get(parent), dict):
                continue
            errors.append(f"未知字段 {key}（默认标准里没有这个键）")
            continue
        td, tv = _type_of(flat_default[key]), _type_of(v)
        if key == "copper.vcut_coupon.at" and v == "auto":
            continue  # Runtime supports automatic placement as well as coordinate lists.
        if key in _TRISTATE_FIELDS:
            if str(v).lower() not in _TRISTATE_FIELDS[key]:
                errors.append(f"{key} 只能是 {', '.join(sorted(_TRISTATE_FIELDS[key]))}，给的是 {v!r}")
            continue
        if td == "null" and key in _OPTIONAL_FIELDS:
            if tv != _OPTIONAL_FIELDS[key]:
                errors.append(f"{key} 类型应为 {_OPTIONAL_FIELDS[key]}，给的是 {tv}（{v!r}）")
            continue
        if td != tv and not (td == "number" and tv == "number"):
            errors.append(f"{key} 类型应为 {td}，给的是 {tv}（{v!r}）")
            continue
        if key in _ENUM_FIELDS and str(v).lower() not in _ENUM_FIELDS[key]:
            errors.append(f"{key} 只能是 {', '.join(sorted(_ENUM_FIELDS[key]))}，给的是 {v!r}")
    merged = load_profile(profile_yaml) if not errors else None
    flat_merged = flatten(merged) if merged else flat_default
    docs = default_docs()
    fields = [
        Field(key=k, value=flat_merged.get(k), default=dv, type=_type_of(dv), doc=docs.get(k, ""), overridden=k in flat_override)
        for k, dv in flat_default.items()
    ]
    return {"ok": not errors, "errors": errors, "fields": [asdict(f) for f in fields], "merged": merged}


def default_yaml_text() -> str:
    return DEFAULT_PROFILE_PATH.read_text("utf-8")
