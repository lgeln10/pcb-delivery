#!/usr/bin/env bash
# iOS 发布流水线:归档 → 导出 .ipa → 上传 App Store Connect(进 TestFlight)。
#
# 鉴权全程用 **App Store Connect API Key**,不用 Apple ID+密码 ——
# 后者过不了双因素认证,任何无人值守环境都跑不了。
#
#   ./scripts/ios-release.sh preflight   只检查,不构建。缺什么一次性说清
#
# 加 `--internal` = **只发内部 TestFlight**(团队成员,≤100 人)。它与正式发布的唯一差别:
# 苹果对内部测试**不要求隐私政策 URL**(外部测试与上架才要)。所以这个开关只放行第 7 项,
# 其余八项照拦。★别拿它去发外部测试或上架 —— 那会带着一个坏链接过审核。
#   ./scripts/ios-release.sh archive     归档(Release + 自动签名,必要时自动创建描述文件)
#   ./scripts/ios-release.sh export      导出 .ipa
#   ./scripts/ios-release.sh validate    上传前校验(Apple 侧静态检查,能提前挡掉大多数退回)
#   ./scripts/ios-release.sh upload      真正上传   ← 这一步会把包送到苹果,不可撤回
#   ./scripts/ios-release.sh all         preflight → archive → export → validate(**不含 upload**)
#
# ★ all 刻意不含 upload:上传是**对外动作**,要单独一条命令、单独一次决定。
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$PWD"
ASC_DIR="$ROOT/.asc"
IOS_DIR="$ROOT/ios/App"
BUILD_DIR="$ROOT/ios/App/build/release"
ARCHIVE="$BUILD_DIR/App.xcarchive"
IPA_DIR="$BUILD_DIR/ipa"
TEAM_ID="QF97MLSRQA"

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

read_cfg() {
  [ -f "$ASC_DIR/config.json" ] || die "缺 mobile-app/.asc/config.json —— 见 APP_STORE_RELEASE.md §8(只有 Account Holder 能生成 API Key)"
  KEY_ID=$(python3 -c "import json;print(json.load(open('$ASC_DIR/config.json'))['keyId'])")
  ISSUER_ID=$(python3 -c "import json;print(json.load(open('$ASC_DIR/config.json'))['issuerId'])")
  KEY_FILE=$(python3 -c "import json;print(json.load(open('$ASC_DIR/config.json'))['keyFile'])")
  KEY_PATH="$ASC_DIR/$KEY_FILE"
  [ -f "$KEY_PATH" ] || die "私钥不在:$KEY_PATH"
}

