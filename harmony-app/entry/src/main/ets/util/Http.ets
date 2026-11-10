// 原生 HTTP(@ohos.net.http)。壳的登录请求必须走这里,不能走 Web 组件里的 fetch。
//
// ★原因与 iOS/安卓壳一致:壳登录页跑在本地 origin,后端的 CORS allowlist 不含它,
//   webview 里 fetch 跨域必被拦。原生栈没有同源策略,所以登录这一跳只能在原生侧发。
import http from '@ohos.net.http';

export interface HttpResult {
  status: number;
  /** 响应体原文;调用方自己挑字段,不在这层做 JSON 类型体操 */
  body: string;
  /** 网络层失败(连不上/超时/证书问题)时为 true,status 无意义 */
  failed: boolean;
}

const TIMEOUT_MS: number = 15000;

export class Http {
  static async request(method: http.RequestMethod, url: string, token: string, bodyJson: string): Promise<HttpResult> {
    const req: http.HttpRequest = http.createHttp();
    try {
      const headers: Record<string, string> = {};
      if (token.length > 0) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      if (bodyJson.length > 0) {
        headers['Content-Type'] = 'application/json';
      }
      const opts: http.HttpRequestOptions = {
        method: method,
        header: headers,
        connectTimeout: TIMEOUT_MS,
        readTimeout: TIMEOUT_MS,
        expectDataType: http.HttpDataType.STRING,
      };
      if (bodyJson.length > 0) {
        opts.extraData = bodyJson;
      }
      const res: http.HttpResponse = await req.request(url, opts);
      const result: string = typeof res.result === 'string' ? res.result : '';
      return { status: res.responseCode, body: result, failed: false };
    } catch (e) {
      return { status: 0, body: '', failed: true };
    } finally {
      // ★必须 destroy:HttpRequest 持有原生句柄,不释放会在反复登录失败时泄漏连接
      req.destroy();
    }
  }

  /** 从错误响应体里取后端约定的 { error: { code, message } };取不到返回空串。 */
  static errorField(body: string, field: string): string {
    const m: RegExpMatchArray | null = body.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`));
    return m !== null && m[1] !== undefined ? m[1] : '';
  }

  /** 取顶层字符串字段(如 token)。壳只需要几个标量,不引入完整 JSON 反序列化。 */
  static stringField(body: string, field: string): string {
    const m: RegExpMatchArray | null = body.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`));
    return m !== null && m[1] !== undefined ? m[1] : '';
  }
}
