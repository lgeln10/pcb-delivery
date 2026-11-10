#!/bin/sh
# 一轮对标 = 三块真板并行复验 → 各自出快照 → 汇总跨轮对比 → 同步到页面上的演示任务。
# 用法：sh tools/round.sh 13 [case ...]        （不带 case 就是三块真板）
# 同一个 case 绝不并行（共用 data/verify/<case>/）；不同 case 并行没问题。
set -u
N="$1"; shift
CASES="${*:-C09_real_6l_3oz C12_real_4l_protel99 C11_real_4l_altium}"
LOG="${PCB_ROUND_LOG_DIR:-data/round-logs}"
cd "$(dirname "$0")/.."
mkdir -p "$LOG"; rm -f "$LOG/round${N}.done"
for c in $CASES; do
  (
    uv run python -m engine.verify "$c" > "$LOG/verify${N}_$c.log" 2>&1
    echo "EXIT $?" >> "$LOG/verify${N}_$c.log"
    uv run python -m engine.snapshot "$c" > "$LOG/snap${N}_$c.log" 2>&1
  ) &
done
wait
uv run python -m engine.rounds > "$LOG/rounds${N}.log" 2>&1
uv run python -m engine.demo_sync $CASES >> "$LOG/rounds${N}.log" 2>&1   # 跑完直接推页面，不用再跑一遍
echo "ROUND${N}_DONE" > "$LOG/round${N}.done"
tail -3 "$LOG/rounds${N}.log"
