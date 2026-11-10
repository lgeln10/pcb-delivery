"""C07 拼板 + 输出：C01 的板 + 客户拼板要求（order_spec）+ 工厂标准覆盖（profile.yaml）。

    uv run python cases/C07_panel_output/make_input.py

Nothing is planted in the Gerbers (they are C01's); the case exercises the panel plan, the
factory-format output, the round trip and the gatekeeper re-read with a *tenant profile*:
working panel 406.4×508 only, rail 10 mm, gap 2 mm, output stem "C07".
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
C01 = ROOT / "cases" / "C01_two_layer_clean" / "input" / "board.zip"

PROFILE = """# C07 工厂标准覆盖（只写与默认不同的键）
panel:
  working_panels_mm: [[406.4, 508.0]]   # 只用 16×20 in 工作板
  rail_mm: 10.0                          # 工艺边 10mm（放定位孔/挂孔）
  gap_mm: 2.0
output:
  stem: "C07"                            # 输出文件主名
"""

ORDER_SPEC = {
    "panelization": "客户要求：2×3 拼板，V-CUT，工艺边 5mm 两侧加 mark 点（参考上一版本）",
    "solder_mask_color": "绿色",
    "customer_notes": ["拼板方式参考前版本 A1234"],
}


def main() -> None:
    (HERE / "input").mkdir(parents=True, exist_ok=True)
    shutil.copy(C01, HERE / "input" / "board.zip")
    (HERE / "input" / "profile.yaml").write_text(PROFILE, "utf-8")
    (HERE / "input" / "order_spec.json").write_text(json.dumps(ORDER_SPEC, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print("wrote C07 input (board.zip = C01, profile.yaml, order_spec.json)")


if __name__ == "__main__":
    main()
