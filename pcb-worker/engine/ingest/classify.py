"""Deterministic layer identification with confidence.

Priority (first hit wins, confidence noted):

1. ``%TF.FileFunction`` (Gerber X2, also EAGLE's ``G04 #@!`` and KiCad's ``; #@!`` comment
   forms)                                             -> 0.98
2. extension / file-name rules (knowledge/rules/layer_naming.yaml p110 GTL/GBL/GTS/... plus
   KiCad / Altium / Protel / EAGLE / Chinese variants) -> 0.75..0.92
3. content features (Excellon ``M48``, Gerber ``%FS``/``%MO``, single closed contour)
                                                      -> 0.3..0.7
4. anything below 0.8 is flagged ``needs_llm`` so Node can ask an LLM / a human.

Layer type vocabulary::

    top_copper inner_copper bottom_copper top_mask bottom_mask top_silk bottom_silk
    top_paste bottom_paste outline drill_pth drill_npth drill_unknown drill_blind drawing unknown

``inner_copper`` carries the stackup number in ``index`` (L2..); ``drill_blind`` carries the
span in ``drill_span``.
"""

from __future__ import annotations

import re
import warnings
from dataclasses import asdict, dataclass
from pathlib import Path

LAYER_TYPES = (
    "top_copper", "inner_copper", "bottom_copper",
    "top_mask", "bottom_mask", "top_silk", "bottom_silk", "top_paste", "bottom_paste",
    "outline", "drill_pth", "drill_npth", "drill_unknown", "drill_blind", "drawing", "unknown",
)  # fmt: skip
COPPER_TYPES = ("top_copper", "inner_copper", "bottom_copper")
DRILL_TYPES = ("drill_pth", "drill_npth", "drill_unknown", "drill_blind")
LLM_THRESHOLD = 0.8

AUX_EXTENSIONS = {
    "gbrjob", "apr", "apr_lib", "rep", "extrep", "rul", "drr", "ldp", "csv", "pdf", "doc",
    "docx", "xls", "xlsx", "md", "log", "html", "htm", "ipc", "net", "json", "xml", "png", "jpg",
    "jpeg", "gif", "bmp", "zip", "rar", "7z", "brd", "sch", "kicad_pcb", "pcbdoc", "prjpcb",
    "dsn", "cam", "job", "ini", "bak",
}  # fmt: skip
AUX_STEMS = {"license", "licence", "readme", "changelog", "notes"}


@dataclass
class Sniff:
    is_gerber: bool = False
    is_excellon: bool = False
    is_text: bool = True
    file_function: tuple[str, ...] | None = None
    file_polarity: str | None = None
    has_sr: bool = False
    physical_order: int | None = None
    plated_marker: bool = False
    nonplated_marker: bool = False
    generator: str | None = None


@dataclass
class LayerGuess:
    file: str
    type: str = "unknown"
    index: int | None = None  # copper stackup number (1 = top)
    side: str | None = None  # top | bottom | inner | None
    polarity: str = "positive"
    drill_span: list[int] | None = None
    confidence: float = 0.0
    reason: str = ""
    needs_llm: bool = False
    aux: bool = False  # not a layer at all (job file, report, licence, ...)
    mixed_plating: bool = False
    sniff: Sniff | None = None

    def as_map_entry(self) -> dict:
        d = asdict(self)
        d.pop("sniff", None)
        d.pop("aux", None)
        return d


# ---------------------------------------------------------------------------------------------
# content sniffing
# ---------------------------------------------------------------------------------------------
_TF_FF = re.compile(r"TF\.FileFunction,([^*\n\r]+)")
_TF_POL = re.compile(r"TF\.FilePolarity,(\w+)")
_PHYS = re.compile(r"Layer_Physical_Order=(\d+)")
_GEN = re.compile(r"TF\.GenerationSoftware,([^*\n\r]+)")


