import { parse } from 'lossless-json';
import { AppError, Mutex, object, VERSION } from '../core.js';
import { API, Session } from '../auth/session.js';

export interface ApiResult {
  value: any;
  observedAt: string;
  serverTime?: string;
  source: string;
}
export interface ReadRequest {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  auth?: boolean;
}
export class ApiClient {
  private queue = new Mutex();
  private lastRequest = 0;
  last?: { ok: boolean; time: string; code?: string };
  constructor(
    public session: Session,
    private fetcher: typeof fetch = fetch,
    private base = API,
    private interval = 180,
  ) {}
  // Only business adapters call these methods. No route, URL or method is accepted from MCP/UI input.
  read(request: ReadRequest): Promise<ApiResult> {
    return this.send(request, false);
  }
  write(
    path: string,
    gate?: () => void,
    options: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<ApiResult> {
    return this.send({ path, method: options.method ?? 'POST', body: options.body, auth: true }, true, gate);
  }
  async uploadImage(
    path: 'cover' | 'avatar',
    hash: string,
    mime: 'image/jpeg' | 'image/png',
    bytes: Uint8Array,
    gate: () => void,
  ) {
    const epoch = this.session.epoch;
    const signature = object(
      (await this.write(`chara/oss/sign/${path}/${hash}/${encodeURIComponent(mime)}`, gate)).value,
    );
    for (const key of ['Key', 'Sign', 'Date'])
      if (typeof signature[key] !== 'string' || /[\r\n]/.test(signature[key]))
        throw new AppError('SCHEMA', '上传签名缺少必要字段。');
    const url = `https://tinygrail.oss-cn-hangzhou.aliyuncs.com/${path}/${hash}.${mime === 'image/jpeg' ? 'jpg' : 'png'}`;
    if (epoch !== this.session.epoch) throw new AppError('SESSION_CHANGED', '登录状态已变化。');
    gate();
    const response = await this.fetcher(url, {
      method: 'PUT',
      redirect: 'manual',
      signal: AbortSignal.timeout(18000),
      headers: {
        'Content-Type': mime,
        Authorization: `OSS ${signature.Key}:${signature.Sign}`,
        'x-oss-date': signature.Date,
      },
      body: Buffer.from(bytes),
    });
    if (!response.ok) throw new AppError('UPLOAD_FAILED', `图片上传 HTTP ${response.status}。`);
    return url;
  }
  private send(request: ReadRequest, write: boolean, gate?: () => void): Promise<ApiResult> {
    const epoch = this.session.epoch;
    return this.queue.run(async () => {
      if (epoch !== this.session.epoch) throw new AppError('SESSION_CHANGED', '登录状态已变更，请重新查询。');
      const cookie = await this.session.cookie();
      if (request.auth && !cookie) throw new AppError('LOGIN_REQUIRED', '请在本地管理界面登录 TinyGrail。');
      if (!/^[a-zA-Z0-9_/?=&%.,:!~*'()+-]+$/.test(request.path) || request.path.split('?')[0]!.includes('..'))
        throw new AppError('INVALID_ROUTE', '非法内部 API 路径。');
      const wait = Math.max(0, this.lastRequest + this.interval - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (epoch !== this.session.epoch) throw new AppError('SESSION_CHANGED', '登录状态已变更。');
      try {
        gate?.();
      } catch (e) {
        throw new AppError('NOT_DISPATCHED', '写请求发送前安全检查未通过，未发送请求。');
      }
      this.lastRequest = Date.now();
      try {
        const response = await this.fetcher(new URL(request.path, this.base), {
          method: request.method ?? 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(18000),
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': `TinyGrailMCP/${VERSION}`,
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        });
        if (epoch !== this.session.epoch) throw new AppError('SESSION_CHANGED', '已丢弃旧账号的响应。');
        await this.session.absorb(response.headers.getSetCookie(), epoch);
        if (response.status === 403) throw new AppError('API_PERMISSION', 'TinyGrail 拒绝访问此接口。');
        if (
          response.status === 401 ||
          ([301, 302, 303, 307, 308].includes(response.status) && request.auth)
        ) {
          if (request.auth) this.session.expire();
          throw new AppError('AUTH_EXPIRED', '登录已失效，请重新登录。');
        }
        if (response.status === 429)
          throw new AppError('RATE_LIMIT', 'TinyGrail 请求受限，请稍后重试只读查询。', {
            retryAfterSeconds: /^\d+$/.test(response.headers.get('retry-after') ?? '')
              ? Number(response.headers.get('retry-after'))
              : null,
          });
        if (!response.ok)
          throw new AppError('HTTP', `TinyGrail HTTP ${response.status}。`, { status: response.status });
        // Magrail consumes logout as a dynamic HTTP response; verify the session afterward.
        if (write && request.path === 'account/logout') {
          await response.body?.cancel();
          this.last = { ok: true, time: new Date().toISOString() };
          return {
            value: { logoutAcknowledged: true },
            observedAt: this.last.time,
            serverTime: response.headers.get('date') ?? undefined,
            source: 'TinyGrail API POST account/logout',
          };
        }
        if (Number(response.headers.get('content-length') ?? 0) > 4 * 1024 * 1024)
          throw new AppError('RESPONSE_LIMIT', '响应过大，请缩小查询范围。');
        const reader = response.body?.getReader();
        let text = '';
        let bytes = 0;
        if (!reader) throw new AppError('SCHEMA', '服务器返回空响应。');
        const decoder = new TextDecoder();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new AppError('RESPONSE_LIMIT', '响应超过 4MB，请缩小范围。');
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        let envelope: Record<string, any>;
        // Preserve every numeric literal exactly. Domain quantities and money are decimal strings.
        try {
          envelope = object(parse(text, undefined, (value) => value));
        } catch {
          throw new AppError('SCHEMA', 'TinyGrail 未返回合法 JSON 对象。');
        }
        if (!Object.hasOwn(envelope, 'State') || !Number.isInteger(Number(envelope.State)))
          throw new AppError('SCHEMA', 'TinyGrail 响应缺少业务状态。');
        if (Number(envelope.State) !== 0) {
          if (
            typeof envelope.Message === 'string' &&
            /没有权限|无权限|permission denied/i.test(envelope.Message)
          )
            throw new AppError('API_PERMISSION', '当前账号没有此接口权限。', {
              state: Number(envelope.State),
            });
          if (
            typeof envelope.Message === 'string' &&
            /用户登[录陆陸]|请先(?:登录|授[权權])|未登录|未授权|登录.*(?:失效|异常|过期)/.test(
              envelope.Message,
            )
          ) {
            if (request.auth) this.session.expire();
            throw new AppError('AUTH_EXPIRED', '此接口需要有效 TinyGrail 登录，请在本地重新授权。');
          }
          if (request.path === 'chara/user/assets' && request.auth) {
            this.session.expire();
            throw new AppError('AUTH_EXPIRED', '无法读取当前账号资产；请重新授权或确认账号已开通小圣杯。');
          }
          throw new AppError('API_REJECTED', 'TinyGrail 拒绝了此请求。', { state: Number(envelope.State) });
        }
        if (!Object.hasOwn(envelope, 'Value')) throw new AppError('SCHEMA', '业务成功响应缺少 Value。');
        this.last = { ok: true, time: new Date().toISOString() };
        return {
          value: envelope.Value,
          observedAt: this.last.time,
          serverTime: response.headers.get('date') ?? undefined,
          source: `TinyGrail API ${request.method ?? 'GET'} ${request.path}`,
        };
      } catch (e) {
        const error =
          e instanceof AppError
            ? e
            : new AppError(
                write ? 'OUTCOME_UNKNOWN' : 'NETWORK',
                write ? '写请求可能已执行；禁止重试，请在本地对账。' : 'TinyGrail 网络请求失败或超时。',
              );
        this.last = { ok: false, time: new Date().toISOString(), code: error.code };
        throw error;
      }
    });
  }
}
