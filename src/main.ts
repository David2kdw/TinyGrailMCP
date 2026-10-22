import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, open, rm, appendFile, stat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as z from 'zod/v4';
import {
  AppError,
  DATA,
  ROOT,
  VERSION,
  Mutex,
  atomicJson,
  log,
  protectDirectory,
  publicError,
  randomToken,
} from './core.js';
import { Vault } from './auth/vault.js';
import { Session } from './auth/session.js';
import { ApiClient } from './api/client.js';
import { Queries } from './services/queries.js';
import { Safety, actionLabels } from './safety/engine.js';
import { buildTools, invoke } from './tools.js';
import { Tunnel } from './tunnel.js';
import type { Runtime } from './bridge.js';

const equal = (a: string | undefined, b: string) =>
  typeof a === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
type ManagerOptions = { dir?: string; port?: number; queries?: Queries; vault?: Vault };
export async function createManager(options: ManagerOptions = {}) {
  const dir = options.dir ?? DATA;
  await protectDirectory(dir);
  const lockPath = join(dir, 'manager.lock');
  try {
    const old: any = JSON.parse(await readFile(lockPath, 'utf8'));
    try {
      process.kill(old.pid, 0);
      throw new AppError('ALREADY_RUNNING', '本地管理器已运行；请重新打开界面。');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      await rm(lockPath);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  await lock.sync();
  const release = async () => {
    await lock.close();
    await rm(lockPath, { force: true });
  };
  try {
    return await createManagerInternal(options, release);
  } catch (e) {
    await release();
    throw e;
  }
}
async function createManagerInternal(options: ManagerOptions, release: () => Promise<void>) {
  const dir = options.dir ?? DATA;
  await protectDirectory(dir);
  const vault = options.vault ?? new Vault(dir),
    session = options.queries?.api.session ?? new Session(vault);
  const q = options.queries ?? new Queries(new ApiClient(session));
  const events: { time: string; layer: string; event: string; code?: string }[] = [];
  const logDisk = new Mutex();
  const logFile = join(dir, 'events.ndjson');
  const record = (layer: string, event: string, code?: string) => {
    const entry = { time: new Date().toISOString(), layer, event, code };
    events.push(entry);
    if (events.length > 200) events.shift();
    log(event, code);
    void logDisk
      .run(async () => {
        const bytes = await stat(logFile)
          .then((s) => s.size)
          .catch(() => 0);
        if (bytes > 2000000) await rename(logFile, logFile + '.previous');
        await appendFile(logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
      })
      .catch(() => {});
  };
  let vaultError: unknown;
  try {
    await session.restore();
  } catch (e) {
    vaultError = publicError(e);
    record('auth', '凭据恢复失败', 'VAULT');
  }
  const safety = new Safety(q, dir);
  await safety.init();
  const tunnel = new Tunnel(vault, record, dir);
  await tunnel.restore().catch((e) => {
    vaultError = publicError(e);
  });
  let lastMcp: unknown,
    shuttingDown = false;
  const mcpChildren = new Map<number, string>();
  const status = async () => ({
    application: 'TinyGrailMCP',
    version: VERSION,
    manager: { running: true, platform: process.platform },
    session: session.status(),
    api: q.api.last ?? { ok: null },
    mcp: {
      lastEvent: lastMcp,
      childStarts: mcpChildren.size,
      registeredToolCount: tools.length,
    },
    tunnel: await tunnel.status(),
    safety: safety.status(),
    vaultError,
  });
  const tools = buildTools(q, safety, status);
  const runtime: Runtime = {
    origin: '',
    instance: randomUUID(),
    pid: process.pid,
    bootstrap: randomToken(),
    internal: randomToken(),
    control: randomToken(),
  };
  const browserSessions = new Map<string, { csrf: string; expires: number }>();
  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (!res.headersSent)
        respond(
          res,
          e instanceof AppError && ['LOCAL_ONLY', 'UNAUTHORIZED', 'CSRF'].includes(e.code) ? 403 : 400,
          { error: publicError(e) },
        );
      else res.end();
    });
  });
  server.requestTimeout = 200000;
  server.headersTimeout = 10000;
  server.maxConnections = 40;
  const pendingResponse = (res: ServerResponse) => {
    res.setTimeout(0);
  };
  function respond(res: ServerResponse, code: number, data: unknown) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  async function body(req: IncomingMessage, limit = 32768): Promise<any> {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json')
      throw new AppError('CSRF', '只接受 JSON 请求。');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > limit) throw new AppError('BODY_LIMIT', '请求内容过大。');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new AppError('INVALID_INPUT', '请求 JSON 无效。');
    }
  }
  function sameOrigin(req: IncomingMessage) {
    if (
      req.headers.origin !== runtime.origin ||
      (req.headers['sec-fetch-site'] &&
        !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))
    )
      throw new AppError('CSRF', '请求不是来自本地管理界面。');
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const expectedHost = new URL(runtime.origin).host;
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== expectedHost)
      throw new AppError('LOCAL_ONLY', '仅允许本机环回地址与正确 Host。');
    const path = new URL(req.url ?? '/', runtime.origin).pathname;
    if (path === '/health' && req.method === 'GET')
      return respond(res, 200, { application: 'TinyGrailMCP', instance: runtime.instance });
    if (['/', '/app.js', '/style.css'].includes(path) && req.method === 'GET') {
      const file = path === '/' ? 'index.html' : path.slice(1);
      res.writeHead(200, {
        'Content-Type': file.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : file.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(await readFile(join(ROOT, 'src/ui', file)));
    }
    if (path === '/control/stop' && req.method === 'POST') {
      if (req.headers.origin || !equal(req.headers.authorization, `Bearer ${runtime.control}`))
        throw new AppError('UNAUTHORIZED', '无本地控制权限。');
      if (safety.executing) throw new AppError('BUSY', '正在处理交易，请等待回执后关闭。');
      await safety.stop();
      respond(res, 200, { stopping: true });
      setTimeout(() => {
        void close().catch(() => {});
      }, 50);
      return;
    }
    if (path.startsWith('/internal/') && req.method === 'POST') {
      if (req.headers.origin || !equal(req.headers.authorization, `Bearer ${runtime.internal}`))
        throw new AppError('UNAUTHORIZED', '无 MCP 内部权限。');
      const b = await body(req, 1500000);
      if (path === '/internal/event') {
        if (b.event !== 'stdio_started' || !Number.isInteger(b.pid))
          throw new AppError('INVALID_INPUT', '无效事件。');
        mcpChildren.set(b.pid, new Date().toISOString());
        lastMcp = { event: b.event, time: new Date().toISOString() };
        return respond(res, 200, { ok: true });
      }
      if (path !== '/internal/tool' || typeof b.name !== 'string')
        throw new AppError('TOOL_NOT_FOUND', '不支持此内部路径。');
      lastMcp = {
        event: 'tool_call',
        tool: tools.find((t) => t.name === b.name)?.name ?? 'unknown',
        time: new Date().toISOString(),
      };
      const value = await invoke(tools, b.name, b.args);
      if (b.transport === 'tunnel' && !['get_server_status', 'get_session_status'].includes(b.name))
        tunnel.observeForwardedTool(b.name);
      return respond(res, 200, value);
    }
    if (path === '/session' && req.method === 'POST') {
      sameOrigin(req);
      const b = await body(req);
      if (!equal(b.token, runtime.bootstrap))
        throw new AppError('UNAUTHORIZED', '请用 scripts/Start.ps1 打开管理界面。');
      if (browserSessions.size > 50) browserSessions.clear();
      const token = randomToken();
      browserSessions.set(token, { csrf: randomToken(), expires: Date.now() + 8 * 3600000 });
      res.setHeader('Set-Cookie', `tg_manager=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
      return respond(res, 200, { ok: true });
    }
    const cookie = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('tg_manager='))
      ?.slice(11);
    const browser = cookie ? browserSessions.get(cookie) : undefined;
    if (!browser || browser.expires < Date.now())
      throw new AppError('UNAUTHORIZED', '管理会话已失效，请重新运行 Start.ps1 打开。');
    if (
      (req.headers.origin && req.headers.origin !== runtime.origin) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    )
      throw new AppError('CSRF', '禁止跨站访问。');
    if (path === '/api/state' && req.method === 'GET')
      return respond(res, 200, {
        csrf: browser.csrf,
        status: await status(),
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          prepare: !!t.prepare,
          schema: z.toJSONSchema(t.schema),
        })),
        plans: safety.list(),
        events,
        actions: actionLabels,
      });
    if (path.startsWith('/api/plan-image/') && req.method === 'GET') {
      const image = await safety.previewImage(z.string().uuid().parse(path.slice('/api/plan-image/'.length)));
      res.writeHead(200, {
        'Content-Type': image.mime,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(image.bytes);
      return;
    }
    if (req.method !== 'POST')
      return respond(res, 404, { error: { code: 'NOT_FOUND', message: '未找到此页面。' } });
    sameOrigin(req);
    if (!equal(req.headers['x-csrf-token'] as string, browser.csrf))
      throw new AppError('CSRF', '本地确认凭证无效。');
    const b = await body(req);
    pendingResponse(res);
    if (path === '/api/query') {
      const t = tools.find((t) => t.name === b.name);
      if (!t || t.prepare) throw new AppError('TOOL_NOT_FOUND', '本地查询面板只接受只读工具。');
      return respond(res, 200, await invoke(tools, b.name, b.args));
    }
    if (path === '/api/policy') return respond(res, 200, await safety.policy(b));
    if (path === '/api/approve') {
      const p = z
        .object({ planId: z.string().uuid(), fingerprint: z.string().length(64) })
        .strict()
        .parse(b);
      return respond(res, 200, await safety.approve(p.planId, p.fingerprint));
    }
    if (path === '/api/reject')
      return respond(res, 200, await safety.reject(z.string().uuid().parse(b.planId)));
    if (path === '/api/reconcile')
      return respond(
        res,
        200,
        await safety.acknowledgeUnknown(
          z.string().uuid().parse(b.planId),
          z.string().min(12).max(1000).parse(b.note),
        ),
      );
    if (path === '/api/tunnel-config') {
      const config = z
        .object({ tunnelId: z.string().max(80), apiKey: z.string().max(1000) })
        .strict()
        .parse(b);
      return respond(res, 200, await tunnel.configure(config));
    }
    if (path !== '/api/action') throw new AppError('NOT_FOUND', '未找到此动作。');
    switch (b.action) {
      case 'login':
        await safety.mutex.run(async () => {
          await safety.stop();
          session.beginLogin(async () => (await q.account()).value);
        });
        record('auth', '已打开用户登录流程');
        return respond(res, 200, { started: true });
      case 'logout':
        await safety.mutex.run(async () => {
          await safety.stop();
          await session.logout();
        });
        record('auth', '本地会话已清除');
        return respond(res, 200, session.status());
      case 'session-check':
        return respond(res, 200, await q.sessionStatus());
      case 'emergency-stop':
        record('safety', '用户触发紧急停止');
        return respond(res, 200, await safety.stop());
      case 'tunnel-start':
        await tunnel.start();
        return respond(res, 200, await tunnel.status());
      case 'tunnel-stop':
        await tunnel.stop();
        return respond(res, 200, await tunnel.status());
      case 'tunnel-restart':
        await tunnel.stop();
        await tunnel.start();
        return respond(res, 200, await tunnel.status());
      case 'tunnel-doctor':
        return respond(res, 200, await tunnel.doctor());
      case 'confirm-chatgpt':
        return respond(res, 200, await tunnel.confirmChatgpt());
      case 'shutdown':
        if (safety.executing) throw new AppError('BUSY', '正在处理交易，请等待回执。');
        await safety.stop();
        respond(res, 200, { stopping: true });
        setTimeout(() => {
          void close().catch(() => {});
        }, 50);
        return;
      case 'mcp-probe': {
        const { Client } = await import('@modelcontextprotocol/client');
        const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
        const c = new Client({ name: 'tinygrail-local-doctor', version: VERSION });
        try {
          await c.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [join(ROOT, 'dist/index.js')],
              env: { ...(process.env as Record<string, string>), TG_DATA_DIR: dir },
              stderr: 'pipe',
            }),
          );
          const list = await c.listTools();
          const ping = await c.callTool({ name: 'ping', arguments: {} });
          return respond(res, 200, {
            ok: !ping.isError,
            tools: list.tools.map((t) => t.name),
            transport: 'local_stdio',
          });
        } finally {
          await c.close();
        }
      }
      default:
        throw new AppError('INVALID_INPUT', '未知管理动作。');
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? Number(process.env.TG_PORT ?? 17651), '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen');
  runtime.origin = `http://127.0.0.1:${address.port}`;
  await atomicJson(join(dir, 'runtime.json'), runtime);
  record('manager', '本地管理器已启动');
  if ((await tunnel.status()).configured)
    void tunnel
      .start()
      .catch((e) =>
        record(
          'tunnel',
          '自动恢复未完成，请查看诊断或先停止遗留实例',
          e instanceof AppError ? e.code : 'START',
        ),
      );
  if (await session.cookie()) void q.sessionStatus().catch(() => {});
  async function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await safety.stop();
      await tunnel.stop();
      await session.closeBrowser();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      await rm(join(dir, 'runtime.json'), { force: true });
      await logDisk.run(async () => {});
      await release();
    } catch (e) {
      shuttingDown = false;
      record('manager', '关闭未完成，请检查组件状态', e instanceof AppError ? e.code : 'STOP');
      throw e;
    }
  }
  return { server, runtime, close, q, safety, tunnel, status, tools };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manager = await createManager().catch((e) => {
    log('manager_start_failed', e instanceof AppError ? e.code : (e as NodeJS.ErrnoException).code);
    process.exit(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void manager.close().then(
        () => process.exit(0),
        () => {
          process.exitCode = 1;
        },
      );
    });
}