def sniff_file(path: Path, head_bytes: int = 256 * 1024) -> Sniff:
    s = Sniff()
    raw = path.read_bytes()[:head_bytes]
    if b"\x00" in raw:
        s.is_text = False
        return s
    text = raw.decode("latin-1")
    s.is_gerber = bool(re.search(r"%FS[LTD]?[AI]X\d\dY\d\d\*%|%MO(MM|IN)\*%|%ADD\d+", text))
    s.is_excellon = bool(re.search(r"^\s*M48\s*$", text, re.MULTILINE)) or bool(
        re.search(r"^T\d+(?:F\d+)?(?:S\d+)?C[\d.]+", text, re.MULTILINE)
    )
    if m := _TF_FF.search(text):
        s.file_function = tuple(p.strip() for p in m.group(1).split(","))
    if m := _TF_POL.search(text):
        s.file_polarity = m.group(1).lower()
    if m := _GEN.search(text):
        s.generator = m.group(1).strip()
    if m := _PHYS.search(text):
        s.physical_order = int(m.group(1))
    # %SRX2Y3I..J..*% opens a step&repeat block (a bare %SR*% only closes one)
    s.has_sr = bool(re.search(r"%SR\s*[XYIJ]", text))
    up = text.upper()
    s.plated_marker = ";TYPE=PLATED" in up
    s.nonplated_marker = ";TYPE=NON_PLATED" in up or ";TYPE=NONPLATED" in up
    return s


# ---------------------------------------------------------------------------------------------
# rule 1: %TF.FileFunction
# ---------------------------------------------------------------------------------------------
def _side(tok: str) -> str | None:
    t = tok.lower()
    if t.startswith("top"):
        return "top"
    if t.startswith("bot"):
        return "bottom"
    if t.startswith(("inr", "in")):
        return "inner"
    return None


def classify_by_file_function(ff: tuple[str, ...], g: LayerGuess) -> bool:
    kind = ff[0].lower()
    args = ff[1:]
    if kind == "copper":
        n = None
        for a in args:
            if m := re.fullmatch(r"L(\d+)", a, re.IGNORECASE):
                n = int(m.group(1))
        side = next((_side(a) for a in args if _side(a)), None)
        if side == "top" or n == 1:
            g.type, g.side, g.index = "top_copper", "top", 1
        elif side == "bottom":
            g.type, g.side, g.index = "bottom_copper", "bottom", n
        else:
            g.type, g.side, g.index = "inner_copper", "inner", n
        if any(a.lower() == "plane" for a in args):
            g.polarity = "negative"
    elif kind in ("plated", "nonplated"):
        span = [int(a) for a in args[:2] if a.isdigit()]
        g.drill_span = span if len(span) == 2 else None
        g.type = "drill_pth" if kind == "plated" else "drill_npth"
        # whether the span is "through" or "blind" is decided once the copper count is known
    elif kind == "profile":
        g.type = "outline"
    elif kind == "soldermask":
        side = next((_side(a) for a in args if _side(a)), "top")
        g.type, g.side = f"{side}_mask", side
    elif kind == "legend":
        side = next((_side(a) for a in args if _side(a)), "top")
        g.type, g.side = f"{side}_silk", side
    elif kind == "paste":
        side = next((_side(a) for a in args if _side(a)), "top")
        g.type, g.side = f"{side}_paste", side
    elif kind in ("jobinfo", "netlist"):
        g.aux = True
        g.type = "unknown"
        g.reason = f"TF.FileFunction={ff[0]} (auxiliary, not a layer)"
        g.confidence = 0.98
        return True
    elif kind in (
        "drawing", "assemblydrawing", "other", "glue", "carbonmask", "goldmask", "heatsinkmask",
        "peelablemask", "silvermask", "tinmask", "vcut", "vcutmap", "viafill", "pads", "keepout",
        "component", "depthrout", "drillmap", "fabricationdrawing", "arraydrawing",
    ):  # fmt: skip
        g.type = "drawing"
    else:
        return False
    g.confidence = 0.98
    g.reason = f"%TF.FileFunction,{','.join(ff)}"
    return True


