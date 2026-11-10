"""把 `engine.verify` 跑出来的结果同步到页面上的演示任务里（yibing 2026-09-21：
「测试的时候也跑了，同步保持结果就好，不要改完还要完全重跑一次」）。

verify 和页面用的是两套存储，目录结构一样、只是前缀不同：

    verify   storage/pcb-cam/verify/<case>/<stage>/...        work/<case>/
    页面     uploads/pcb-cam/<tenant>/<job>/<stage>/...       data/work/<job>/

所以同步 = 把对象树和 work 树照搬过去，再把 json 里的存储前缀改写成页面那套，
最后删掉对比缓存让页面重算。**只同步文件**：页面上「检查项 / EQ」那些列表是数据库里的行，
仍然是上一次页面自己跑出来的，不会被这个命令改动。

    uv run python -m engine.demo_sync                 # 三块真板
    uv run python -m engine.demo_sync C12_real_4l_protel99
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = os.environ.get("PCB_DEMO_API", "http://127.0.0.1:3105/api")
UPLOADS = Path(os.environ.get("PCB_STORAGE_ROOT", "/Users/yibing/coding/aios-pcb/standard-build/uploads"))
WORK = Path(os.environ.get("PCB_WORK_ROOT", ROOT / "data" / "work"))
VERIFY_ROOT = Path(os.environ.get("PCB_VERIFY_ROOT", ROOT / "data" / "verify"))
CASES = ("C09_real_6l_3oz", "C11_real_4l_altium", "C12_real_4l_protel99")


def _api(path: str, method: str = "GET", body: dict | None = None, token: str = "") -> dict:
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.loads(r.read() or b"{}")


def demo_token() -> str:
    d = _api("/auth/demo-login", "POST", {})
    return d.get("token") or d.get("data", {}).get("token", "")


def jobs_by_case(token: str) -> dict[str, str]:
    """案例 → 页面任务 id（按项目名里的 C09 / C11 / C12 配对）。"""
    d = _api("/pcb-cam/jobs", token=token)
    items = d if isinstance(d, list) else (d.get("items") or d.get("data") or [])
    out = {}
    for case in CASES:
        tag = case[:3]
        hit = next((j for j in items if tag in (j.get("name") or j.get("projectName") or "")), None)
        if hit:
            out[case] = hit["id"]
    return out


def _copy_tree(src: Path, dst: Path, rewrite: tuple[str, str], skip: set[str] = frozenset()) -> int:
    n = 0
    for p in sorted(src.rglob("*")):
        if p.is_dir() or any(part in skip for part in p.parts):
            continue
        rel = p.relative_to(src)
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if p.suffix.lower() == ".json":
            target.write_text(p.read_text("utf-8").replace(*rewrite), "utf-8")
        else:
            shutil.copy2(p, target)
        n += 1
    return n


def sync(case: str, job: str, token: str) -> str:
    base = VERIFY_ROOT / case
    src_objs = base / "storage" / "pcb-cam" / "verify" / case
    src_work = base / "work" / case
    if not src_objs.is_dir() or not src_work.is_dir():
        return f"{case}: data/verify 里没有跑过的结果，跳过"
    tenant_dirs = [d for d in (UPLOADS / "pcb-cam").glob("*") if (d / job).is_dir()]
    if not tenant_dirs:
        return f"{case}: uploads 里找不到任务 {job} 的目录，跳过"
    dst_objs = tenant_dirs[0] / job
    dst_work = WORK / job
    rewrite = (f"pcb-cam/verify/{case}/", f"pcb-cam/{tenant_dirs[0].name}/{job}/")
    n1 = _copy_tree(src_objs, dst_objs, rewrite)
    n2 = _copy_tree(src_work, dst_work, rewrite, skip={"cache"})
    for stale in (dst_work / "cache").glob("*"):
        stale.unlink()                      # 折叠缓存按 mtime 判新旧，删干净最稳
    res = _api(f"/pcb-cam/jobs/{job}/compare?force=true", token=token)
    layers = res.get("layers") or []
    worst = max((L.get("shape_pct") or 0 for L in layers), default=0)
    return f"{case} → {job[:8]}：对象 {n1} 个、work {n2} 个；页面对比已刷新（{len(layers)} 层，最差 {worst:.2f}%）"


def main(argv: list[str]) -> int:
    cases = [a for a in argv if not a.startswith("-")] or list(CASES)
    token = demo_token()
    mapping = jobs_by_case(token)
    rc = 0
    for case in cases:
        job = mapping.get(case)
        if not job:
            print(f"{case}: 页面上没有对应的演示任务，跳过", file=sys.stderr)
            rc = 1
            continue
        print(sync(case, job, token))
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