preflight() {
  # $1 = --internal 时,第 7 项(隐私政策 URL)降级为警告。见文件头说明。
  local internal=''
  [ "${1:-}" = "--internal" ] && internal=1
  info "1/9 凭据"
  read_cfg
  ok "keyId=$KEY_ID  私钥=$KEY_FILE"

  info "2/9 密钥能不能用 + App 记录在不在"
  ./scripts/asc.py whoami

  info "3/9 隐私清单(2024-05 起强制,缺了上传即退 ITMS-91053)"
  [ -f "$IOS_DIR/App/PrivacyInfo.xcprivacy" ] || die "缺 ios/App/App/PrivacyInfo.xcprivacy"
  plutil -lint "$IOS_DIR/App/PrivacyInfo.xcprivacy" >/dev/null || die "PrivacyInfo.xcprivacy 不是合法 plist"
  ok "在,且格式合法"

  info "4/9 Release 的推送环境必须是 production"
  local aps
  aps=$(cd "$IOS_DIR" && xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
        -showBuildSettings 2>/dev/null | awk '/ APS_ENVIRONMENT =/{print $3}')
  [ "$aps" = "production" ] || die "Release 的 APS_ENVIRONMENT=$aps(应为 production)"
  ok "production —— ★后端 APNS_ENV 也必须是 production,否则「发送成功但收不到」"

  info "5/9 版本号"
  local mv cv
  mv=$(cd "$IOS_DIR" && xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
       -showBuildSettings 2>/dev/null | awk '/ MARKETING_VERSION =/{print $3}')
  cv=$(cd "$IOS_DIR" && xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
       -showBuildSettings 2>/dev/null | awk '/ CURRENT_PROJECT_VERSION =/{print $3}')
  ok "版本 $mv  build $cv"
  info "    已上传过的 build(重号会被 Apple 拒收):"
  ./scripts/asc.py builds 2>/dev/null | sed 's/^/    /' || true

  info "6/9 壳资源与 H5 同步"
  npx cap copy ios >/dev/null 2>&1 || die "cap copy ios 失败"
  grep -q "openScanner" "$IOS_DIR/App/public/app.js" 2>/dev/null \
    && ok "public/ 已刷新(扫码代码在包里)" || die "ios/App/App/public 里不是最新壳"

  info "7/9 隐私政策链接(外部 TestFlight 与上架都要填这个 URL)"
  if [ -n "$internal" ]; then
    printf '\033[33m⚠\033[0m 内部测试模式:跳过这一项。\n'
    printf '   ★这只对**内部** TestFlight(团队成员)成立。发外部测试或上架之前必须补上,\n'
    printf '     否则就是带着一个坏掉的隐私政策链接过审核 —— 那是会被下架的那一类问题。\n'
  else
  local url
  url=$(sed -n "s/^const PRIVACY_POLICY_URL = '\(.*\)'.*/\1/p" shell/app.js | head -1)
  if [ -z "$url" ]; then
    die "shell/app.js 的 PRIVACY_POLICY_URL 还是空的 —— 隐私政策还没有稳定的 HTTPS 地址。
     ★这不是可以先发后补的一项:外部 TestFlight 就要填它,首次启动的同意页也要链它。
     背景:AIOS 官网目前只有「无域名入口」(EC2 IP 直连,IP 还会变),见 APP_STORE_RELEASE.md §7。"
  fi
  case "$url" in
    https://*) : ;;
    *) die "PRIVACY_POLICY_URL 必须是 https(当前:$url)" ;;
  esac
  # ★真去抓一次。只校验「像个 URL」挡不住最常见的那种错:域名写对了、页面却是 404 或空壳。
  local code
  code=$(curl -sS -o /tmp/aios-privacy-check.html -w '%{http_code}' -L --max-time 20 "$url" 2>/dev/null || echo 000)
  [ "$code" = "200" ] || die "隐私政策页取不到($url → HTTP $code)"
  grep -q "隐私\|Privacy" /tmp/aios-privacy-check.html \
    || die "$url 返回了 200,但正文里没有隐私政策的内容 —— 多半是 SPA 空壳(商店的合规扫描不执行 JS)"
  rm -f /tmp/aios-privacy-check.html
  ok "$url 可访问且含正文"
  fi

  info "8/9 商店文案"
  # 字符超限是**提交时**才被拒的 —— 那时你已经等了一次构建、一次上传、一次处理。
  ./scripts/check-metadata.py | sed 's/^/    /' || die "商店文案不合规(见上)"

  info "9/9 工作区"
  if [ -n "$(git status --porcelain -- . 2>/dev/null)" ]; then
    printf '\033[33m⚠\033[0m mobile-app 下有未提交改动 —— 发出去的包将无法由 commit 还原\n'
  else
    ok "干净"
  fi
  echo
  ok "preflight 通过"
}

