import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createManager } from '../src/main.js';
import { Session } from '../src/auth/session.js';
import { Vault } from '../src/auth/vault.js';
import { ROOT, protectDirectory } from '../src/core.js';
import { fixture } from './helpers.js';

test('real SDK stdio initialize/discover/call traverses manager and returns structured server data', async () => {
  const f = await fixture(),
    manager = await createManager({ dir: f.dir, port: 0, queries: f.q, vault: f.vault });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist/index.js')],
    env: { ...(process.env as Record<string, string>), TG_DATA_DIR: f.dir },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'tinygrail-integration', version: '1' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, manager.tools.length);
    assert.ok(!tools.tools.some((t) => ['get_character_history', 'list_trade_history'].includes(t.name)));
    assert.ok(!tools.tools.some((t) => /^(approve|commit|call_api)/.test(t.name)));
    const ping = await client.callTool({ name: 'ping', arguments: {} });
    assert.equal(ping.isError, undefined);
    assert.equal(ping.structuredContent?.ok, true);
    const r = await client.callTool({ name: 'get_account_overview', arguments: {} });
    assert.equal(r.isError, undefined);
    assert.equal((r.structuredContent?.data as any)?.Balance, '1000000.123456');
    assert.equal(Object.hasOwn(r.structuredContent!, 'warnings'), false);
    f.flags.permissionDenied = true;
    for (const [name, args] of [['get_my_character_trading', { characterId: 1 }]] as const) {
      const denied = await client.callTool({ name, arguments: args });
      assert.equal(denied.isError, undefined);
      assert.equal(denied.structuredContent?.status, 'error');
      assert.equal((denied.structuredContent?.error as any)?.code, 'API_PERMISSION');
      assert.equal(Object.hasOwn(denied.structuredContent!, 'data'), false);
      assert.ok(!JSON.stringify(denied).includes('INVALID_ARGUMENT'));
      assert.deepEqual(JSON.parse((denied.content as any)[0].text), denied.structuredContent);
    }
    f.flags.permissionDenied = false;
    assert.equal(f.session.state, 'authenticated');
    const bad = await client.callTool({ name: 'get_character', arguments: { characterId: -1 } });
    assert.equal(bad.isError, true);
    const prepare = await client.callTool({
      name: 'prepare_buy_order',
      arguments: { characterId: 1, price: '10', amount: 2, requestId: 'mcp-prepare-01' },
    });
    assert.equal(prepare.structuredContent?.status, 'pending');
    assert.equal(f.writes.length, 0);
    f.temple.Level = 2;
    for (const [name, args] of [
      [
        'prepare_temple_update',
        { characterId: 1, requestId: 'mcp-temple-line', operation: { action: 'line', text: '新台词' } },
      ],
      ['prepare_magic', { characterId: 1, requestId: 'mcp-chaos-plan', operation: { action: 'chaos' } }],
      ['prepare_reward', { requestId: 'mcp-scratch-plan', action: 'scratch' }],
      [
        'prepare_image_upload',
        {
          characterId: 1,
          requestId: 'mcp-image-plan',
          kind: 'cover',
          mime: 'image/png',
          imageBase64: Buffer.concat([
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/SAAAAAASUVORK5CYII=',
              'base64',
            ),
            Buffer.alloc(40000),
          ]).toString('base64'),
        },
      ],
    ] as const) {
      const prepared = await client.callTool({ name, arguments: args });
      assert.equal(prepared.structuredContent?.status, 'pending', name);
      assert.equal(f.writes.length, 0);
    }
  } finally {
    await client.close();
    await manager.close();
  }
});
test('unauthenticated, cross-origin, missing-CSRF, DNS-rebinding Host and internal-token approval bypasses are denied', async () => {
  const f = await fixture(),
    m = await createManager({ dir: f.dir, port: 0, queries: f.q, vault: f.vault }),
    origin = m.runtime.origin;
  const post = (path: string, b: any, headers: any = {}) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(b),
    });
  try {
    assert.equal((await fetch(origin + '/api/state')).status, 403);
    assert.equal(
      (await post('/session', { token: m.runtime.bootstrap }, { Origin: 'https://evil.invalid' })).status,
      403,
    );
    const login = await post('/session', { token: m.runtime.bootstrap }, { Origin: origin });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.ok(login.headers.get('set-cookie')?.includes('SameSite=Strict'));
    assert.ok(login.headers.get('set-cookie')?.includes('HttpOnly'));
    const res = await fetch(origin + '/api/state', { headers: { Cookie: cookie } }),
      s: any = await res.json();
    assert.ok(s.csrf);
    assert.equal(
      (await post('/api/approve', { planId: 'whatever' }, { Cookie: cookie, Origin: origin })).status,
      403,
    );
    assert.equal(
      (
        await post(
          '/api/action',
          { action: 'login' },
          { Cookie: cookie, Origin: 'https://evil.invalid', 'X-CSRF-Token': s.csrf },
        )
      ).status,
      403,
    );
    assert.equal(
      (await post('/api/approve', {}, { Authorization: `Bearer ${m.runtime.internal}` })).status,
      403,
    );
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      const r = httpRequest(
        origin + '/api/state',
        { headers: { Host: 'evil.invalid', Cookie: cookie } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      r.on('error', reject);
      r.end();
    });
    assert.equal(rebound, 403);
    const p = await m.safety.prepare('buy', {
      characterId: 1,
      price: '10',
      amount: 2,
      requestId: 'integration-local-only',
    });
    await m.safety.policy({
      enabled: true,
      allowedActions: ['buy'],
      perTrade: '1000',
      daily: '5000',
      maxShares: 100,
      acknowledgeUnverified: true,
    });
    const result = await post(
      '/api/approve',
      { planId: p.id, fingerprint: p.fingerprint },
      { Cookie: cookie, Origin: origin, 'X-CSRF-Token': s.csrf },
    );
    assert.equal(result.status, 200);
    assert.equal(((await result.json()) as any).status, 'executed');
    assert.equal(f.writes.length, 1);
    await post(
      '/api/approve',
      { planId: p.id, fingerprint: p.fingerprint },
      { Cookie: cookie, Origin: origin, 'X-CSRF-Token': s.csrf },
    );
    assert.equal(f.writes.length, 1);
  } finally {
    await m.close();
  }
});
test(
  'Windows DPAPI encrypts fake identity cookie and a separate process can restore the jar',
  { skip: process.platform !== 'win32' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tinygrail-dpapi-'));
    await protectDirectory(dir);
    const vault = new Vault(dir),
      session = new Session(vault);
    await session.jar.setCookie(
      '.AspNetCore.Identity.Application=FAKE_DPAPI_SENTINEL; Path=/; Secure; HttpOnly',
      'https://tinygrail.com/',
    );
    session.authenticated({ Id: '123', Name: 'fixture', Nickname: 'fixture' });
    await session.save();
    const disk = await readFile(join(dir, 'session.dpapi.json'), 'utf8');
    assert.ok(!disk.includes('FAKE_DPAPI_SENTINEL'));
    assert.ok(!disk.includes('fixture'));
    const code =
      "import {Vault} from './dist/auth/vault.js'; import {Session} from './dist/auth/session.js'; const s=new Session(new Vault(process.env.TG_TEST_DIR)); await s.restore(); if(!(await s.cookie()).includes('FAKE_DPAPI_SENTINEL'))process.exit(2); console.log(s.state);";
    const output = await new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', code], {
        cwd: ROOT,
        env: { ...process.env, TG_TEST_DIR: dir },
        windowsHide: true,
      });
      let stdout = '';
      p.stdout.on('data', (b) => (stdout += b));
      p.stderr.resume();
      p.once('error', reject);
      p.once('close', (c) => (c === 0 ? resolve(stdout) : reject(new Error('DPAPI child failed'))));
    });
    assert.equal(output.trim(), 'unchecked');
    await session.logout();
    assert.equal(await new Vault(dir).get('session'), undefined);
  },
);
test('second manager never overwrites a running instance ledger or runtime', async () => {
  const f = await fixture(),
    m = await createManager({ dir: f.dir, port: 0, queries: f.q, vault: f.vault });
  try {
    const before = await readFile(join(f.dir, 'runtime.json'), 'utf8');
    await assert.rejects(createManager({ dir: f.dir, port: 0, queries: f.q, vault: f.vault }), {
      code: 'ALREADY_RUNNING',
    });
    assert.equal(await readFile(join(f.dir, 'runtime.json'), 'utf8'), before);
  } finally {
    await m.close();
  }
});
