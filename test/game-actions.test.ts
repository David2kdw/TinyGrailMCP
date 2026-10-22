import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../src/api/client.js';
import { Queries } from '../src/services/queries.js';
import { Safety } from '../src/safety/engine.js';
import { gameActions, imageData, type GameAction } from '../src/safety/game-actions.js';
import { fixture } from './helpers.js';
import { buildTools, invoke } from '../src/tools.js';
import { BangumiClient } from '../src/api/bangumi.js';
import { BangumiQueries } from '../src/services/bangumi.js';
async function gameFixture(action: GameAction) {
  const f = await fixture();
  const profile = { ...f.account, ShowDaily: 1, ShowWeekly: 1, ShowHoliday: 1 };
  let issued = action !== 'ico_start',
    removed = false,
    lost = false;
  const temple: any = { ...f.temple, Id: 101, Assets: 3000, Level: 2, Line: 'old', Cover: 'old', LinkId: 0 };
  const targetTemple: any = { ...temple, Id: 102, CharacterId: 2, Assets: 3000 };
  const source: any = { ...f.chara, Icon: 'old' },
    target: any = { ...f.chara, Id: 2, CharacterId: 2, StarForces: 100, Sacrifices: 100 };
  let available = 100,
    holding = 5,
    fantasy = 100,
    count = 0;
  const logs: any[] = [];
  const writes: any[] = [];
  const args: any = {
    characterId: 1,
    targetCharacterId: 2,
    amount: 2,
    text: '台词测试',
    url: 'https://tinygrail.oss-cn-hangzhou.aliyuncs.com/cover/test.jpg',
    username: 'other',
    requestId: `game-${action}-test`,
  };
  if (action === 'send') args.amount = '100';
  if (action === 'ico_start') args.amount = '10000';
  if (action === 'image_upload')
    Object.assign(args, { kind: 'cover', mime: 'image/png', imageBase64: 'iVBORw0KGgo=' });
  const page = (rows: any[]) => ({
    CurrentPage: 1,
    TotalPages: rows.length ? 1 : 0,
    ItemsPerPage: 100,
    TotalItems: rows.length,
    Items: rows,
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname.replace(/^\/api\//, '');
    const mutating =
      (init?.method === 'POST' && !path.startsWith('chara/user/chara/') && path !== 'chara/list') ||
      init?.method === 'PUT' ||
      path === 'chara/update/1' ||
      path === 'event/holiday/bonus';
    let v: any;
    if (mutating) {
      writes.push({ path, method: init?.method, body: init?.body, headers: init?.headers });
      if (path.startsWith('chara/oss/sign/'))
        return Response.json({
          State: 0,
          Value: { Key: 'FAKE_KEY', Sign: 'FAKE_SIGNATURE', Date: 'Fri, 23 Oct 2026 00:00:00 GMT' },
        });
      if (init?.method === 'PUT') {
        assert.ok(!('Cookie' in (init.headers as any)));
        return new Response(null, { status: 200 });
      }
      v = 'accepted';
      if (path.startsWith('chara/temple/line/')) temple.Line = JSON.parse(String(init?.body));
      else if (path.startsWith('chara/temple/cover/reset/')) temple.Cover = null;
      else if (path.startsWith('chara/temple/cover/')) temple.Cover = JSON.parse(String(init?.body));
      else if (path.startsWith('chara/temple/destroy/')) removed = true;
      else if (path === 'chara/link/1/2') {
        temple.LinkId = 102;
        targetTemple.LinkId = 101;
      } else if (path.startsWith('chara/avatar/')) source.Icon = JSON.parse(String(init?.body));
      else if (path.startsWith('chara/init/')) {
        issued = true;
        delete source.Current;
        source.End = '2099-01-01';
        profile.Balance = String(Number(profile.Balance) - 10000);
      } else if (path.startsWith('magic/chaos/') || path.startsWith('magic/guidepost/')) {
        temple.Assets -= action === 'chaos' ? 10 : 100;
        holding += 7;
        v = { Id: 2, Amount: 7 };
      } else if (path.startsWith('magic/fisheye/')) {
        temple.Assets -= 100;
        fantasy -= 10;
      } else if (path.startsWith('magic/starbreak/')) {
        temple.Assets -= 100;
        target.StarForces -= 10;
      } else if (path.startsWith('magic/stardust2/')) {
        available -= 2;
        target.Sacrifices -= 2;
      } else if (path.startsWith('magic/stardust/')) {
        available -= 2;
        targetTemple.Assets += 2;
      } else if (path.startsWith('event/send/')) {
        profile.Balance = String(Number(profile.Balance) - 100);
        logs.push({ Id: 99, Type: 16, RelatedName: 'other', Change: -100 });
      } else if (path.startsWith('event/scratch/')) {
        holding += 7;
        profile.Balance = String(Number(profile.Balance) - (action === 'scratch' ? 1000 : 2 ** count * 2000));
        count++;
        v = [{ Id: 2, Amount: 7 }];
      } else if (
        path === 'event/share/bonus' ||
        path === 'event/bangumi/bonus/daily' ||
        path === 'event/holiday/bonus'
      ) {
        profile[
          action === 'weekly_bonus' ? 'ShowWeekly' : action === 'daily_bonus' ? 'ShowDaily' : 'ShowHoliday'
        ] = 0;
        profile.Balance = String(Number(profile.Balance) + 500);
      } else if (path === 'account/logout') await f.session.jar.removeAllCookies();
      else if (path !== 'chara/update/1') throw Error('Unexpected mock write ' + path);
      if (lost) throw Error('lost response');
    } else if (path === 'chara/list') v = issued ? [source] : [];
    else if (path === 'chara/user/assets') v = profile;
    else if (path === 'chara/1') {
      if (!issued) return Response.json({ State: 1 });
      v = source;
    } else if (path === 'chara/2') v = target;
    else if (path === 'chara/user/1') v = { ...f.trading, Amount: available };
    else if (path === 'chara/users/1/1/10')
      v = page([{ Id: 123, Name: 'fixture_user', LastActiveDate: new Date().toISOString(), State: 0 }]);
    else if (path.startsWith('chara/user/temple/'))
      v = page(url.searchParams.get('characterIds') === '2' ? [targetTemple] : removed ? [] : [temple]);
    else if (path === 'chara/kill/votes/1' || path === 'chara/links/1') v = [];
    else if (path === 'chara/user/2/blueleaf/false') v = { Amount: fantasy };
    else if (path === 'chara/temple/2') v = [targetTemple];
    else if (path === 'chara/user/chara/fixture_user/1/100')
      v = page([{ CharacterId: 2, UserAmount: holding }]);
    else if (path === 'chara/user/assets/other') v = { Id: 456, Name: 'other' };
    else if (path.startsWith('chara/user/send/log/')) v = page(logs);
    else if (path === 'event/daily/count/10') v = count;
    else if (path === 'event/holiday/bonus/check') v = 'fixture holiday';
    else if (path === 'event/share/bonus/test') v = { Share: 500 };
    else if (path === 'chara/user/balance/1/30') v = page([]);
    else throw Error('Unexpected mock read ' + path);
    return Response.json({ State: 0, Value: v });
  };
  const q = new Queries(new ApiClient(f.session, fetcher, 'https://tinygrail.com/api/', 0));
  const safety = new Safety(q, f.dir);
  await safety.init();
  await safety.policy({
    enabled: true,
    allowedActions: [...gameActions],
    perTrade: '100000',
    daily: '500000',
    maxShares: 10000,
    acknowledgeUnverified: true,
  });
  return {
    args,
    q,
    safety,
    writes,
    temple,
    profile,
    setLost() {
      lost = true;
    },
  };
}
test('every new player write traverses immutable plan, approval, one dispatch and action-specific reconciliation', async () => {
  for (const action of gameActions) {
    const f = await gameFixture(action);
    const p = await f.safety.prepare(action, f.args);
    assert.equal(f.writes.length, 0, action);
    const r = await f.safety.approve(p.id, p.fingerprint);
    assert.equal(r.status, 'executed', action);
    assert.equal(r.receipt.verified, true, action);
    const n = f.writes.length;
    assert.equal(n, action === 'image_upload' ? 3 : 1, action);
    await f.safety.approve(p.id, p.fingerprint);
    assert.equal(f.writes.length, n, action);
    assert.ok(!JSON.stringify(r).includes('FAKE_SIGNATURE'));
  }
});
test('Bangumi discovery can feed an ICO plan without dispatching any game operation', async () => {
  const f = await gameFixture('ico_start');
  f.q.bangumi = new BangumiQueries(
    new BangumiClient(
      async () =>
        Response.json({
          data: [{ id: 1, name: '待发行角色', images: null }],
          total: 1,
          limit: 30,
          offset: 0,
        }),
      0,
    ),
  );
  const tools = buildTools(f.q, f.safety, async () => ({}));
  const search = await invoke(tools, 'search_bangumi_characters', { keyword: '待发行', includeMarket: true });
  const candidate = search.data.items[0];
  assert.equal(candidate.market.status, 'not_in_market');
  assert.equal(f.writes.length, 0);
  const plan = await invoke(tools, 'prepare_ico_start', {
    characterId: candidate.characterId,
    amount: '10000',
    requestId: 'discovered-ico-plan',
  });
  assert.equal(plan.status, 'pending');
  assert.equal(f.writes.length, 0);
});
test('new writes invalidate changed assets, enforce risk/share limits, and block lost GET and POST outcomes', async () => {
  const f = await gameFixture('chaos');
  const p = await f.safety.prepare('chaos', f.args);
  f.temple.Assets--;
  await assert.rejects(f.safety.approve(p.id, p.fingerprint), { code: 'STATE_CHANGED' });
  assert.equal(f.writes.length, 0);
  for (const action of ['holiday_bonus', 'temple_line'] as const) {
    const f = await gameFixture(action);
    const p = await f.safety.prepare(action, f.args);
    f.setLost();
    const r = await f.safety.approve(p.id, p.fingerprint);
    assert.equal(r.status, 'outcome_unknown');
    await assert.rejects(f.safety.prepare(action, { ...f.args, requestId: 'new-intent-01' }), {
      code: 'UNKNOWN_BLOCK',
    });
    await f.safety.approve(p.id, p.fingerprint);
    assert.equal(f.writes.length, 1);
  }
  const low = await gameFixture('starbreak');
  await low.safety.policy({
    enabled: true,
    allowedActions: ['starbreak'],
    perTrade: '100000',
    daily: '500000',
    maxShares: 99,
    acknowledgeUnverified: true,
  });
  const limited = await low.safety.prepare('starbreak', low.args);
  await assert.rejects(low.safety.approve(limited.id, limited.fingerprint), { code: 'LIMIT' });
});
test('image plans hide bytes, bind preview to fingerprint, and reject malformed or unapproved uploads', async () => {
  const f = await gameFixture('image_upload');
  const p = await f.safety.prepare('image_upload', f.args);
  assert.ok(!JSON.stringify(p).includes(f.args.imageBase64));
  assert.equal((await f.safety.previewImage(p.id)).bytes.length, 8);
  assert.equal(p.terms.args.image.url, imageData(f.args).url);
  assert.equal(f.writes.length, 0);
  await assert.rejects(
    f.safety.prepare('image_upload', { ...f.args, imageBase64: 'aGVsbG8=', requestId: 'bad-image-01' }),
    { code: 'IMAGE' },
  );
  const tools = buildTools(f.q, f.safety, async () => ({}));
  await assert.rejects(
    invoke(tools, 'prepare_character_update', {
      characterId: 1,
      requestId: 'no-admin-action',
      operation: { action: 'vote', text: 'bad' },
    }),
    { code: 'INVALID_INPUT' },
  );
});