archive() {
  read_cfg
  info "归档(Release)…… 首次会自动创建 Distribution 证书与描述文件"
  rm -rf "$ARCHIVE"
  mkdir -p "$BUILD_DIR"
  (cd "$IOS_DIR" && xcodebuild archive \
      -workspace App.xcworkspace -scheme App -configuration Release \
      -destination 'generic/platform=iOS' \
      -archivePath "$ARCHIVE" \
      -authenticationKeyPath "$KEY_PATH" \
      -authenticationKeyID "$KEY_ID" \
      -authenticationKeyIssuerID "$ISSUER_ID" \
      -allowProvisioningUpdates \
      DEVELOPMENT_TEAM="$TEAM_ID") | tail -3
  [ -d "$ARCHIVE" ] || die "归档没产出"
  ok "$ARCHIVE"
  info "包内自检:"
  [ -f "$ARCHIVE/Products/Applications/App.app/PrivacyInfo.xcprivacy" ] \
    && ok "  隐私清单进包了" || die "  隐私清单没进包"
}

export_ipa() {
  read_cfg
  [ -d "$ARCHIVE" ] || die "还没有归档,先跑 archive"
  info "导出 .ipa"
  rm -rf "$IPA_DIR"
  (cd "$IOS_DIR" && xcodebuild -exportArchive \
      -archivePath "$ARCHIVE" \
      -exportOptionsPlist "$ROOT/ios/ExportOptions.plist" \
      -exportPath "$IPA_DIR" \
      -authenticationKeyPath "$KEY_PATH" \
      -authenticationKeyID "$KEY_ID" \
      -authenticationKeyIssuerID "$ISSUER_ID" \
      -allowProvisioningUpdates) | tail -3
  ls "$IPA_DIR"/*.ipa >/dev/null 2>&1 || die "没产出 .ipa"
  ok "$(ls -lh "$IPA_DIR"/*.ipa | awk '{print $NF, $5}')"
}

# altool 找 .p8 的目录靠这个环境变量;不设它就得把私钥拷进 ~/.appstoreconnect/private_keys,
# 那等于在家目录里多留一份密钥副本 —— 能不留就不留。
altool_env() { export API_PRIVATE_KEYS_DIR="$ASC_DIR"; }

validate() {
  read_cfg; altool_env
  local ipa; ipa=$(ls "$IPA_DIR"/*.ipa 2>/dev/null | head -1) || die "没有 .ipa,先跑 export"
  info "上传前校验(不会真的上传)"
  xcrun altool --validate-app -f "$ipa" -t ios \
    --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID" 2>&1 | tail -20
}

upload() {
  read_cfg; altool_env
  local ipa; ipa=$(ls "$IPA_DIR"/*.ipa 2>/dev/null | head -1) || die "没有 .ipa,先跑 export"
  printf '\033[33m⚠ 这一步会把包送到 App Store Connect,不可撤回。\033[0m\n'
  printf '   %s\n' "$ipa"
  # CI 里没有 tty:用 IOS_RELEASE_CONFIRM=yes 显式放行。
  # ★刻意做成「必须显式写 yes」而不是 --force 之类的开关 —— 上传是对外动作,
  #   默认永远是不传,少打一个字都不传。
  if [ "${IOS_RELEASE_CONFIRM:-}" = "yes" ]; then
    info "IOS_RELEASE_CONFIRM=yes,跳过交互确认"
  else
    [ -t 0 ] || die "非交互环境且未设 IOS_RELEASE_CONFIRM=yes,拒绝上传"
    read -r -p "   确认上传?输入 yes:" ans
    [ "$ans" = "yes" ] || die "已取消"
  fi
  xcrun altool --upload-app -f "$ipa" -t ios \
    --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID" 2>&1 | tail -20
  echo
  ok "已提交。Apple 侧处理 5–30 分钟,期间用 ./scripts/asc.py builds 看状态。"
  info "processingState=VALID 之后才能分配给 TestFlight 测试组。"
}

case "${1:-preflight}" in
  preflight) preflight "${2:-}" ;;
  archive)   read_cfg; archive ;;
  export)    export_ipa ;;
  validate)  validate ;;
  upload)    upload ;;
  all)       preflight "${2:-}"; archive; export_ipa; validate
             echo; info "没有自动上传 —— 要传就单独跑:./scripts/ios-release.sh upload" ;;
  *) die "不认识:$1(preflight|archive|export|validate|upload|all)" ;;
esac
