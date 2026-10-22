import { DATA, ROOT, protectDirectory } from '../dist/core.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createManager } from '../dist/main.js';
import { Session } from '../dist/auth/session.js';
import { Vault } from '../dist/auth/vault.js';
import { ApiClient } from '../dist/api/client.js';
import { Queries } from '../dist/services/queries.js';
const dir = await mkdtemp(join(tmpdir(), 'tg-live-readonly-'));
const session = new Session(new Vault());
await session.restore();
session.restore = async () => {};
const api = new ApiClient(session);
const endpoints = [];
const original = api.read.bind(api);
api.read = async (req) => {
  const path = req.path.replace(
    /(chara\/user\/(?:chara|temple|initial|link|assets|send\/log)\/)(?!tinygrail|blueleaf)[^/?]+/,
    '$1{account}',
  );
  try {
    const r = await original(req);
    const v = r.value;
    const sample = Array.isArray(v) ? v[0] : (v?.Items?.[0] ?? v);
    endpoints.push({
      method: req.method ?? 'GET',
      path,
      ok: true,
      keys: typeof sample === 'object' && sample ? Object.keys(sample) : [],
      observedAt: r.observedAt,
    });
    return r;
  } catch (e) {
    endpoints.push({ method: req.method ?? 'GET', path, ok: false, code: e.code });
    throw e;
  }
};
const manager = await createManager({ dir, port: 0, queries: new Queries(api), vault: new Vault(dir) });
const client = new Client({ name: 'readonly-acceptance', version: '1' });
const records = [];
async function check(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const v = r.structuredContent;
  const ok = v?.status !== 'error' && !r.isError;
  records.push({
    name,
    args,
    ok,
    ...(!ok ? { error: v?.error } : {}),
    pagination: v?.data?.pagination,
    keys: Object.keys(v?.data ?? {}),
    returned: v?.data?.items?.length,
  });
  console.log(name, args.category ?? args.page ?? '', ok ? 'OK' : v?.error?.code);
  return ok ? v : undefined;
}
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'dist/index.js')],
      env: { ...process.env, TG_DATA_DIR: dir },
      stderr: 'pipe',
    }),
  );
  const catalogue = await client.listTools();
  console.log('TOOLS', catalogue.tools.length);
  await check('get_session_status');
  await check('get_account_overview');
  const top = await check('get_top_week');
  await check('get_top_week', { keyword: '空鱼' });
  await check('get_top_week_history', { page: 1, pageSize: 12 });
  await check('get_top_week_history', { page: 2, pageSize: 12 });
  const first = top?.data.items[0];
  if (first) {
    const detail = await check('get_character', { characterId: first.characterId });
    records.push({ name: 'top_week_character_identity', ok: detail?.data?.Name === first.name });
    await check('get_characters', { characterIds: top.data.items.slice(0, 3).map((x) => x.characterId) });
  }
  for (const category of [
    'ico',
    'valhalla',
    'fantasy',
    'tower',
    'dividend',
    'value',
    'rise',
    'fall',
    'all',
    'st',
    'refine',
    'wealth',
    'latest_temples',
    'latest_links',
    'tower_logs',
  ])
    for (const page of [1, 2]) await check('list_market', { category, page, pageSize: 3 });
  for (const name of [
    'list_holdings',
    'list_temples',
    'list_my_icos',
    'list_my_auctions',
    'list_links',
    'list_items',
    'list_balance_history',
  ])
    for (const page of [1, 2]) await check(name, { page, pageSize: 3 });
  for (const category of ['holdings', 'temples', 'links', 'ico', 'red_packets'])
    await check('list_user_assets', { category, page: 1, pageSize: 3 });
  await check('list_user_assets', { category: 'temples', keyword: '空鱼', characterIds: [1], pageSize: 3 });
  for (const side of ['buy', 'sell']) await check('list_orders', { side, pageSize: 3 });
  for (const name of [
    'get_orderbook',
    'get_my_character_trading',
    'get_character_pools',
    'get_character_links',
    'get_character_votes',
    'list_character_temples',
    'list_character_holders',
  ])
    await check(name, { characterId: 1 });
  await check('get_price_history', { characterId: 1, since: '2026-10-01', pageSize: 3 });
  await check('get_auction_status', { characterIds: [1] });
  await check('get_auction_history', { characterId: 1 });
  await check('get_dividend_forecast');
  for (const category of ['holiday', 'lotus_count']) await check('get_daily_status', { category });
  for (const category of ['profile', 'dividend'])
    await check('get_user_profile', { username: 'tinygrail', category });
  await check('get_user_character', { username: 'tinygrail', characterId: 1 });
  await check('search_characters', { keyword: '空鱼' });
  const ico = await check('list_market', { category: 'ico', pageSize: 3 });
  const row = ico?.data.items[0];
  if (row) {
    await check('get_ico_status', { characterId: Number(row.CharacterId) });
    await check('list_ico_participants', { icoId: Number(row.Id), pageSize: 3 });
    await check('get_my_ico_investment', { icoId: Number(row.Id) });
  }
} finally {
  await client.close();
  await manager.close();
  await protectDirectory(DATA);
  await writeFile(
    join(DATA, 'readonly-validation.json'),
    JSON.stringify({ date: new Date().toISOString(), realWrites: 0, records, endpoints }, null, 2),
  );
}

if (records.some((r) => !r.ok && !['API_REJECTED', 'API_PERMISSION'].includes(r.error?.code)))
  process.exitCode = 1;
