// 纯计算:服务器域名归一化 + token 过期解析。
// ★与 mobile-app/shell/app.js 的 normalizeServer / tokenExpiresAt 是**同一套规则**,
//   改一边必须改另一边 —— 两个壳登录同一批服务器,判据不一致会出现「A 壳能登、B 壳说地址不对」。
// 放在 util 里而不是页面内:ArkTS 侧没有单测基建时,至少让这段能被人一眼读完、逐行比对。

export interface NormalizedServer {
  origin: string;
  error: string;
}

/**
 * 域名归一化:补 https、去路径、只留 origin。
 * 只收 https —— 明文 http 在 iOS 会被 ATS 拦、安卓要显式开 cleartext,鸿蒙同样要额外配置;
 * onprem 场景也已全量 https,不给自己留一个「某些客户是 http」的分叉。
 */
export function normalizeServer(input: string): NormalizedServer {
  const raw: string = (input ?? '').trim();
  if (raw.length === 0) {
    return { origin: '', error: '请输入服务器地址' };
  }
  const hasScheme: boolean = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const withScheme: string = hasScheme ? raw : `https://${raw}`;

  // ArkTS 没有 URL 构造器可用(@ohos.url 的 URL 行为与 Web 略有差异),这里手工拆:
  // scheme://host[:port][/path...] —— 只取到第一个 '/' 之前。
  const schemeEnd: number = withScheme.indexOf('://');
  const scheme: string = withScheme.substring(0, schemeEnd).toLowerCase();
  if (scheme !== 'https') {
    return { origin: '', error: '仅支持 https 服务器地址' };
  }
  const rest: string = withScheme.substring(schemeEnd + 3);
  const slash: number = rest.indexOf('/');
  const authority: string = slash === -1 ? rest : rest.substring(0, slash);
  if (authority.length === 0 || authority.indexOf('.') === -1) {
    return { origin: '', error: '服务器地址格式不对,示例:ai.example.com' };
  }
  // 用户名密码形式(user@host)一律拒绝:企业域名不会长这样,出现多半是粘错了
  if (authority.indexOf('@') !== -1 || authority.indexOf(' ') !== -1) {
    return { origin: '', error: '服务器地址格式不对,示例:ai.example.com' };
  }
  return { origin: `https://${authority.toLowerCase()}`, error: '' };
}

/**
 * token 是 base64url(payload).base64url(hmac),payload 含 exp(秒)。**不是 JWT**,
 * 但过期时间能本地解出来 —— 离线即可判死,省一次注定 401 的网络往返。
 * 解不出返回 -1(调用方按「无法判断,当作还活着」处理,让服务端去裁决)。
 */
export function tokenExpiresAtMs(token: string): number {
  try {
    const dot: number = token.indexOf('.');
    if (dot <= 0) {
      return -1;
    }
    const b64url: string = token.substring(0, dot);
    const json: string = base64UrlDecode(b64url);
    // 只取 exp 一个数字字段,不做完整 JSON 解析的类型体操
    const m: RegExpMatchArray | null = json.match(/"exp"\s*:\s*(\d+)/);
    if (m === null || m[1] === undefined) {
      return -1;
    }
    return parseInt(m[1], 10) * 1000;
  } catch (e) {
    return -1;
  }
}

/** 还有至少一分钟寿命才算活着:紧贴过期线进入,第一批请求就会 401,不如现在拦下。 */
export function tokenLooksAlive(token: string): boolean {
  const at: number = tokenExpiresAtMs(token);
  return at < 0 || at > Date.now() + 60000;
}

const B64_CHARS: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64url → UTF-8 字符串。自己实现:ArkTS 没有 atob,@ohos.util 的 Base64Helper 只吐字节数组。 */
function base64UrlDecode(input: string): string {
  let s: string = input.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) {
    s += '=';
  }
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const c0: number = B64_CHARS.indexOf(s.charAt(i));
    const c1: number = B64_CHARS.indexOf(s.charAt(i + 1));
    const c2: number = B64_CHARS.indexOf(s.charAt(i + 2));
    const c3: number = B64_CHARS.indexOf(s.charAt(i + 3));
    const n: number = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
    bytes.push((n >> 16) & 0xff);
    if (c2 >= 0) {
      bytes.push((n >> 8) & 0xff);
    }
    if (c3 >= 0) {
      bytes.push(n & 0xff);
    }
  }
  // payload 里只有 ASCII(uuid / 数字 / 短标识),直接按字节转即可
  let out: string = '';
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}
