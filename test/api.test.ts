import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { ApiClient } from '../src/api/client.js';
import { pageData, safeData } from '../src/models.js';
import { budget, templeIncome, icoPrediction } from '../src/calculations.js';
import { AppError } from '../src/core.js';
import { Queries } from '../src/services/queries.js';
test('logout accepts an empty HTTP response and leaves verification to the session postflight', async () => {
  const f = await fixture();
  const api = new ApiClient(
    f.session,
    async () =>
      new Response(null, {
        status: 204,
        headers: { 'Set-Cookie': '.AspNetCore.Identity.Application=; Max-Age=0; Path=/; Secure' },
      }),
    'https://tinygrail.com/api/',
    0,
  );
  const r = await api.write('account/logout');
  assert.equal(r.value.logoutAcknowledged, true);
  assert.equal(await f.session.cookie(), '');
});

test('HTTP decimal literals retain precision; malformed business envelope never becomes success', async () => {
  const f = await fixture();
  const api = new ApiClient(
    f.session,
    async () =>
      new Response('{"State":0,"Value":{"Balance":9007199254740993.123456,"Current":0.100000000000000001}}'),
    'https://tinygrail.com/api/',
    0,
  );
  const r = await api.read({ path: 'chara/1' });
  assert.equal(r.value.Balance, '9007199254740993.123456');
  assert.equal(r.value.Current, '0.100000000000000001');
  f.flags.malformed = true;
  await assert.rejects(f.api.read({ path: 'chara/1' }), { code: 'SCHEMA' });
});
test('session expiration and queued old-account results are handled explicitly', async () => {
  const f = await fixture();
  f.flags.authExpired = true;
  await assert.rejects(f.q.account(), { code: 'AUTH_EXPIRED' });
  assert.equal(f.session.state, 'expired');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let sent = 0;
  const api = new ApiClient(
    f.session,
    async () => {
      sent++;
      await gate;
      return Response.json({ State: 0, Value: { Id: 1 } });
    },
    'https://tinygrail.com/api/',
    0,
  );
  const p = api.read({ path: 'chara/1' }),
    p2 = api.read({ path: 'chara/1' });
  await new Promise((r) => setTimeout(r, 10));
  f.session.epoch = 'new';
  release();
  const outcomes = await Promise.allSettled([p, p2]);
  assert.ok(outcomes.every((r) => r.status === 'rejected'));
  assert.equal(sent, 1);
});
test('redirects never forward cookies to other origins; error messages never echo upstream data', async () => {
  const f = await fixture();
  let calls = 0;
  const api = new ApiClient(
    f.session,
    async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/steal' } });
    },
    'https://tinygrail.com/api/',
    0,
  );
  await assert.rejects(api.read({ path: 'chara/user/assets', auth: true }), { code: 'AUTH_EXPIRED' });
  assert.equal(calls, 1);
  const rejected = new ApiClient(
    f.session,
    async () => Response.json({ State: 1, Message: 'SECRET_COOKIE=NEVER_ECHO' }),
    'https://tinygrail.com/api/',
    0,
  );
  await assert.rejects(rejected.read({ path: 'chara/1' }), (e) => !JSON.stringify(e).includes('NEVER_ECHO'));
});
test('HTTP 403 preserves authentication and permission errors; HTTP 401 expires the session', async () => {
  const f = await fixture();
  const api = (status: number) =>
    new ApiClient(f.session, async () => new Response(null, { status }), 'https://tinygrail.com/api/', 0);
  await assert.rejects(api(403).read({ path: 'chara/user/1', auth: true }), {
    code: 'API_PERMISSION',
  });
  assert.equal(f.session.state, 'authenticated');
  await assert.rejects(api(401).read({ path: 'chara/user/assets', auth: true }), { code: 'AUTH_EXPIRED' });
  assert.equal(f.session.state, 'expired');
});
test('only TinyGrail identity cookies are retained; unrelated cookies and secret fields are excluded', async () => {
  const f = await fixture();
  await f.session.absorb(
    [
      'OTHER_SITE=NO; Domain=evil.invalid',
      'unrelated=NO; Domain=tinygrail.com',
      '.AspNetCore.Identity.ApplicationC1=CHUNK; Path=/; Secure',
    ],
    f.session.epoch,
  );
  const cookie = await f.session.cookie();
  assert.ok(cookie.includes('CHUNK'));
  assert.ok(!cookie.includes('OTHER_SITE'));
  assert.ok(!cookie.includes('unrelated'));
  const result = await f.q.accountList('holdings', 1, 30);
  assert.equal(result.data.items[0].estimatedMarketValue, '10000');
  assert.ok(!JSON.stringify(result).includes('NEVER_EXPORT'));
  assert.ok(!JSON.stringify(result).includes('profit'));
});
test('pagination distinguishes returned-page integrity, remaining pages and complete data', () => {
  const first = pageData(
    { CurrentPage: 1, TotalPages: 2, TotalItems: 3, ItemsPerPage: 2, Items: [{ Id: 1 }, { Id: 2 }] },
    1,
    2,
  ).pagination;
  assert.equal(first.pageComplete, true);
  assert.equal(first.hasMore, true);
  assert.equal(first.complete, false);
  const last = pageData(
    { CurrentPage: 2, TotalPages: 2, TotalItems: 3, ItemsPerPage: 2, Items: [{ Id: 3 }] },
    2,
    2,
  ).pagination;
  assert.equal(last.pageComplete, true);
  assert.equal(last.hasMore, false);
  assert.equal(last.complete, false);
  assert.equal(
    pageData({ CurrentPage: 1, TotalPages: 2, TotalItems: 31, Items: [{ Id: 1 }] }, 1, 30).pagination
      .pageComplete,
    false,
  );
  assert.equal(
    pageData({ CurrentPage: 1, TotalItems: 1, Items: [{ Id: 1 }] }, 2, 30).pagination.pageComplete,
    false,
  );
  assert.equal(pageData([{ Id: 1 }], 1, 1).pagination.hasMore, null);
  assert.equal(pageData([], 1, 30).pagination.complete, false);
  assert.equal(pageData([{ Id: 1 }], 1, 100).pagination.hasMore, null);
  assert.equal(
    pageData({ CurrentPage: 1, TotalPages: 0, TotalItems: 0, Items: [] }, 1, 30).pagination.complete,
    true,
  );
  assert.equal(pageData([{ Id: 1 }, { Id: 2 }], 1, 1).pagination.truncated, false);
  assert.equal(pageData([{ Id: 1 }, { Id: 2 }], 1, 1).items.length, 2);
  assert.throws(() => pageData({ CurrentPage: 1 }, 1, 30), { code: 'SCHEMA' });
  assert.deepEqual(safeData({ Id: 1, SellerIp: 'hidden', Cookie: 'hidden', Token: 'hidden' }), { Id: 1 });
});
test('calculations keep exact arithmetic, display precision and optional formula details', () => {
  assert.equal(budget('0.1', 3, '0.01').total, '0.303');
  const top = templeIncome({
    CharacterRank: 1,
    CharacterStars: 2,
    Assets: 100,
    CharacterLevel: 2,
    Refine: 1,
    Rate: '10',
  });
  assert.equal(top.estimatedIncome, '4200.00');
  assert.equal(top.estimatedDividendPerShare, '42.0000');
  assert.equal(top.details, undefined);
  assert.equal(Object.hasOwn(top, 'warnings'), false);
  const outside = templeIncome({ CharacterRank: 501, CharacterStars: 2, Assets: 100 });
  assert.equal(outside.estimatedIncome, '400.00');
  const detailed = templeIncome(
    { CharacterRank: 2, CharacterStars: 2, Assets: 123, CharacterLevel: 3, Refine: 2, Rate: '10.123456789' },
    true,
  );
  assert.match(detailed.estimatedIncome, /^\d+\.\d{2}$/);
  assert.equal(detailed.details?.serverRuleVerified, false);
  assert.ok(detailed.details?.source.includes('90f7b26'));
  assert.equal(detailed.estimatedIncome, Number(detailed.details!.unrounded.income).toFixed(2));
  assert.throws(() => templeIncome({ CharacterRank: 1, CharacterStars: 0, Assets: 1 }), { code: 'SCHEMA' });
  const ico = icoPrediction('1000000', 20, '1000');
  assert.equal(ico.level, 2);
  assert.equal(ico.issuedShares, '17500');
  assert.equal(ico.displayPrice, '28.57');
  assert.equal(ico.details, undefined);
});
test('asset breakdown reports failures, incomplete pages and remaining data independently', async () => {
  const f = await fixture();
  const original = f.q.accountList.bind(f.q);
  f.q.accountList = async (kind, page, size) => {
    const r = await original(kind, page, size);
    if (kind === 'holdings')
      r.data.pagination = {
        ...r.data.pagination,
        totalItems: 60,
        totalPages: 2,
        complete: false,
        hasMore: true,
      };
    return r;
  };
  const r = await f.q.breakdown(1, 30);
  assert.deepEqual(r.data.completeness, {
    requestsSucceeded: true,
    requestedPagesComplete: true,
    allAssetsComplete: false,
  });
  assert.equal((r.data.parts.holdings as any).data.pagination.hasMore, true);
  assert.equal(Object.hasOwn(r, 'warnings'), false);
  f.q.accountList = async (kind, page, size) => {
    const r = await original(kind, page, size);
    if (kind === 'holdings') {
      r.data.pagination.pageComplete = false;
      r.data.pagination.complete = false;
    }
    return r;
  };
  assert.deepEqual((await f.q.breakdown(1, 30)).data.completeness, {
    requestsSucceeded: true,
    requestedPagesComplete: false,
    allAssetsComplete: false,
  });
  f.q.accountList = async (kind, page, size) => {
    if (kind === 'ico') throw new AppError('API_PERMISSION', '当前账号没有此接口权限。');
    return original(kind, page, size);
  };
  const failed = await f.q.breakdown(1, 30);
  assert.deepEqual(failed.data.completeness, {
    requestsSucceeded: false,
    requestedPagesComplete: false,
    allAssetsComplete: false,
  });
  assert.equal((failed.data.parts.ico as any).error.code, 'API_PERMISSION');
  assert.equal(Object.hasOwn(failed.data.parts.ico as any, 'data'), false);
  f.q.accountList = original;
  assert.equal((await f.q.breakdown(1, 30)).data.completeness.allAssetsComplete, true);
});
test('temple estimates return selected inputs; account dividend fields retain their actual units', async () => {
  const f = await fixture();
  const temple = await f.q.templeAnalysis(1);
  assert.equal(temple.data.scope, 'single_temple');
  assert.equal(Object.hasOwn(temple.data, 'server'), false);
  assert.deepEqual(Object.keys(temple.data.inputs).sort(), ['assets', 'level', 'rank', 'rate', 'refine']);
  assert.equal((await f.q.templeAnalysis(1, true)).data.details?.serverRuleVerified, false);
  const q = new Queries(
    new ApiClient(
      f.session,
      async () =>
        Response.json({
          State: 0,
          Value: { Total: 12345, Temples: 20, Share: '1.237', Tax: '.123', Daily: '50' },
        }),
      'https://tinygrail.com/api/',
      0,
    ),
  );
  assert.deepEqual((await q.dividendForecast()).data, {
    scope: 'account',
    interestBearingShares: '12345',
    templeCount: '20',
    estimatedDividend: '1.24',
    estimatedTax: '0.12',
    dailyBonus: '50.00',
  });
});
test('search supplements server omissions with real-shaped ICO entries and preserves record vs character IDs', async () => {
  const f = await fixture();
  const q = new Queries(
    new ApiClient(
      f.session,
      async (input) =>
        Response.json({
          State: 0,
          Value: String(input).includes('/mri/')
            ? [{ Id: 9, CharacterId: 86822, Name: '濑户茜理', Total: 1000000, Users: 20 }]
            : [],
        }),
      'https://tinygrail.com/api/',
      0,
    ),
  );
  const r = await q.search('茜理', 5);
  assert.equal(r.data.items[0].CharacterId, '86822');
  assert.equal(r.data.items[0].Id, '9');
  assert.equal(r.data.items[0].marketType, 'ico');
  assert.equal(r.data.icoScan?.complete, true);
});
test('emergency stop is checked after API queue wait and before writing to the network', async () => {
  const f = await fixture();
  let release!: () => void,
    stopped = false,
    sends = 0;
  const wait = new Promise<void>((r) => (release = r));
  const api = new ApiClient(
    f.session,
    async () => {
      sends++;
      await wait;
      return Response.json({ State: 0, Value: [] });
    },
    'https://tinygrail.com/api/',
    0,
  );
  const first = api.read({ path: 'chara/1' });
  await new Promise((r) => setTimeout(r, 10));
  const write = api.write('chara/bid/1/10/2', () => {
    if (stopped) throw new AppError('WRITE_DISABLED', 'stopped');
  });
  stopped = true;
  release();
  await first;
  await assert.rejects(write, { code: 'NOT_DISPATCHED' });
  assert.equal(sends, 1);
});
