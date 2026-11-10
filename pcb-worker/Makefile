.PHONY: sync test serve verify verify-all round demo-sync probe lint

sync:
	uv sync

test:
	uv run pytest -q

serve:
	uv run uvicorn engine.api.main:app --reload --port 8000

lint:
	uv run ruff check engine tests

# usage: make verify CASE=C02_drill_defects   (a cases/<id> dir, or a bare fixture dir/archive)
# Runs intake -> align -> drill in-process and diffs cases/<id>/expected/*.json; exit 1 on FAIL.
verify:
	uv run python -m engine.verify $(CASE)

# 一轮对标：三块真板并行复验 → 快照 → 跨轮汇总 → 同步到页面（用法 make round N=13）
round:
	sh tools/round.sh $(N) $(CASE)

# 量差异的尺子（子命令见 tools/probe.py 开头）：make probe A="piles C12_real_4l_protel99 .gtl"
probe:
	uv run python tools/probe.py $(A)

# 把 data/verify 的结果同步到页面上的演示任务（不重跑；页面的检查项/EQ 仍是上次页面自己跑的）
demo-sync:
	uv run python -m engine.demo_sync $(CASE)

verify-all:
	uv run python -m engine.verify --all
