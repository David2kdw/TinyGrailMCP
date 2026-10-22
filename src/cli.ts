import { join } from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { ApiClient, type ReadRequest } from './api/client.js';
import { Session } from './auth/session.js';
import { Vault } from './auth/vault.js';
import { AppError, DATA, ROOT, atomicJson, publicError, readJson, runFile, VERSION } from './core.js';
import { bridge, type Runtime } from './bridge.js';
import { safeData } from './models.js';
import { buildTools } from './tools.js';
import { Queries } from './services/queries.js';
import { Safety } from './safety/engine.js';
import * as z from 'zod/v4';

// These checks use an anonymous session; auction and character search require authentication.
export const publicChecks: ReadRequest[] = [
  { path: 'chara/1' },
  { path: 'chara/depth/1' },
  { path: 'chara/temple/1' },
  { path: 'chara/links/1' },
  { path: 'chara/users/1/1/3' },
  { path: 'chara/charts/1/2026-10-01' },
  { path: 'chara/mri/1/3' },
  { path: 'chara/pool/1' },
  { path: 'chara/user/1/tinygrail/false' },
  { path: 'chara/user/chara/tinygrail/1/3', method: 'POST' },
  { path: 'chara/user/chara/blueleaf/1/3', method: 'POST' },
  { path: 'chara/babel/1/3' },
  { path: 'chara/msrc/1/3' },
  { path: 'chara/mvc/1/3' },
  { path: 'chara/mrc/1/3' },
  { path: 'chara/mfc/1/3' },
];
async function main() {
  const command = process.argv[2] ?? 'doctor';
  if (command === 'export-tools') {
    await mkdir(join(ROOT, 'doc'), { recursive: true });
    const q = new Queries(new ApiClient(new Session(new Vault())));
    await atomicJson(join(ROOT, 'doc/mcp-tools.json'), {
      version: VERSION,
      tools: buildTools(q, new Safety(q), async () => ({})).map((t) => ({
        name: t.name,
        description: t.description,
        preparesLocalPlan: !!t.prepare,
        inputSchema: z.toJSONSchema(t.schema),
      })),
    });
    process.stdout.write('Exported tool schemas without reading credentials.\n');
    return;
  }
  if (command === 'verify-public') {
    await mkdir(join(ROOT, 'doc'), { recursive: true });
    const api = new ApiClient(new Session(new Vault()));
    const records = [];
    for (const request of publicChecks) {
      try {
        const r = await api.read(request),
          value = safeData(r.value),
          sample = Array.isArray(value) ? value[0] : (value?.Items?.[0] ?? value);
        const entry = {
          method: request.method ?? 'GET',
          path: request.path,
          ok: true,
          observedAt: r.observedAt,
          shape: Array.isArray(value) ? 'array' : typeof value,
          itemKeys: sample && typeof sample === 'object' ? Object.keys(sample) : [],
          returned: Array.isArray(value) ? value.length : value?.Items?.length,
        };
        records.push(entry);
        process.stdout.write(JSON.stringify(entry) + '\n');
      } catch (e) {
        const entry = {
          method: request.method ?? 'GET',
          path: request.path,
          ok: false,
          observedAt: new Date().toISOString(),
          error: publicError(e),
        };
        records.push(entry);
        process.stdout.write(JSON.stringify(entry) + '\n');
      }
    }
    await atomicJson(join(ROOT, 'doc/public-api-validation.json'), {
      date: new Date().toISOString(),
      authenticated: false,
      realAssetWrites: 0,
      records,
    });
    if (records.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  if (command === 'verify-account') {
    const checks = [
      'get_account_overview',
      'list_holdings',
      'list_temples',
      'list_my_icos',
      'list_my_auctions',
      'list_items',
      'list_links',
      'list_balance_history',
      'list_orders',
    ];
    const records = [];
    for (const name of checks) {
      try {
        const result = await bridge('/internal/tool', {
          name,
          args:
            name === 'get_account_overview'
              ? {}
              : { page: 1, pageSize: 3, ...(name === 'list_orders' ? { side: 'buy' } : {}) },
        });
        records.push({
          name,
          ok: true,
          observedAt: result.observedAt,
          pagination: result.data?.pagination,
          keys: Object.keys(result.data ?? {}),
        });
      } catch (e) {
        records.push({ name, ok: false, error: publicError(e) });
      }
    }
    await atomicJson(join(DATA, 'account-validation.json'), {
      observedAt: new Date().toISOString(),
      realAssetWrites: 0,
      records,
    });
    process.stdout.write(
      JSON.stringify(
        { report: '已保存到私有数据目录 account-validation.json，未记录账号标识或资产金额。', records },
        null,
        2,
      ) + '\n',
    );
    if (records.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  if (command === 'stop') {
    const runtime = await readJson<Runtime | null>(runFile, null);
    if (!runtime) {
      process.stdout.write('管理器未运行。\n');
      return;
    }
    const health = await fetch(new URL('/health', runtime.origin), {
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);
    if (!health) {
      process.stdout.write('管理器已离线。\n');
      return;
    }
    const h: any = await health.json();
    if (h.instance !== runtime.instance) throw new AppError('INSTANCE', '管理器实例不匹配，未发送关闭请求。');
    const res = await fetch(new URL('/control/stop', runtime.origin), {
      method: 'POST',
      headers: { Authorization: `Bearer ${runtime.control}` },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new AppError('STOP', '关闭请求被拒绝，请在界面查看是否有执行中的交易。');
    for (let n = 0; n < 100; n++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        await access(runFile);
      } catch {
        process.stdout.write('管理器与其 Tunnel 子进程已停止。\n');
        return;
      }
    }
    throw new AppError('STOP_TIMEOUT', '关闭尚未完成，禁止直接启动替代 Tunnel。');
  }
  if (command === 'doctor') {
    const data: Record<string, unknown> = {
      application: 'TinyGrailMCP',
      version: VERSION,
      node: process.version,
      platform: process.platform,
    };
    try {
      await access(join(ROOT, 'tools/tunnel-client.exe'));
      data.officialTunnelInstalled = true;
    } catch {
      data.officialTunnelInstalled = false;
    }
    try {
      data.manager = await bridge('/internal/tool', { name: 'get_server_status', args: {} });
    } catch (e) {
      data.manager = publicError(e);
    }
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  throw new AppError('CLI', '命令：doctor | stop | verify-public | verify-account');
}
await main().catch((e) => {
  process.stderr.write(JSON.stringify({ error: publicError(e) }) + '\n');
  process.exitCode = 1;
});
