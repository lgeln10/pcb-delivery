"""Generate the C03 inputs (re-runnable):

    uv run --with openpyxl --with reportlab python cases/C03_order_spec/make_input.py

- ``input/board.zip``        identical to C01 (copied from cases/C01_two_layer_clean)
- ``input/制作要求.xlsx``    hand-written fabrication spec (openpyxl)
- ``input/制作要求.pdf``     the same content as a one-page PDF (reportlab, STSong CID font)
- ``input/order_spec.json``  what the confirmed spec looks like after the web-side LLM/human
                             step; ``engine.verify`` sends it as ``StageRequest.order_spec``

Planted inconsistency: the drill table copies C01's 9 tools but PTH **T03 is written as
1.2 mm instead of 1.0 mm** (p113 核对孔径大小及孔数 -> drill_table_mismatch EQ).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
C01_ZIP = ROOT / "cases" / "C01_two_layer_clean" / "input" / "board.zip"
INPUT = HERE / "input"

SPEC = [
    ("层数", "2"),
    ("板厚", "1.6 mm"),
    ("铜厚", "1 oz"),
    ("表面处理", "沉金"),
    ("阻焊颜色", "绿色"),
    ("字符颜色", "白色"),
    ("最小线宽/线距", "6/6 mil"),
    ("板材", "FR-4 TG150"),
]

# (file, tool, dia_mm, count, plated, slot) -- C01 drill_table.md, T03 deliberately 1.2
DRILL_TABLE = [
    ("NPTH", "T01", 0.65, 3, False, False),
    ("NPTH", "T02", 0.95, 1, False, False),
    ("PTH", "T01", 0.70, 14, True, False),
    ("PTH", "T02", 0.85, 2, True, False),
    ("PTH", "T03", 1.20, 40, True, False),  # <-- real Excellon value is 1.00
    ("PTH", "T04", 1.10, 4, True, False),
    ("PTH", "T05", 0.60, 10, True, True),
    ("PTH", "T06", 0.65, 2, True, True),
    ("PTH", "T07", 0.70, 4, True, True),
]
DRILL_HEAD = ["文件", "刀具", "属性", "成品孔径 (mm)", "数量", "槽孔"]


def drill_rows() -> list[list[str]]:
    return [
        [f, t, "PTH" if p else "NPTH", f"{d:.2f}", str(n), "是" if s else ""]
        for f, t, d, n, p, s in DRILL_TABLE
    ]


def write_xlsx(path: Path) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "制作要求"
    ws.append(["Flashpads 双面板 制作要求"])
    ws["A1"].font = Font(bold=True, size=14)
    ws.append([])
    for k, v in SPEC:
        ws.append([k, v])
    ws.append([])
    ws.append(["钻孔表"])
    ws[f"A{ws.max_row}"].font = Font(bold=True)
    ws.append(DRILL_HEAD)
    for c in ws[ws.max_row]:
        c.font = Font(bold=True)
    for row in drill_rows():
        ws.append(row)
    ws.append([])
    ws.append(["备注", "预大按贵司标准;槽孔按 Excellon G85 加工;板边 NPTH 请注意留距。"])
    ws.column_dimensions["A"].width = 18
    ws.column_dimensions["B"].width = 24
    wb.save(path)


def write_pdf(path: Path) -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    h = ParagraphStyle("h", fontName="STSong-Light", fontSize=16, leading=22)
    b = ParagraphStyle("b", fontName="STSong-Light", fontSize=10.5, leading=15)
    doc = SimpleDocTemplate(str(path), pagesize=A4, title="Flashpads 制作要求")
    grid = TableStyle(
        [
            ("FONTNAME", (0, 0), (-1, -1), "STSong-Light"),
            ("FONTSIZE", (0, 0), (-1, -1), 10),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8e8e8")),
        ]
    )
    story = [
        Paragraph("Flashpads 双面板 制作要求", h),
        Spacer(1, 8),
        Table([[k, v] for k, v in SPEC], colWidths=[110, 300], style=grid),
        Spacer(1, 12),
        Paragraph("钻孔表", h),
        Table([DRILL_HEAD, *drill_rows()], colWidths=[50, 50, 60, 100, 50, 50], style=grid),
        Spacer(1, 12),
        Paragraph("备注:预大按贵司标准;槽孔按 Excellon G85 加工;板边 NPTH 请注意留距。", b),
    ]
    doc.build(story)


def write_order_spec(path: Path) -> None:
    spec = {
        "_note": "C03 确认后的规格(网页端 LLM 候选 + 人工确认的结果);verify 直接送给 drill stage",
        "layers": 2,
        "thickness_mm": 1.6,
        "copper_oz": 1,
        "surface_finish": "ENIG",
        "mask_color": "green",
        "silk_color": "white",
        "min_trace_mil": 6,
        "min_space_mil": 6,
        "drill_table": [
            {"tool": t, "file": f, "dia_mm": d, "count": n, "plated": p, "slot": s}
            for f, t, d, n, p, s in DRILL_TABLE
        ],
    }
    path.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", "utf-8")


def main() -> None:
    INPUT.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(C01_ZIP, INPUT / "board.zip")
    write_xlsx(INPUT / "制作要求.xlsx")
    write_order_spec(INPUT / "order_spec.json")
    try:
        write_pdf(INPUT / "制作要求.pdf")
    except ImportError as e:  # reportlab not available
        print(f"  skipped PDF ({e}); xlsx + order_spec.json written")
    for p in sorted(INPUT.iterdir()):
        print(f"  {p.name:16} {p.stat().st_size:7} B")


if __name__ == "__main__":
    main()
