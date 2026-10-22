import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../src/api/client.js';
import { Queries } from '../src/services/queries.js';
import { buildTools, invoke } from '../src/tools.js';
import { fixture } from './helpers.js';

test('price charts retain field meanings and precision, and can page beyond 100 response rows', async () => {
  const f = await fixture();
  const rows = Array.from({ length: 205 }, (_, i) => ({
    Id: i + 1,
    CharacterId: 1,
    Time: `2026-10-${String(1 + (i % 20)).padStart(2, '0')}T12:00:00`,
    Begin: '10.123456789012345678',
    End: '11',
    High: '12',
    Low: '9',
    Price: '9007199254740993.123456',
    Amount: '100',
    SellerIp: 'NEVER_EXPORT',
  }));
  const paths: string[] = [];
  const api = new ApiClient(
    f.session,
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      assert.equal(init?.method, 'GET');
      return Response.json({ State: 0, Value: rows });
    },
    'https://tinygrail.com/api/',
    0,
  );
  const tools = buildTools(new Queries(api), f.safety, async () => ({}));
  const args = { characterId: 1, since: '2026-10-01' };
  const first = await invoke(tools, 'get_price_history', args);
  const second = await invoke(tools, 'get_price_history', { ...args, page: 2 });
  const last = await invoke(tools, 'get_price_history', { ...args, page: 3 });
  const all = [...first.data.items, ...second.data.items, ...last.data.items];
  assert.equal(all.length, 205);
  assert.equal(new Set(all.map((v) => v.Id)).size, 205);
  assert.deepEqual(
    all.map((v) => v.Time),
    rows
      .map((v) => v.Time)
      .sort()
      .reverse(),
  );
  assert.equal(first.data.items[0].Price, '9007199254740993.123456');
  assert.equal(first.data.items[0].Begin, '10.123456789012345678');
  assert.equal(first.data.pagination.totalItems, 205);
  assert.equal(first.data.pagination.scope, 'server_response');
  assert.equal(first.data.pagination.complete, false);
  assert.equal(first.data.pagination.serverHistoryComplete, null);
  assert.equal(second.data.pagination.hasMore, true);
  assert.equal(last.data.pagination.returned, 5);
  assert.equal(last.data.pagination.hasMore, false);
  assert.ok(!JSON.stringify(all).includes('NEVER_EXPORT'));
  assert.deepEqual(paths, Array(3).fill('/api/chara/charts/1/2026-10-01'));
  await assert.rejects(invoke(tools, 'get_price_history', { ...args, since: '2026-02-30' }), {
    code: 'INVALID_INPUT',
  });
  assert.equal(paths.length, 3);
});

test('personal history sorts and pages each server history without turning current orders into fills', async () => {
  const f = await fixture();
  f.trading.BidHistory = Array.from({ length: 105 }, (_, i) => ({
    Id: i + 1,
    Price: '1.123456789',
    Seller: 'public_seller',
    SellerName: '公开卖方',
    Buyer: 'fixture_user',
    BuyerName: '测试账号',
    SellerIp: 'NEVER_EXPORT',
    Amount: i + 1,
    TradeTime: `2026-10-${String(1 + (i % 20)).padStart(2, '0')}T12:00:00`,
  }));
  f.trading.AskHistory = [
    { Id: 501, Price: '2', Amount: 2, TradeTime: '2026-10-01T12:00:00' },
    { Id: 502, Price: '3', Amount: 1, TradeTime: '2026-10-02T12:00:00' },
    { Id: 503, Price: '4', Amount: 1 },
  ];
  f.trading.Asks = [{ Id: 600, Price: '5', Amount: 9, Begin: '2026-10-03T12:00:00', State: 0 }];
  f.trading.Bids = [{ Id: 700, Price: '6', Amount: 8, Begin: '2026-10-03T12:00:00', State: 0 }];
  const tools = buildTools(f.q, f.safety, async () => ({}));
  const first = await invoke(tools, 'get_my_character_trading', { characterId: 1 });
  const last = await invoke(tools, 'get_my_character_trading', { characterId: 1, historyPage: 2 });
  assert.equal(first.data.BidHistory.length, 100);
  assert.equal(last.data.BidHistory.length, 5);
  assert.equal(new Set([...first.data.BidHistory, ...last.data.BidHistory].map((v) => v.Id)).size, 105);
  assert.equal(first.data.BidHistory[0].Price, '1.123456789');
  assert.equal(first.data.BidHistory[0].Seller, 'public_seller');
  assert.equal(first.data.BidHistory[0].BuyerName, '测试账号');
  assert.ok(!JSON.stringify(first.data.BidHistory).includes('NEVER_EXPORT'));
  assert.deepEqual(
    first.data.AskHistory.map((v: any) => v.Id),
    ['502', '501', '503'],
  );
  assert.deepEqual(last.data.AskHistory, []);
  assert.equal(first.data.historyPagination.BidHistory.totalItems, 105);
  assert.equal(first.data.historyPagination.BidHistory.serverHistoryComplete, null);
  assert.equal(first.data.historyPagination.AskHistory.complete, true);
  assert.equal(first.data.estimatedFrozenBidPrincipal, '48');
  assert.equal(first.data.Asks[0].Id, '600');
  assert.equal(first.data.Bids[0].Id, '700');
  assert.ok(!first.data.BidHistory.some((v: any) => v.Id === '700'));
  assert.ok(!JSON.stringify(first.data).includes('completed'));
  assert.ok(f.reads.every((p) => ['chara/user/assets', 'chara/user/1'].includes(p)));
  assert.deepEqual(f.writes, []);
});

test('missing, null, empty and malformed histories stay distinct; balance uses its own endpoint', async () => {
  const f = await fixture();
  const empty = await f.q.trading(1);
  assert.deepEqual(empty.data.AskHistory, []);
  assert.equal(empty.data.historyPagination.AskHistory.totalItems, 0);
  delete f.trading.AskHistory;
  f.trading.BidHistory = null;
  const missing = await f.q.trading(1);
  assert.equal(Object.hasOwn(missing.data, 'AskHistory'), false);
  assert.equal(missing.data.BidHistory, null);
  assert.deepEqual(missing.data.historyPagination, { AskHistory: null, BidHistory: null });
  f.trading.AskHistory = {};
  await assert.rejects(f.q.trading(1), { code: 'SCHEMA' });
  await f.q.accountList('balance', 1, 30);
  assert.equal(f.reads.at(-1), 'chara/user/balance/1/30');
  const emptyCharts = await f.q.priceHistory(1, '2026-10-01', 1, 100);
  assert.deepEqual(emptyCharts.data.items, []);
  assert.equal(emptyCharts.data.pagination.serverHistoryComplete, null);
  const malformed = new Queries(
    new ApiClient(
      f.session,
      async () => Response.json({ State: 0, Value: {} }),
      'https://tinygrail.com/api/',
      0,
    ),
  );
  await assert.rejects(malformed.priceHistory(1, '2026-10-01', 1, 100), { code: 'SCHEMA' });
});