# ---------------------------------------------------------------------------------------------
# rule 2: extension / name
# ---------------------------------------------------------------------------------------------
# p110 layer naming table (knowledge/rules/layer_naming.yaml layer.name.*) + common variants
EXT_RULES: dict[str, tuple[str, str | None]] = {
    "gtl": ("top_copper", "top"), "gbl": ("bottom_copper", "bottom"),
    "gts": ("top_mask", "top"), "gbs": ("bottom_mask", "bottom"),
    "gto": ("top_silk", "top"), "gbo": ("bottom_silk", "bottom"),
    "gtp": ("top_paste", "top"), "gbp": ("bottom_paste", "bottom"),
    "gko": ("outline", None), "gml": ("outline", None), "gm1": ("outline", None),
    "gd1": ("drawing", None), "gg1": ("drawing", None),
    "gpt": ("drawing", "top"), "gpb": ("drawing", "bottom"),  # Altium pad master
    # EAGLE classic
    "cmp": ("top_copper", "top"), "sol": ("bottom_copper", "bottom"),
    "plc": ("top_silk", "top"), "pls": ("bottom_silk", "bottom"),
    "stc": ("top_mask", "top"), "sts": ("bottom_mask", "bottom"),
    "crc": ("top_paste", "top"), "crs": ("bottom_paste", "bottom"),
    "dim": ("outline", None), "mil": ("drawing", None),
    # Protel / generic
    "top": ("top_copper", "top"), "bot": ("bottom_copper", "bottom"),
    "smt": ("top_mask", "top"), "smb": ("bottom_mask", "bottom"),
    "sst": ("top_silk", "top"), "ssb": ("bottom_silk", "bottom"),
    "spt": ("top_paste", "top"), "spb": ("bottom_paste", "bottom"),
    "out": ("outline", None), "oln": ("outline", None), "brd": ("outline", None),
}  # fmt: skip
DRILL_EXTENSIONS = {"drl", "xln", "drd", "exc", "ncd", "tap", "nc", "dri", "drill"}
GERBER_EXTENSIONS = {"gbr", "ger", "gerber", "pho", "art", "gb", "grb"}

