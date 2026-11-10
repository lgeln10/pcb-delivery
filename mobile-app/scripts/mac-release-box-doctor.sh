#!/usr/bin/env bash
# Mac 发布机体检:在那台 Mac mini 上跑,一次性说清还缺什么。
#
# ★这是**体检**不是安装器 —— 大半步骤要 sudo 或要你在图形界面点确认,
#   脚本代劳只会留下「以为装好了其实没装上」。每一项不合格都直接给出修的命令。
#
#   ./scripts/mac-release-box-doctor.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '\033[31m✗\033[0m %s\n' "$1"; printf '   修:%s\n' "$2"; FAIL=$((FAIL+1)); }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }
head_() { printf '\n\033[36m── %s ──\033[0m\n' "$*"; }

head_ "1. Xcode 与命令行工具"
if [ -d /Applications/Xcode.app ]; then
  ok "Xcode $(xcodebuild -version 2>/dev/null | head -1 | awk '{print $2}')"
else
  bad "没装完整版 Xcode(Command Line Tools 不够,归档要完整 Xcode)" \
      "App Store 装 Xcode,或 https://developer.apple.com/download/"
fi
sel=$(xcode-select -p 2>/dev/null)
case "$sel" in
  /Applications/Xcode.app/*) ok "xcode-select → $sel" ;;
  *) bad "xcode-select 指向 $sel(不是完整 Xcode)" "sudo xcode-select -s /Applications/Xcode.app" ;;
esac
if xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  ok "Xcode 首次启动检查已完成(许可已接受)"
else
  bad "Xcode 许可未接受 / 组件未装齐 —— 无人值守时会卡在这里等输入" \
      "sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch"
fi

head_ "2. 构建依赖"
command -v node >/dev/null && ok "node $(node -v)" \
  || bad "没有 node" "brew install node@20"
command -v pod  >/dev/null && ok "CocoaPods $(pod --version 2>/dev/null)" \
  || bad "没有 CocoaPods(Capacitor iOS 必需)" "brew install cocoapods"
command -v git  >/dev/null && ok "git $(git --version | awk '{print $3}')" || bad "没有 git" "xcode-select --install"

head_ "3. ★钥匙串(自建 Mac runner 最经典的坑)"
# runner 若以 LaunchDaemon 跑(没有图形会话),签名时访问不到已解锁的登录钥匙串,
# codesign 会以 errSecInternalComponent 失败 —— 报错完全看不出跟钥匙串有关。
if launchctl print gui/"$(id -u)" >/dev/null 2>&1; then
  ok "当前是图形会话(GUI session)—— runner 用 ./svc.sh install 装成 LaunchAgent 才能签名"
else
  warn "当前不是图形会话。若 runner 也这样跑,codesign 会以 errSecInternalComponent 失败,"
  warn "而错误信息里一个字都不会提到钥匙串。见本节末尾。"
fi
if security show-keychain-info login.keychain-db 2>&1 | grep -q "no-timeout"; then
  ok "登录钥匙串不会自动上锁"
else
  bad "登录钥匙串会自动上锁 —— 无人值守构建到一半会突然签不了名" \
      "security set-keychain-settings -t 0 -l ~/Library/Keychains/login.keychain-db"
fi

head_ "4. 别睡着"
sleep_val=$(pmset -g 2>/dev/null | awk '/[^p]sleep/{print $2; exit}')
[ "${sleep_val:-1}" = "0" ] && ok "系统睡眠已关" \
  || bad "系统会睡眠(睡着时 runner 收不到任务)" "sudo pmset -a sleep 0 disablesleep 1"
if pmset -g 2>/dev/null | grep -q "womp *1"; then ok "支持网络唤醒"; else warn "未开网络唤醒(可选)"; fi

head_ "5. 磁盘"
avail=$(df -g / | awk 'NR==2{print $4}')
if [ "${avail:-0}" -ge 80 ]; then ok "可用 ${avail}G"
elif [ "${avail:-0}" -ge 40 ]; then warn "可用 ${avail}G —— 偏紧,DerivedData 涨得很快"
else bad "可用 ${avail}G,太少" "清 ~/Library/Developer/Xcode/DerivedData 与 Archives"; fi
warn "★磁盘满在 Xcode 里的表现是**签名莫名其妙失败**,不是「磁盘不足」。定期看这一项。"

head_ "6. GitHub Actions runner"
if pgrep -f "actions-runner|Runner.Listener" >/dev/null 2>&1; then
  ok "runner 进程在跑"
else
  bad "没有 runner 在跑" "见下方「装 runner」"
fi

head_ "7. App Store Connect 凭据"
if [ -f .asc/config.json ]; then
  ./scripts/asc.py whoami >/dev/null 2>&1 && ok "凭据可用" || bad "凭据在但调不通" "./scripts/asc.py whoami 看报错"
else
  warn "本机没有 .asc/(走 CI 时由 secret 现写,属正常)"
fi

head_ "8. 顺带:这台机能不能一起管安卓 / 鸿蒙"
[ -d "$HOME/Library/Android/sdk" ] && ok "有 Android SDK —— 安卓包也能在这台机出" \
  || warn "没有 Android SDK(想让这台机同时发安卓:brew install --cask android-commandlinetools temurin)"
[ -d /Applications/DevEco-Studio.app ] && ok "有 DevEco Studio —— 鸿蒙壳也能在这台机出" \
  || warn "没有 DevEco Studio(鸿蒙 NEXT 要它,macOS 版官网可下)"

printf '\n\033[36m════ %d 项通过,%d 项要修 ════\033[0m\n' "$PASS" "$FAIL"

cat <<'TIPS'

装 runner(标签必须含 mac,工作流按它选机器):
  1) 在本机(有 gh 登录的机器)取注册 token —— ★别用 shell 重定向取,用 python:
       python3 -c "import subprocess,json;print(json.loads(subprocess.run(['gh','api','-X','POST','repos/SixAM-Tech/AIOS/actions/runners/registration-token'],capture_output=True).stdout)['token'])"
  2) 在 Mac mini 上(用**专门的低权限用户**,别用你日常账号):
       mkdir -p ~/actions-runner && cd ~/actions-runner
       curl -o r.tar.gz -L https://github.com/actions/runner/releases/latest/download/actions-runner-osx-arm64-<版本>.tar.gz
       tar xzf r.tar.gz
       ./config.sh --url https://github.com/SixAM-Tech/AIOS --token <上一步的 token> --labels mac --name mac-1
       ./svc.sh install && ./svc.sh start

★★ 装成 LaunchAgent(`./svc.sh install` 不带 sudo)而不是 LaunchDaemon,
   并且给那个用户开**自动登录**。原因:签名要读钥匙串,而钥匙串属于图形会话;
   以 LaunchDaemon 跑时 codesign 会以 `errSecInternalComponent` 失败,
   **报错里一个字都不提钥匙串**,查起来能耗掉一整天。

★ 首次归档会自动创建 Distribution 证书并写进登录钥匙串(-allowProvisioningUpdates),
   所以第一次最好**手动在那台机上跑一遍** ./scripts/ios-release.sh archive,
   把可能弹出的钥匙串授权对话框点掉,之后才谈得上无人值守。
TIPS
[ "$FAIL" -eq 0 ]
