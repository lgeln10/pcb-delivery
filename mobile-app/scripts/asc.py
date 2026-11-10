#!/usr/bin/env python3
"""App Store Connect API 客户端(零第三方依赖)。

★为什么不用 fastlane:本机是系统 Ruby 2.6,装 fastlane 要么污染系统 gem 要么再引一套
  Ruby 版本管理;而这台机器上 python3 与 openssl 都是现成的。ASC 的 REST API 很稳,
  自己签 JWT 只有 40 行 —— 换来的是「clone 下来就能跑」,没有第二套语言的依赖树。

鉴权用 **App Store Connect API Key**(不是 Apple ID + 密码):
  · 不受双因素认证影响,能在无人值守环境跑
  · 权限可控(建议 App Manager,不要 Admin)
  · 密钥只能由 Account Holder 在网页生成,**.p8 只能下载一次**

凭据放在 mobile-app/.asc/(整个目录已 gitignore):
  .asc/config.json    {"keyId": "...", "issuerId": "...", "keyFile": "AuthKey_XXXXXXXXXX.p8"}
  .asc/AuthKey_*.p8   私钥本体

用法:
  ./scripts/asc.py selftest               # 自检 JWT 签名(不需要真凭据)
  ./scripts/asc.py whoami                 # 验密钥能用 + 列出账号下的 App
  ./scripts/asc.py app                    # 本 bundleId 的 App 记录(没有会告诉你)
  ./scripts/asc.py builds                 # 最近的构建与处理状态(上传后看这里)
  ./scripts/asc.py groups                 # TestFlight 测试组
  ./scripts/asc.py get /v1/apps           # 任意 GET,方便排查
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASC_DIR = os.path.join(ROOT, '.asc')
API = 'https://api.appstoreconnect.apple.com'
BUNDLE_ID = 'ai.sixamtech.aios'
# 隐私政策公网地址。与 mobile-app/shell/app.js 的 PRIVACY_POLICY_URL 同一个值。
PRIVACY_URL = 'https://base.sixamtech.ai/app-privacy'


def die(msg, code=1):
    print(f'✗ {msg}', file=sys.stderr)
    sys.exit(code)


def load_config():
    cfg_path = os.path.join(ASC_DIR, 'config.json')
    if not os.path.exists(cfg_path):
        die(
            'mobile-app/.asc/config.json 不存在。\n'
            '  这一步只有 Account Holder 能做,见 scripts/asc.py 顶部说明与\n'
            '  standard-build/docs/design/APP_STORE_RELEASE.md §8。'
        )
    with open(cfg_path, encoding='utf-8') as f:
        cfg = json.load(f)
    for k in ('keyId', 'issuerId', 'keyFile'):
        if not cfg.get(k):
            die(f'config.json 里缺 {k}')
    cfg['keyPath'] = os.path.join(ASC_DIR, cfg['keyFile'])
    if not os.path.exists(cfg['keyPath']):
        die(f"私钥不在:{cfg['keyPath']}")
    return cfg


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def _der_to_raw(der: bytes) -> bytes:
    """ECDSA 签名 DER → JWS 要的 r||s 原始格式(各 32 字节)。

    ★openssl 输出的是 DER(SEQUENCE{INTEGER r, INTEGER s}),而 JWT ES256 要的是
      定长 64 字节。直接把 DER 塞进去,Apple 一律回 401 且**不说为什么** ——
      这是自己签 JWT 最常见的一个坑。
    """
    if der[0] != 0x30:
        raise ValueError('不是 DER SEQUENCE')
    idx = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)

    def read_int(i):
        if der[i] != 0x02:
            raise ValueError('期望 INTEGER')
        ln = der[i + 1]
        val = der[i + 2:i + 2 + ln]
        return val.lstrip(b'\x00').rjust(32, b'\x00'), i + 2 + ln

    r, idx = read_int(idx)
    s, _ = read_int(idx)
    return r + s


def make_token(cfg) -> str:
    now = int(time.time())
    header = {'alg': 'ES256', 'kid': cfg['keyId'], 'typ': 'JWT'}
    # ★有效期最长 20 分钟,超过 Apple 直接拒。这里给 15 分钟留余量。
    payload = {'iss': cfg['issuerId'], 'iat': now, 'exp': now + 900, 'aud': 'appstoreconnect-v1'}
    signing_input = f"{_b64u(json.dumps(header, separators=(',', ':')).encode())}." \
                    f"{_b64u(json.dumps(payload, separators=(',', ':')).encode())}"
    proc = subprocess.run(
        ['openssl', 'dgst', '-sha256', '-sign', cfg['keyPath'], '-binary'],
        input=signing_input.encode(), capture_output=True,
    )
    if proc.returncode != 0:
        die(f"openssl 签名失败:{proc.stderr.decode(errors='replace')[:300]}")
    return f'{signing_input}.{_b64u(_der_to_raw(proc.stdout))}'


def request(cfg, method, path, body=None, soft=False):
    url = path if path.startswith('http') else API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + make_token(cfg))
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')
        try:
            errs = json.loads(detail).get('errors', [])
            detail = '\n  '.join(f"{x.get('title')}: {x.get('detail')}" for x in errs) or detail
        except Exception:
            pass
        if soft:
            return {'__error__': detail, '__status__': e.code}
        die(f'{method} {path} → HTTP {e.code}\n  {detail}')
    except urllib.error.URLError as e:
        die(f'连不上 App Store Connect:{e.reason}')


def find_app(cfg):
    data = request(cfg, 'GET', f'/v1/apps?filter[bundleId]={BUNDLE_ID}&limit=1')
    items = data.get('data', [])
    return items[0] if items else None


def _raw_to_der(raw: bytes) -> bytes:
    """r||s → DER,只给 selftest 用(openssl 验签只认 DER)。"""
    def enc_int(b: bytes) -> bytes:
        b = b.lstrip(b'\x00') or b'\x00'
        if b[0] & 0x80:
            b = b'\x00' + b
        return b'\x02' + bytes([len(b)]) + b
    body = enc_int(raw[:32]) + enc_int(raw[32:])
    return b'\x30' + bytes([len(body)]) + body


def selftest():
    """自签自验一遍 JWT,证明 ES256 那段是对的。

    ★为什么值得写:JWT 签错时 Apple **一律回 401 且不说原因**,而最容易错的
      恰恰是 DER→r||s 那一步(openssl 出 DER,JWS 要定长 64 字节)。
      没有这个自检,就只能靠「换个写法再试一次」去猜,而每次猜都要一次真请求。
      这里用**临时生成的**密钥,不碰任何真凭据。
    """
    import shutil
    import tempfile
    tmp = tempfile.mkdtemp()
    try:
        key = os.path.join(tmp, 'test.p8')
        pub = os.path.join(tmp, 'test.pub')
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'EC',
                        '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key],
                       check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', key, '-pubout', '-out', pub],
                       check=True, capture_output=True)

        token = make_token({'keyId': 'TESTKEY123', 'issuerId': 'test-issuer', 'keyPath': key})
        head, payload, sig = token.split('.')

        raw = base64.urlsafe_b64decode(sig + '=' * (-len(sig) % 4))
        assert len(raw) == 64, f'签名应为 64 字节,实际 {len(raw)} —— DER→raw 那步错了'

        der = os.path.join(tmp, 'sig.der')
        with open(der, 'wb') as f:
            f.write(_raw_to_der(raw))
        msg = os.path.join(tmp, 'msg')
        with open(msg, 'wb') as f:
            f.write(f'{head}.{payload}'.encode())
        r = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', pub,
                            '-signature', der, msg], capture_output=True)
        assert r.returncode == 0, f"验签失败:{r.stdout.decode()}{r.stderr.decode()}"

        h = json.loads(base64.urlsafe_b64decode(head + '=' * (-len(head) % 4)))
        pl = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        assert h == {'alg': 'ES256', 'kid': 'TESTKEY123', 'typ': 'JWT'}, h
        assert pl['aud'] == 'appstoreconnect-v1', pl
        assert 0 < pl['exp'] - pl['iat'] <= 1200, 'ASC 要求有效期不超过 20 分钟'
        print('✓ selftest 通过:ES256 签名可被 openssl 验证,header/payload 形状正确')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)



# ── 商店文案推送 ──────────────────────────────────────────────────────────────

METADATA_DIR = os.path.join(ROOT, 'metadata')

# 本地目录名 → App Store Connect 的 locale 代码(两者不完全一样,别硬拼)
LOCALE_MAP = {'zh-Hans': 'zh-Hans', 'en-US': 'en-US'}

# 文件 → 字段。分两组:appInfoLocalizations(与版本无关)与 appStoreVersionLocalizations(随版本)
APP_INFO_FIELDS = {'name.txt': 'name', 'subtitle.txt': 'subtitle'}
VERSION_FIELDS = {
    'description.txt': 'description',
    'keywords.txt': 'keywords',
    'release_notes.txt': 'whatsNew',
    'promotional_text.txt': 'promotionalText',
}


def _read(locale_dir: str, fname: str):
    p = os.path.join(METADATA_DIR, locale_dir, fname)
    if not os.path.exists(p):
        return None
    with open(p, encoding='utf-8') as f:
        return f.read().strip()


def _create_or_update(cfg, kind, list_path, create_body, attrs, locale, dry, label):
    """先 POST;撞上「该 locale 已存在」就回头查出 id 改 PATCH。

    ★为什么不能只靠开跑前那份快照:上一轮跑到一半失败时,可能已经建出了一部分。
      再跑一次,快照里没有、线上已经有 → POST 回 409「already exists. Try updating.」,
      于是这个命令**永远跑不完**,而每次报的都是同一个看起来无关的错。
      要么每次操作前重查,要么像这里一样把「已存在」当成正常分支。
    """
    if dry:
        print(f'  {label} 新建 {locale} {list(attrs)}')
        return
    out = request(cfg, 'POST', list_path, create_body, soft=True)
    if '__error__' not in out:
        print(f'  {label} 新建 {locale} {list(attrs)}')
        return
    if 'already exists' not in out['__error__']:
        die(f'POST {list_path} 失败:{out["__error__"]}')
    # 已经有了:重查拿 id 再 PATCH
    parent = create_body['data']['relationships']
    rel_path = list(parent.values())[0]['data']
    owner = f"/v1/{rel_path['type']}/{rel_path['id']}/{kind}"
    found = {x['attributes']['locale']: x['id'] for x in request(cfg, 'GET', owner).get('data', [])}
    if locale not in found:
        die(f'{locale} 说已存在,重查却找不到 —— 去 {owner} 看一眼')
    print(f'  {label} 已存在 → 改为更新 {locale} {list(attrs)}')
    request(cfg, 'PATCH', f'/v1/{kind}/{found[locale]}',
            {'data': {'type': kind, 'id': found[locale], 'attributes': attrs}})


def push_metadata(cfg, dry=False):
    """把 metadata/ 下的文案推到 App Store Connect。

    ★为什么值得做成命令而不是手工在网页上贴:文案要中英两版 × 6 个字段 × 每次发版都改,
      手工贴必然出现「网页上是新的、仓里是旧的」,而那时你无法回答「线上到底写的什么」。
      仓里那份是唯一来源,这条命令只负责让线上等于它。
    """
    app = find_app(cfg)
    if not app:
        die(f'账号下没有 bundleId={BUNDLE_ID} 的 App 记录')
    app_id = app['id']

    infos = request(cfg, 'GET', f'/v1/apps/{app_id}/appInfos')
    # 只改还能改的那个(已上架的 appInfo 是只读的)
    editable = [i for i in infos.get('data', []) if i['attributes'].get('state') != 'READY_FOR_DISTRIBUTION']
    info_id = (editable or infos['data'])[0]['id']

    vers = request(cfg, 'GET', f'/v1/apps/{app_id}/appStoreVersions?limit=20')
    if not vers.get('data'):
        die('没有可编辑的版本')
    ver_id = vers['data'][0]['id']
    ver_str = vers['data'][0]['attributes'].get('versionString')

    # ★首发版本不能写 whatsNew。「本次更新内容」只对**更新**有意义,初版没有上一版可比 ——
    #   硬写会回 409「Attribute 'whatsNew' cannot be edited at this time」,而错误信息里
    #   一个字都不提「因为这是首发」。判据:有没有任何一个版本上过架。
    released = [v for v in vers['data']
                if v['attributes'].get('appStoreState') in ('READY_FOR_SALE', 'REPLACED_WITH_NEW_INFO')]
    first_release = not released
    print(f'App {app_id} · appInfo {info_id} · 版本 {ver_str} ({ver_id})'
          + ('  [首发版本 → 跳过 whatsNew]' if first_release else ''))

    have_info = {x['attributes']['locale']: x['id']
                 for x in request(cfg, 'GET', f'/v1/appInfos/{info_id}/appInfoLocalizations').get('data', [])}
    have_ver = {x['attributes']['locale']: x['id']
                for x in request(cfg, 'GET', f'/v1/appStoreVersions/{ver_id}/appStoreVersionLocalizations').get('data', [])}

    for d, loc in LOCALE_MAP.items():
        if not os.path.isdir(os.path.join(METADATA_DIR, d)):
            continue
        print(f'\n[{loc}]')

        attrs = {f: _read(d, k) for k, f in APP_INFO_FIELDS.items()}
        attrs = {k: v for k, v in attrs.items() if v}
        if attrs:
            if loc in have_info:
                print('  appInfo  更新', list(attrs), '→', have_info[loc])
                if not dry:
                    request(cfg, 'PATCH', f'/v1/appInfoLocalizations/{have_info[loc]}',
                            {'data': {'type': 'appInfoLocalizations', 'id': have_info[loc], 'attributes': attrs}})
            else:
                _create_or_update(cfg, 'appInfoLocalizations', '/v1/appInfoLocalizations', {'data': {
                    'type': 'appInfoLocalizations',
                    'attributes': {**attrs, 'locale': loc},
                    'relationships': {'appInfo': {'data': {'type': 'appInfos', 'id': info_id}}},
                }}, attrs, loc, dry, 'appInfo ')

        vattrs = {f: _read(d, k) for k, f in VERSION_FIELDS.items()}
        vattrs = {k: v for k, v in vattrs.items() if v}
        if first_release:
            vattrs.pop('whatsNew', None)
        if vattrs:
            if loc in have_ver:
                print('  version  更新', list(vattrs), '→', have_ver[loc])
                if not dry:
                    request(cfg, 'PATCH', f'/v1/appStoreVersionLocalizations/{have_ver[loc]}',
                            {'data': {'type': 'appStoreVersionLocalizations', 'id': have_ver[loc], 'attributes': vattrs}})
            else:
                _create_or_update(cfg, 'appStoreVersionLocalizations', '/v1/appStoreVersionLocalizations', {'data': {
                    'type': 'appStoreVersionLocalizations',
                    'attributes': {**vattrs, 'locale': loc},
                    'relationships': {'appStoreVersion': {'data': {'type': 'appStoreVersions', 'id': ver_id}}},
                }}, vattrs, loc, dry, 'version ')
    print('\n✓ 完成' if not dry else '\n(dry-run,什么都没改)')



def push_review(cfg, dry=False):
    """写 Beta 审核信息(审核账号 + 联系人 + 审核备注)。

    ★凭据来自 .asc/review-account.json,**不进仓**。
      审核备注正文在 metadata/review-notes.txt(进仓,可评审),里面用 {{SERVER}} /
      {{PHONE}} / {{PASSWORD}} 占位,推送时才替换 —— 因为这个仓会镜像到 Gitee、
      也会在客户服务器上检出,而 git 历史是永久的:密码一旦提交,日后改了也抹不掉旧的。
      与 CI 里 APNs 私钥「只存在于 Actions secret,不入库」是同一条规矩。
    """
    acct_path = os.path.join(ASC_DIR, 'review-account.json')
    if not os.path.exists(acct_path):
        die(f'缺 {acct_path} —— 审核账号与联系人放这里(该目录已 gitignore)')
    with open(acct_path, encoding='utf-8') as f:
        acct = json.load(f)
    missing = [k for k in ('server', 'phone', 'password', 'contactFirstName',
                           'contactLastName', 'contactEmail', 'contactPhone') if not acct.get(k)]
    if missing:
        die(f'review-account.json 里这几项还是空的:{", ".join(missing)}')

    notes_path = os.path.join(ROOT, 'metadata', 'review-notes.txt')
    with open(notes_path, encoding='utf-8') as f:
        notes = f.read()
    notes = (notes.replace('{{SERVER}}', acct['server'])
                  .replace('{{PHONE}}', acct['phone'])
                  .replace('{{PASSWORD}}', acct['password']))
    if '{{' in notes:
        die('审核备注里还有没替换的占位符')

    app = find_app(cfg)
    if not app:
        die('找不到 App 记录')

    # ★外部测试还要一套**独立于商店文案**的 Beta 说明(betaAppLocalizations),
    #   缺了提交时回 422「Beta App Description is required」——而那时你已经把
    #   审核信息、账号、备注全填完了才发现。它自带 privacyPolicyUrl 与 feedbackEmail,
    #   与 App Info 里那份是两个字段,别以为填过一次就够。
    beta_desc = {
        'zh-Hans': _read('zh-Hans', 'description.txt'),
        'en-US': _read('en-US', 'description.txt'),
    }
    privacy = {'zh-Hans': PRIVACY_URL, 'en-US': PRIVACY_URL + '?lang=en'}
    have = {x['attributes']['locale']: x['id']
            for x in request(cfg, 'GET', f"/v1/apps/{app['id']}/betaAppLocalizations").get('data', [])}
    for loc, desc in beta_desc.items():
        if not desc:
            continue
        attrs = {'description': desc, 'feedbackEmail': acct['contactEmail'],
                 'privacyPolicyUrl': privacy[loc]}
        if dry:
            print(f'  betaApp {loc}: {"更新" if loc in have else "新建"} {list(attrs)}')
        elif loc in have:
            request(cfg, 'PATCH', f'/v1/betaAppLocalizations/{have[loc]}',
                    {'data': {'type': 'betaAppLocalizations', 'id': have[loc], 'attributes': attrs}})
            print(f'  betaApp {loc}: 已更新')
        else:
            request(cfg, 'POST', '/v1/betaAppLocalizations', {'data': {
                'type': 'betaAppLocalizations',
                'attributes': {**attrs, 'locale': loc},
                'relationships': {'app': {'data': {'type': 'apps', 'id': app['id']}}},
            }})
            print(f'  betaApp {loc}: 已新建')

    body = {'data': {'type': 'betaAppReviewDetails', 'id': app['id'], 'attributes': {
        'demoAccountName': acct['phone'],
        'demoAccountPassword': acct['password'],
        'demoAccountRequired': True,
        'notes': notes,
        'contactFirstName': acct['contactFirstName'],
        'contactLastName': acct['contactLastName'],
        'contactEmail': acct['contactEmail'],
        'contactPhone': acct['contactPhone'],
    }}}
    print(f'审核账号 {acct["phone"]} @ {acct["server"]} · 备注 {len(notes)} 字 · 联系人 {acct["contactEmail"]}')
    if dry:
        print('(dry-run,什么都没改)')
        return
    out = request(cfg, 'PATCH', f'/v1/betaAppReviewDetails/{app["id"]}', body)
    print('✓ 已写入 Beta 审核信息')
    return out


def main():
    argv = sys.argv[1:]
    cmd = argv[0] if argv else 'whoami'
    if cmd == 'selftest':      # 不需要真凭据
        selftest()
        return
    cfg = load_config()

    if cmd == 'whoami':
        data = request(cfg, 'GET', '/v1/apps?limit=50')
        apps = data.get('data', [])
        print(f'✓ 密钥可用。账号下有 {len(apps)} 个 App:')
        for a in apps:
            at = a['attributes']
            mark = ' ←本项目' if at.get('bundleId') == BUNDLE_ID else ''
            print(f"  {at.get('bundleId'):40s} {at.get('name')}{mark}")
        if not any(a['attributes'].get('bundleId') == BUNDLE_ID for a in apps):
            print(f'\n⚠ 还没有 {BUNDLE_ID} 的 App 记录 —— 首次上传前必须先建(见 §8)。')

    elif cmd == 'app':
        app = find_app(cfg)
        if not app:
            die(f'账号下没有 bundleId={BUNDLE_ID} 的 App 记录')
        print(json.dumps(app['attributes'], indent=2, ensure_ascii=False))
        print(f"id = {app['id']}")

    elif cmd == 'builds':
        app = find_app(cfg)
        if not app:
            die(f'账号下没有 bundleId={BUNDLE_ID} 的 App 记录')
        data = request(cfg, 'GET', f"/v1/builds?filter[app]={app['id']}&limit=10&sort=-uploadedDate")
        rows = data.get('data', [])
        if not rows:
            print('还没有任何构建。上传后 5–30 分钟才会出现(Apple 侧要处理)。')
        for b in rows:
            at = b['attributes']
            print(f"  build {at.get('version'):8s} {at.get('processingState'):12s} "
                  f"expired={at.get('expired')}  {at.get('uploadedDate')}")

    elif cmd == 'groups':
        app = find_app(cfg)
        if not app:
            die(f'账号下没有 bundleId={BUNDLE_ID} 的 App 记录')
        data = request(cfg, 'GET', f"/v1/betaGroups?filter[app]={app['id']}&limit=20")
        for g in data.get('data', []):
            at = g['attributes']
            kind = '内部' if at.get('isInternalGroup') else '外部'
            print(f"  [{kind}] {at.get('name')}  id={g['id']}")

    elif cmd == 'get':
        if len(argv) < 2:
            die('用法:asc.py get /v1/apps')
        print(json.dumps(request(cfg, 'GET', argv[1]), indent=2, ensure_ascii=False))

    elif cmd in ('post', 'patch'):
        # 通用写。★写操作真的会改你们的 App Store Connect —— 排查用 get,改东西尽量走
        #   下面那些具名命令(它们知道该改哪些字段、也会把改动打印出来)。
        if len(argv) < 3:
            die(f'用法:asc.py {cmd} /v1/xxx \'{{"data":...}}\'')
        out = request(cfg, cmd.upper(), argv[1], json.loads(argv[2]))
        print(json.dumps(out, indent=2, ensure_ascii=False))

    elif cmd == 'push-metadata':
        push_metadata(cfg, dry='--dry-run' in argv)

    elif cmd == 'push-review':
        push_review(cfg, dry='--dry-run' in argv)

    else:
        die(f'不认识的命令:{cmd}\n{__doc__}')


if __name__ == '__main__':
    main()