_NAME_RULES: list[tuple[re.Pattern[str], str, float]] = [
    # KiCad
    (re.compile(r"[-_.]f[_.]?cu$"), "top_copper", 0.92),
    (re.compile(r"[-_.]b[_.]?cu$"), "bottom_copper", 0.92),
    (re.compile(r"[-_.]in(\d+)[_.]?cu$"), "inner_copper", 0.92),
    (re.compile(r"[-_.]f[_.]?mask$"), "top_mask", 0.92),
    (re.compile(r"[-_.]b[_.]?mask$"), "bottom_mask", 0.92),
    (re.compile(r"[-_.]f[_.]?silk(s|screen)?$"), "top_silk", 0.92),
    (re.compile(r"[-_.]b[_.]?silk(s|screen)?$"), "bottom_silk", 0.92),
    (re.compile(r"[-_.]f[_.]?paste$"), "top_paste", 0.92),
    (re.compile(r"[-_.]b[_.]?paste$"), "bottom_paste", 0.92),
    (re.compile(r"[-_.]edge[_.]?cuts$"), "outline", 0.92),
    (re.compile(r"[-_.]npth$"), "drill_npth", 0.92),
    (re.compile(r"[-_.]pth$"), "drill_pth", 0.92),
    # EAGLE 9 CAM job names
    (re.compile(r"^copper[_-]?top$"), "top_copper", 0.9),
    (re.compile(r"^copper[_-]?bottom$"), "bottom_copper", 0.9),
    (re.compile(r"^copper[_-]?(?:inner|in|l)[_-]?(\d+)$"), "inner_copper", 0.9),
    (re.compile(r"^solder[_-]?mask[_-]?top$"), "top_mask", 0.9),
    (re.compile(r"^solder[_-]?mask[_-]?bottom$"), "bottom_mask", 0.9),
    (re.compile(r"^silk(?:screen)?[_-]?top$"), "top_silk", 0.9),
    (re.compile(r"^silk(?:screen)?[_-]?bottom$"), "bottom_silk", 0.9),
    (re.compile(r"^solder[_-]?paste[_-]?top$"), "top_paste", 0.9),
    (re.compile(r"^solder[_-]?paste[_-]?bottom$"), "bottom_paste", 0.9),
    (re.compile(r"^(profile|outline|board[_-]?outline|dimension)$"), "outline", 0.9),
    (re.compile(r"^drills?$"), "drill_unknown", 0.85),
    (re.compile(r"^milling$"), "drawing", 0.85),
    # generic english words (lower confidence -> needs_llm)
    (re.compile(r"(top|front).*(copper|layer|signal|trace)|(copper|signal).*(top|front)"), "top_copper", 0.75),
    (re.compile(r"(bottom|back).*(copper|layer|signal|trace)|(copper|signal).*(bottom|back)"), "bottom_copper", 0.75),
    (re.compile(r"(top|front).*(mask|solder)|(mask|solder).*(top|front)"), "top_mask", 0.75),
    (re.compile(r"(bottom|back).*(mask|solder)|(mask|solder).*(bottom|back)"), "bottom_mask", 0.75),
    (re.compile(r"(top|front).*(silk|legend|overlay)|(silk|legend|overlay).*(top|front)"), "top_silk", 0.75),
    (re.compile(r"(bottom|back).*(silk|legend|overlay)|(silk|legend|overlay).*(bottom|back)"), "bottom_silk", 0.75),
    (re.compile(r"(top|front).*(paste|stencil)|(paste|stencil).*(top|front)"), "top_paste", 0.75),
    (re.compile(r"(bottom|back).*(paste|stencil)|(paste|stencil).*(bottom|back)"), "bottom_paste", 0.75),
    (re.compile(r"outline|profile|board|edge|keep[-_]?out|mechanical|rout|contour|dimension"), "outline", 0.75),
    (re.compile(r"npth|non[-_]?plated|unplated"), "drill_npth", 0.8),
    (re.compile(r"(?<![a-z])pth|plated"), "drill_pth", 0.8),
    (re.compile(r"drill|hole|excellon|\bnc\b"), "drill_unknown", 0.75),
    # Chinese names (顶层/底层/阻焊/字符/外形/钻孔)
    (re.compile(r"(顶层|上层|正面|top).*(线路|铜|layer)|(线路|铜).*(顶层|上层|正面)"), "top_copper", 0.85),
    (re.compile(r"(底层|下层|反面|bottom).*(线路|铜|layer)|(线路|铜).*(底层|下层|反面)"), "bottom_copper", 0.85),
    (re.compile(r"(顶层|上层|正面).*(阻焊|防焊|绿油)|(阻焊|防焊|绿油).*(顶层|上层|正面)"), "top_mask", 0.85),
    (re.compile(r"(底层|下层|反面).*(阻焊|防焊|绿油)|(阻焊|防焊|绿油).*(底层|下层|反面)"), "bottom_mask", 0.85),
    (re.compile(r"(顶层|上层|正面).*(字符|丝印|文字)|(字符|丝印|文字).*(顶层|上层|正面)"), "top_silk", 0.85),
    (re.compile(r"(底层|下层|反面).*(字符|丝印|文字)|(字符|丝印|文字).*(底层|下层|反面)"), "bottom_silk", 0.85),
    (re.compile(r"(顶层|上层|正面).*(锡膏|钢网)|(锡膏|钢网).*(顶层|上层|正面)"), "top_paste", 0.85),
    (re.compile(r"(底层|下层|反面).*(锡膏|钢网)|(锡膏|钢网).*(底层|下层|反面)"), "bottom_paste", 0.85),
    (re.compile(r"内层[_-]?(\d+)|第(\d+)层|l(\d+)(?:层|$)"), "inner_copper", 0.85),
    (re.compile(r"外形|板框|轮廓|成型|锣带"), "outline", 0.85),
    (re.compile(r"非金属|非电镀"), "drill_npth", 0.85),
    (re.compile(r"钻孔|孔|drill"), "drill_unknown", 0.8),
    (re.compile(r"顶层|上层|正面"), "top_copper", 0.6),
    (re.compile(r"底层|下层|反面"), "bottom_copper", 0.6),
    (re.compile(r"阻焊|防焊"), "top_mask", 0.5),
    (re.compile(r"字符|丝印"), "top_silk", 0.5),
]  # fmt: skip

