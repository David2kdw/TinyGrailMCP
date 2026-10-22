import { AppError, Mutex, VERSION } from '../core.js';
import type { ApiResult } from './client.js';

// Public Bangumi requests have no access to the TinyGrail session or cookie jar.
export class BangumiClient {
  private queue = new Mutex();
  private lastRequest = 0;
  constructor(
    private fetcher: typeof fetch = fetch,
    private interval = 250,
  ) {}

  request(service: 'v0' | 'p1', path: string, body?: unknown): Promise<ApiResult> {
    const base = service === 'v0' ? 'https://api.bgm.tv/v0/' : 'https://next.bgm.tv/p1/';
    if (!/^[a-zA-Z][a-zA-Z0-9_/?=&%-]*$/.test(path) || path.includes('..'))
      throw new AppError('INVALID_ROUTE', '非法 Bangumi API 路径。');
    return this.queue.run(async () => {
      const wait = Math.max(0, this.lastRequest + this.interval - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      this.lastRequest = Date.now();
      try {
        const response = await this.fetcher(new URL(path, base), {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'omit',
          redirect: 'manual',
          signal: AbortSignal.timeout(18000),
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': `TinyGrailMCP/${VERSION} (Windows local MCP; Bangumi discovery)`,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new AppError(
            response.status === 429 ? 'BANGUMI_RATE_LIMIT' : 'BANGUMI_HTTP',
            `Bangumi HTTP ${response.status}。`,
            { status: response.status, service },
          );
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (!reader) throw new AppError('BANGUMI_SCHEMA', 'Bangumi 返回空响应。');
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new AppError('BANGUMI_RESPONSE_LIMIT', 'Bangumi 响应超过 4MB，请缩小查询范围。');
          }
          chunks.push(part.value);
        }
        let value: unknown;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new AppError('BANGUMI_SCHEMA', 'Bangumi 未返回合法 JSON。');
        }
        return {
          value,
          observedAt: new Date().toISOString(),
          serverTime: response.headers.get('date') ?? undefined,
          source: `Bangumi ${service} ${body === undefined ? 'GET' : 'POST'} ${path}`,
        };
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError('BANGUMI_NETWORK', 'Bangumi 网络请求失败或超时。');
      }
    });
  }
}
