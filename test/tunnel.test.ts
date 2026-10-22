import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createManager } from '../src/main.js';
import { atomicJson, ROOT } from '../src/core.js';
import { TunnelLease } from '../src/instance.js';
import { fixture } from './helpers.js';
import { mcpDetails } from '../src/tunnel.js';

test('discovery distinguishes unobserved, partial and successful empty catalogues', () => {
  assert.deepEqual(mcpDetails({ tools_list: { ok: false, complete: false, tool_names: [] } }).discovery, {
    state: 'not_observed',
  });
  assert.deepEqual(mcpDetails({ tools_list: { ok: true, complete: true, tool_names: [] } }).discovery, {
    state: 'complete',
    observedAt: undefined,
    toolNames: [],
  });
  assert.equal(
    mcpDetails({ tools_list: { ok: true, complete: false, partial: true, tool_names: ['ping'] } }).discovery
      .state,
    'partial',
  );
});

test('same Tunnel ID has a cross-data-directory exclusive lease', async () => {
  const f = await fixture(),
    id = 'tunnel_00000000000000000000000000000001',
    a = new TunnelLease(id, f.dir),
    b = new TunnelLease(id, f.dir + '-other');
  await a.acquire();
  try {
    await assert.rejects(b.acquire(), { code: 'TUNNEL_ALREADY_RUNNING' });
  } finally {
    await a.release();
  }
  await b.acquire();
  await b.release();
});
test(
  'installed official Windows tunnel binary forwards initialize, discovery and tools over stdio and can restart without overlap',
  {
    skip: process.platform !== 'win32' || !existsSync(join(ROOT, 'tools/tunnel-client.exe')),
    timeout: 60000,
  },
  async () => {
    const f = await fixture(),
      manager = await createManager({ dir: f.dir, port: 0, queries: f.q, vault: f.vault });
    const pending: any[] = [],
      responses = new Map<string, (v: any) => void>(),
      wire: any[] = [];
    let count = 0,
      child: ChildProcess | undefined;
    const control = createServer((req, res) => {
      void (async () => {
        if (req.url?.includes('/poll')) {
          await new Promise((r) => setTimeout(r, 80));
          if (res.destroyed) return;
          if (pending.length) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ commands: [pending.shift()] }));
          } else {
            res.writeHead(204);
            res.end();
          }
          return;
        }
        if (req.url?.includes('/response')) {
          let text = '';
          for await (const b of req) text += b;
          const value = JSON.parse(text);
          wire.push(value);
          for (const item of value.responses ?? [value]) {
            responses.get(item.request_id)?.(item);
            responses.delete(item.request_id);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ id: 'tunnel_00000000000000000000000000000002', name: 'Local fixture only' }),
        );
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
    const address = control.address() as any;
    const profile = join(f.dir, 'official-tunnel-test.yaml');
    await atomicJson(profile, {
      config_version: 1,
      control_plane: {
        base_url: `http://127.0.0.1:${address.port}`,
        tunnel_id: 'tunnel_00000000000000000000000000000002',
        api_key: 'env:CONTROL_PLANE_API_KEY',
      },
      health: { listen_addr: '127.0.0.1:0', url_file: join(f.dir, 'test-health.url') },
      log: { level: 'warn', format: 'json' },
      mcp: {
        stdio_send_initialized_notification: true,
        commands: [
          {
            channel: 'main',
            command: `"${process.execPath.replaceAll('\\', '/')}" "${join(ROOT, 'dist/index.js').replaceAll('\\', '/')}"`,
          },
        ],
      },
    });
    function send(method: string, params: any = {}, notification = false) {
      const id = ++count;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          responses.delete('fixture-' + id);
          reject(
            new Error(
              'official tunnel response timeout: ' +
                method +
                '; responses=' +
                wire.map((v) => v.request_id).join(','),
            ),
          );
        }, 15000);
        responses.set('fixture-' + id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        pending.push({
          request_id: 'fixture-' + id,
          shard_token: 'local-only-fixture',
          command_type: 'jsonrpc',
          channel: 'main',
          created_at: new Date().toISOString(),
          jsonrpc: { jsonrpc: '2.0', ...(!notification ? { id } : {}), method, params },
        });
      });
    }
    async function start() {
      child = spawn(join(ROOT, 'tools/tunnel-client.exe'), ['run', '--profile-file', profile], {
        cwd: ROOT,
        windowsHide: true,
        env: { ...process.env, TG_DATA_DIR: f.dir, CONTROL_PLANE_API_KEY: 'SYNTHETIC_LOCAL_FIXTURE_ONLY' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.resume();
      child.stderr?.resume();
    }
    async function stop() {
      if (!child || child.exitCode !== null) return;
      const p = child;
      const ended = new Promise<void>((r) => p.once('close', () => r()));
      await promisify(execFile)('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], {
        windowsHide: true,
      }).catch(() => {});
      await ended;
      child = undefined;
      await new Promise((r) => setTimeout(r, 120));
    }
    async function discovery() {
      const address = await readFile(join(f.dir, 'test-health.url'), 'utf8');
      const h: any = await (await fetch(new URL('/health?details=true', address.trim()))).json();
      return mcpDetails(h.components.mcp.details).discovery;
    }
    try {
      for (let run = 0; run < 2; run++) {
        await start();
        const before = f.reads.length;
        const early = await send('tools/call', { name: 'get_account_overview', arguments: {} });
        assert.equal(early.resp_code, 409);
        assert.equal(early.resp_json?.error?.data?.error_type, 'mcp_initialization_required');
        assert.equal(f.reads.length, before);
        assert.equal((await discovery()).state, 'not_observed');
        const init = await send('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'fixture-tunnel-host', version: '1' },
        });
        assert.equal(init.resp_code, 200);
        assert.equal(init.resp_json?.result?.serverInfo?.name, 'TinyGrailMCP');
        // Caller deliberately omits initialized initially. Official shim must precede both concurrent calls.
        const [list, tool] = await Promise.all([
          send('tools/list'),
          send('tools/call', { name: 'get_account_overview', arguments: {} }),
        ]);
        assert.ok(list.resp_json?.result?.tools?.length >= 40);
        assert.ok(
          !list.resp_json.result.tools.some((t: any) =>
            ['get_character_history', 'list_trade_history'].includes(t.name),
          ),
        );
        assert.equal(tool.resp_json?.result?.structuredContent?.data?.Balance, '1000000.123456');
        const observed = await discovery();
        assert.equal(observed.state, 'complete');
        assert.equal(observed.toolNames?.length, manager.tools.length);
        f.flags.permissionDenied = true;
        for (const [name, args] of [['get_my_character_trading', { characterId: 1 }]] as const) {
          const denied = await send('tools/call', { name, arguments: args });
          assert.equal(denied.resp_code, 200);
          assert.equal(denied.resp_json?.result?.structuredContent?.status, 'error');
          assert.equal(denied.resp_json?.result?.structuredContent?.error?.code, 'API_PERMISSION');
          assert.equal(denied.resp_json?.result?.isError, undefined);
        }
        await send('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'fixture-tunnel-host', version: '1' },
        });
        assert.equal((await discovery()).state, 'not_observed');
        const [relisted, recalled] = await Promise.all([
          send('tools/list'),
          send('tools/call', { name: 'get_account_overview', arguments: {} }),
        ]);
        assert.equal(relisted.resp_json?.result?.tools?.length, manager.tools.length);
        assert.equal(recalled.resp_json?.result?.structuredContent?.data?.Balance, '1000000.123456');
        await send('notifications/initialized', {}, true);
        assert.equal(f.writes.length, 0);
        await stop();
      }
    } finally {
      await stop();
      control.closeAllConnections();
      await new Promise<void>((r) => control.close(() => r()));
      await manager.close();
    }
  },
);
