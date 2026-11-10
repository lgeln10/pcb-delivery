#!/usr/bin/env bash
# 两端版本号一起改。★这个脚本存在的唯一理由:版本号有四个地方,手改必然漏。
#
#   安卓  android/variables.gradle   appVersionName   ← 商店展示
#                                    appVersionCode   ← **商店按它判新旧**,不涨就当成同一版拒收
#   iOS   App.xcodeproj              MARKETING_VERSION      ← App Store 展示
#                                    CURRENT_PROJECT_VERSION ← **TestFlight 按它去重**,重传必须涨
#
# 用法:
#   ./scripts/bump-version.sh 1.0.1    设版本号为 1.0.1,两端 build 号各 +1
#   ./scripts/bump-version.sh --build  版本号不动,只把两端 build 号 +1(同一版重传 TestFlight)
#
# 改完记得 `npx cap copy ios && npx cap copy android`,并把改动一起提交。
set -euo pipefail
cd "$(dirname "$0")/.."

GRADLE=android/variables.gradle
PBX=ios/App/App.xcodeproj/project.pbxproj
[ -f "$GRADLE" ] && [ -f "$PBX" ] || { echo "找不到 $GRADLE 或 $PBX(在 mobile-app/ 下跑)"; exit 1; }

MODE="${1:-}"
[ -n "$MODE" ] || { echo "用法:$0 <x.y.z> | --build"; exit 1; }
if [ "$MODE" != "--build" ]; then
  echo "$MODE" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "版本号要写成 x.y.z(收到:$MODE)"; exit 1; }
fi

python3 - "$MODE" "$GRADLE" "$PBX" <<'PY'
import re, sys, pathlib
mode, gradle_path, pbx_path = sys.argv[1], sys.argv[2], sys.argv[3]

g = pathlib.Path(gradle_path); gs = g.read_text(encoding='utf-8')
m = re.search(r'appVersionCode\s*=\s*(\d+)', gs)
if not m: sys.exit('variables.gradle 里找不到 appVersionCode')
new_code = int(m.group(1)) + 1
gs = gs[:m.start(1)] + str(new_code) + gs[m.end(1):]

if mode != '--build':
    n = re.search(r"appVersionName\s*=\s*'([^']+)'", gs)
    if not n: sys.exit('variables.gradle 里找不到 appVersionName')
    old_name = n.group(1)
    gs = gs[:n.start(1)] + mode + gs[n.end(1):]
else:
    old_name = re.search(r"appVersionName\s*=\s*'([^']+)'", gs).group(1)
g.write_text(gs, encoding='utf-8')

p = pathlib.Path(pbx_path); ps = p.read_text(encoding='utf-8')
# 两个 XCBuildConfiguration(Debug/Release)各有一份,必须一起改 —— 只改一份的后果是
# 「本机装的是新版、archive 出来的是旧版」,而两边都不报错。
n_build = len(re.findall(r'CURRENT_PROJECT_VERSION = \d+;', ps))
if n_build == 0: sys.exit('pbxproj 里找不到 CURRENT_PROJECT_VERSION')
ps = re.sub(r'CURRENT_PROJECT_VERSION = \d+;', f'CURRENT_PROJECT_VERSION = {new_code};', ps)
if mode != '--build':
    n_mk = len(re.findall(r'MARKETING_VERSION = [0-9.]+;', ps))
    if n_mk == 0: sys.exit('pbxproj 里找不到 MARKETING_VERSION')
    ps = re.sub(r'MARKETING_VERSION = [0-9.]+;', f'MARKETING_VERSION = {mode};', ps)
p.write_text(ps, encoding='utf-8')

name = old_name if mode == '--build' else mode
print(f'版本名 = {name}   build = {new_code}   (安卓 versionCode / iOS CURRENT_PROJECT_VERSION 同号)')
print(f'iOS 改了 {n_build} 处 build 号' + ('' if mode == '--build' else f' + {n_mk} 处版本名'))
PY

echo
echo "下一步:npx cap copy ios && npx cap copy android,然后连改动一起提交。"