_SPAN_RES = [
    re.compile(r"(?<![a-z0-9])l(\d{1,2})[-_]l?(\d{1,2})(?![0-9])", re.IGNORECASE),
    re.compile(r"(?<![a-z0-9])(\d{1,2})[-_](\d{1,2})(?![0-9])"),
]


def drill_span_from_name(stem: str) -> list[int] | None:
    for rx in _SPAN_RES:
        if m := rx.search(stem):
            a, b = int(m.group(1)), int(m.group(2))
            if 1 <= a < b <= 64:
                return [a, b]
    return None


def _side_of(t: str) -> str | None:
    if t.startswith("top_"):
        return "top"
    if t.startswith("bottom_"):
        return "bottom"
    if t == "inner_copper":
        return "inner"
    return None


def classify_by_name(rel: str, g: LayerGuess, s: Sniff) -> bool:
    name = Path(rel).name
    lower = name.lower()
    stem, _, ext = lower.rpartition(".")
    if not stem:  # no extension at all
        stem, ext = lower, ""
    is_aux_name = ext in AUX_EXTENSIONS or stem in AUX_STEMS
    if is_aux_name and not (s.is_gerber or s.is_excellon):
        g.aux, g.type, g.confidence = True, "unknown", 0.95
        g.reason = f"auxiliary file (.{ext or stem})"
        return True

    # --- extension table (Altium / Protel / EAGLE classic, p110 GTL/GBL/GTS/...) ---
    if ext in EXT_RULES and not s.is_excellon:
        t, side = EXT_RULES[ext]
        g.type, g.side, g.confidence, g.reason = t, side, 0.9, f"extension .{ext}"
        if ext in ("gpt", "gpb"):
            g.reason += " (Altium pad master)"
        elif ext in ("gm1", "gko", "gml"):
            g.reason += " (Altium/Protel mechanical/keep-out used as outline)"
        return True
    # --- same table on the *stem* (客户常见:top.art / smt.gbr / gtl.pho —— 缩写在主文件名,扩展名是通用光绘后缀)---
    if stem in EXT_RULES and not s.is_excellon and (ext in GERBER_EXTENSIONS or ext == "" or ext not in DRILL_EXTENSIONS):
        t, side = EXT_RULES[stem]
        g.type, g.side, g.confidence, g.reason = t, side, 0.85, f"name '{stem}' (.{ext or '-'})"
        return True
    if m := re.fullmatch(r"g(\d{1,2})", ext):  # Altium mid layer G1.. = L2..
        n = int(m.group(1))
        g.type, g.side, g.index = "inner_copper", "inner", s.physical_order or n + 1
        g.confidence, g.reason = 0.9, f"extension .{ext} (Altium mid layer {n})"
        return True
    if m := re.fullmatch(r"gp(\d{1,2})", ext):  # Altium internal plane (negative)
        n = int(m.group(1))
        g.type, g.side, g.index = "inner_copper", "inner", s.physical_order or n + 1
        g.polarity = "negative"
        g.confidence, g.reason = 0.9, f"extension .{ext} (Altium internal plane, negative)"
        return True
    if m := re.fullmatch(r"gm(\d{1,2})", ext):
        g.type, g.confidence, g.reason = "drawing", 0.85, f"extension .{ext} (Altium mechanical)"
        return True
    if m := re.fullmatch(r"ly(\d{1,2})", ext):  # EAGLE classic inner: ly2 = layer 2
        g.type, g.side, g.index = "inner_copper", "inner", int(m.group(1))
        g.confidence, g.reason = 0.85, f"extension .{ext} (EAGLE inner layer)"
        return True

    # --- drill by extension / content, plating from the name ---
    if ext in DRILL_EXTENSIONS or s.is_excellon:
        if re.search(r"npth|non[-_]?plated|unplated|非金属", stem):
            g.type, g.confidence = "drill_npth", 0.9
        elif re.search(r"(?<![a-z])pth|plated|金属", stem):
            g.type, g.confidence = "drill_pth", 0.9
        elif s.plated_marker or s.nonplated_marker:
            g.type = "drill_pth" if s.plated_marker else "drill_npth"
            g.mixed_plating = s.plated_marker and s.nonplated_marker
            g.confidence = 0.88
        else:
            g.type, g.confidence = "drill_unknown", 0.7 if ext in DRILL_EXTENSIONS else 0.65
        g.reason = f"drill file (.{ext}{', M48 header' if s.is_excellon else ''})"
        if ext == "txt":
            g.reason += " Altium-style .TXT"
        g.drill_span = drill_span_from_name(stem)
        if g.drill_span:
            g.type = "drill_blind"
            g.reason += f" span L{g.drill_span[0]}-L{g.drill_span[1]}"
        return True

    # --- name patterns (KiCad, EAGLE 9, generic, Chinese) ---
    for rx, t, conf in _NAME_RULES:
        if m := rx.search(stem):
            g.type, g.confidence, g.reason = t, conf, f"name pattern {rx.pattern!r}"
            g.side = _side_of(t)
            if t == "inner_copper":
                n = next((int(x) for x in m.groups() if x and x.isdigit()), None)
                if n is not None:
                    # KiCad In1 = L2, "第2层"/L2 already a layer number
                    g.index = n + 1 if "in(" in rx.pattern else n
            if t.startswith("drill"):
                g.drill_span = drill_span_from_name(stem)
                if g.drill_span:
                    g.type = "drill_blind"
            return True
    return False


