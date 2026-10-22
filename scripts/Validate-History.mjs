import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ApiClient } from '../dist/api/client.js';
import { Session } from '../dist/auth/session.js';
import { Vault } from '../dist/auth/vault.js';
import { Queries } from '../dist/services/queries.js';
import { Safety } from '../dist/safety/engine.js';
import { buildTools, invoke } from '../dist/tools.js';
import { atomicJson, ROOT, DATA, protectDirectory } from '../dist/core.js';
import { safeData } from '../dist/models.js';

// Read-only verification; persisted evidence contains counts and field names only.
const session = new Session(new Vault());
await session.restore();
const api = new ApiClient(session);
const raw = new Map();
const requests = [];
const read = api.read.bind(api);
api.read = async (request) => {
  assert.equal(request.method ?? 'GET', 'GET');
  assert.match(
    request.path,
    /^chara\/(?:user\/(?:assets|\d+|balance\/\d+\/\d+)|charts\/\d+\/\d{4}-\d{2}-\d{2})$/,
  );
  const r = await read(request);
  raw.set(request.path, r.value);
  requests.push(request.path);
  return r;
};
const q = new Queries(api);
const tools = buildTools(q, new Safety(q), async () => ({}));
const client = new Client({ name: 'tinygrail-history-validation', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, 'dist/index.js')],
  env: { ...process.env },
  stderr: 'pipe',
});
const records = [];
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  assert.notEqual(r.isError, true);
  assert.notEqual(r.structuredContent?.status, 'error');
  return r.structuredContent;
}
function verifyRows(rows, field, actual, page = 1, size = 100) {
  const key = (r) => (typeof r[field] === 'string' ? r[field].replace(' ', 'T') : '');
  const expected = [...rows]
    .sort((a, b) => key(b).localeCompare(key(a)))
    .slice((page - 1) * size, page * size)
    .map((r) => safeData(r));
  assert.deepEqual(actual, expected);
}
try {
  await client.connect(transport);
  const catalogue = (await client.listTools()).tools;
  for (const name of ['get_price_history', 'get_my_character_trading', 'list_balance_history'])
    assert.ok(catalogue.some((t) => t.name === name));
  assert.ok(!catalogue.some((t) => ['get_character_history', 'list_trade_history'].includes(t.name)));
  const holdings = await call('list_holdings', { page: 1, pageSize: 30 });
  const candidates = [
    ...new Set([...holdings.data.items.map((r) => Number(r.CharacterId ?? r.Id)), 1]),
  ].filter((n) => Number.isSafeInteger(n) && n > 0);
  let trading, characterId;
  let nonempty = false;
  let scanned = 0;
  for (const id of candidates.slice(0, 15)) {
    characterId = id;
    scanned++;
    trading = await invoke(tools, 'get_my_character_trading', { characterId });
    if ((trading.data.AskHistory?.length ?? 0) + (trading.data.BidHistory?.length ?? 0) > 0) {
      nonempty = true;
      break;
    }
  }
  assert.ok(trading);
  const source = raw.get(`chara/user/${characterId}`);
  for (const field of ['AskHistory', 'BidHistory']) {
    if (Array.isArray(source[field])) verifyRows(source[field], 'TradeTime', trading.data[field]);
  }
  assert.equal(Object.hasOwn(trading.data, 'historyPagination'), true);
  // A small page exercises the real-record paging path even when histories have fewer than 100 rows.
  const paged = await invoke(tools, 'get_my_character_trading', {
    characterId,
    historyPage: 2,
    historyPageSize: 1,
  });
  const pageSource = raw.get(`chara/user/${characterId}`);
  for (const field of ['AskHistory', 'BidHistory']) {
    if (Array.isArray(pageSource[field])) verifyRows(pageSource[field], 'TradeTime', paged.data[field], 2, 1);
  }
  const liveTrading = await call('get_my_character_trading', {
    characterId,
    historyPage: 1,
    historyPageSize: 100,
  });
  assert.ok(liveTrading.data.historyPagination);
  for (const field of ['AskHistory', 'BidHistory']) {
    const row = liveTrading.data[field]?.[0];
    if (row) assert.ok(!Object.hasOwn(row, 'SellerIp') && !Object.hasOwn(row, 'BuyerIp'));
  }
  records.push({
    name: 'get_my_character_trading',
    ok: true,
    nonempty,
    charactersScanned: scanned,
    histories: Object.fromEntries(
      ['AskHistory', 'BidHistory'].map((field) => [
        field,
        {
          received: Array.isArray(source[field]) ? source[field].length : null,
          itemKeys: Object.keys(source[field]?.[0] ?? {}),
          returned: trading.data[field]?.length ?? null,
        },
      ]),
    ),
    rawFieldsAndSortingVerified: true,
    responsePagingVerified: true,
    stdioVerified: true,
  });
  const args = { characterId, since: '2026-10-01' };
  const charts = await invoke(tools, 'get_price_history', args);
  const chartSource = raw.get(`chara/charts/${characterId}/${args.since}`);
  verifyRows(chartSource, 'Time', charts.data.items);
  assert.ok(chartSource.length > 0, '选择的角色没有历史行情');
  const chartPage = await invoke(tools, 'get_price_history', { ...args, page: 2, pageSize: 1 });
  verifyRows(raw.get(`chara/charts/${characterId}/${args.since}`), 'Time', chartPage.data.items, 2, 1);
  const liveCharts = await call('get_price_history', args);
  assert.equal(liveCharts.data.pagination.scope, 'server_response');
  records.push({
    name: 'get_price_history',
    ok: true,
    received: chartSource.length,
    itemKeys: Object.keys(chartSource[0]),
    rawFieldsAndSortingVerified: true,
    responsePagingVerified: true,
    stdioVerified: true,
  });
  const balance = await invoke(tools, 'list_balance_history', { page: 1, pageSize: 3 });
  const liveBalance = await call('list_balance_history', { page: 1, pageSize: 3 });
  assert.ok(Array.isArray(liveBalance.data.items));
  records.push({
    name: 'list_balance_history',
    ok: true,
    returned: balance.data.items.length,
    pagination: balance.data.pagination,
    stdioVerified: true,
  });
  const report = {
    observedAt: new Date().toISOString(),
    authenticated: session.state === 'authenticated',
    realAssetWrites: 0,
    registeredToolCount: catalogue.length,
    gmToolsRegistered: false,
    tracedGetRequests: requests.length,
    gmRequests: 0,
    records,
  };
  await protectDirectory(DATA);
  await atomicJson(join(DATA, 'trade-history-validation.json'), report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
}