# ---------------------------------------------------------------------------------------------
# rule 3: content
# ---------------------------------------------------------------------------------------------
def looks_like_single_outline(path: Path) -> bool:
    """A Gerber consisting only of stroked lines/arcs that polygonise to one ring."""
    from gerbonara import graphic_objects as go
    from gerbonara.rs274x import GerberFile

    from engine.geom.profile import outline_rings

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            gf = GerberFile.open(path)
    except Exception:  # noqa: BLE001
        return False
    objs = gf.objects
    if not objs or len(objs) > 500:
        return False
    if not all(isinstance(o, (go.Line, go.Arc)) for o in objs):
        return False
    rings = outline_rings(gf)
    return len(rings) == 1


def classify_by_content(path: Path, g: LayerGuess, s: Sniff) -> None:
    if s.is_excellon:
        g.type, g.confidence, g.reason = "drill_unknown", 0.65, "content: Excellon M48 header"
        if s.plated_marker or s.nonplated_marker:
            g.type = "drill_pth" if s.plated_marker else "drill_npth"
            g.mixed_plating = s.plated_marker and s.nonplated_marker
            g.confidence = 0.75
    elif s.is_gerber:
        if looks_like_single_outline(path):
            g.type, g.confidence = "outline", 0.6
            g.reason = "content: Gerber with a single closed contour"
        else:
            g.type, g.confidence, g.reason = "unknown", 0.3, "content: Gerber, layer unknown"
    elif not s.is_text:
        g.aux, g.type, g.confidence, g.reason = True, "unknown", 0.9, "binary file, not a layer"
    else:
        g.type, g.confidence, g.reason = "unknown", 0.1, "unrecognised text file"


# ---------------------------------------------------------------------------------------------
def classify_file(path: Path, rel: str) -> LayerGuess:
    s = sniff_file(path)
    g = LayerGuess(file=rel, sniff=s)
    done = False
    if s.file_function:
        done = classify_by_file_function(s.file_function, g)
    if not done:
        done = classify_by_name(rel, g, s)
    if not done:
        classify_by_content(path, g, s)
    # content cross-check: a name that says Gerber but a body that says Excellon
    if s.is_excellon and g.type not in DRILL_TYPES and not g.aux:
        g.type, g.confidence = "drill_unknown", min(g.confidence, 0.6)
        g.reason += "; body is Excellon (M48), overriding"
    if s.file_polarity and g.type in COPPER_TYPES + ("top_mask", "bottom_mask"):
        g.polarity = s.file_polarity
    if g.type == "top_copper":
        g.index = 1
    if g.side is None:
        g.side = _side_of(g.type)
    g.confidence = round(g.confidence, 2)
    g.needs_llm = (not g.aux) and g.confidence < LLM_THRESHOLD
    return g
