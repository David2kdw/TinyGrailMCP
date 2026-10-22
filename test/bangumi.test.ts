import test from 'node:test';
import assert from 'node:assert/strict';
import { BangumiClient } from '../src/api/bangumi.js';
import { ApiClient } from '../src/api/client.js';
import { BangumiQueries } from '../src/services/bangumi.js';
import { Queries } from '../src/services/queries.js';
import { buildTools, invoke } from '../src/tools.js';
import { AppError } from '../src/core.js';
import { fixture } from './helpers.js';

const character = (id = 2) => ({
  id,
  name: '同名',
  nameCN: '中文名',
  images: { small: 'https://lain.bgm.tv/example.jpg' },
});
const relation = (id: number, spoiler = false) => ({
  character: character(),
  relation: { id, cn: `关系${id}`, desc: '关系描述', viceVersaTo: 9 },
  spoiler,
  ended: false,
  comment: '关联备注',
});
const subject = {
  id: 10,
  name: '作品',
  name_cn: '中文作品',
  type: 2,
  platform: 'TV',
  images: { common: 'https://lain.bgm.tv/cover.jpg' },
};

test('Bangumi adapters use separate hosts, native POST filters and offsets without any TinyGrail credentials', async () => {
  const f = await fixture(),
    requests: { url: URL; init: RequestInit }[] = [];
  const b = new BangumiQueries(
    new BangumiClient(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, init: init! });
      assert.equal(new Headers(init!.headers).has('Cookie'), false);
      assert.equal(new Headers(init!.headers).has('Authorization'), false);
      assert.equal(init!.redirect, 'manual');
      assert.equal(init!.credentials, 'omit');
      let value: unknown;
      if (url.pathname === '/v0/characters/1')
        value = {
          ...character(1),
          nameCN: undefined,
          infobox: [{ key: '简体中文名', value: '来自词条的中文名' }],
          summary: '简介',
        };
      else if (url.pathname === '/v0/subjects/10') value = { ...subject, summary: '作品介绍' };
      else if (url.pathname.endsWith('/relations'))
        value = { data: [relation(1), relation(2, true)], total: 2 };
      else if (url.pathname.endsWith('/casts')) value = { data: [{ subject, type: 1 }], total: 3 };
      else if (url.pathname === '/p1/subjects/10/characters')
        value = { data: [{ character: character(), type: 1, order: 0 }], total: 3 };
      else
        value = {
          data: url.pathname.endsWith('/subjects') ? [subject] : [character(1), character(2)],
          total: 4,
          limit: 2,
          offset: 2,
        };
      return Response.json(value, { headers: { 'Set-Cookie': 'bangumi_only=NEVER_IMPORT' } });
    }, 0),
  );
  const q = new Queries(f.api, b);
  const tools = buildTools(q, f.safety, async () => ({}));
  const search = await invoke(tools, 'search_bangumi_characters', { keyword: '同名', page: 2, pageSize: 2 });
  assert.deepEqual(
    search.data.items.map((v: any) => v.characterId),
    [1, 2],
  );
  assert.equal(search.data.pagination.offset, 2);
  assert.equal(search.data.pagination.hasMore, false);
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { keyword: '同名', filter: {} });
  const subjects = await invoke(tools, 'search_bangumi_subjects', {
    keyword: '作品',
    page: 2,
    pageSize: 2,
    types: [2],
    sort: 'score',
  });
  assert.equal(subjects.data.items[0].subjectId, 10);
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), {
    keyword: '作品',
    filter: { type: [2] },
    sort: 'score',
  });
  assert.equal(
    (await invoke(tools, 'get_bangumi_character', { characterId: 1 })).data.nameCn,
    '来自词条的中文名',
  );
  assert.equal((await invoke(tools, 'get_bangumi_subject', { subjectId: 10 })).data.platform, 'TV');
  await invoke(tools, 'list_bangumi_subject_characters', {
    subjectId: 10,
    page: 2,
    pageSize: 2,
    appearanceType: 1,
  });
  await invoke(tools, 'get_bangumi_character_casts', {
    characterId: 1,
    page: 2,
    pageSize: 2,
    subjectType: 2,
    appearanceType: 1,
  });
  const relations = await invoke(tools, 'get_bangumi_character_relations', { characterId: 1 });
  assert.deepEqual(
    relations.data.items.map((v: any) => v.relation.id),
    [1, 2],
  );
  assert.equal(relations.data.items[1].spoiler, true);
  assert.equal(relations.data.items[1].relation.viceVersaTo, 9);
  for (const r of requests) {
    assert.ok(r.url.hostname === (r.url.pathname.startsWith('/v0/') ? 'api.bgm.tv' : 'next.bgm.tv'));
    assert.equal(r.init.method, r.url.pathname.includes('/search/') ? 'POST' : 'GET');
  }
  assert.equal(requests[4]!.url.searchParams.get('offset'), '2');
  assert.equal(requests[5]!.url.searchParams.get('subjectType'), '2');
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
  assert.ok(!(await f.session.cookie())!.includes('bangumi_only'));
  await assert.rejects(invoke(tools, 'search_bangumi_characters', { keyword: ' ' }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(
    invoke(tools, 'get_bangumi_character', { characterId: 1, url: 'https://other.invalid/' }),
    { code: 'INVALID_INPUT' },
  );
});

test('market status joins by CharacterId, distinguishes ICO time/state, and makes only one deduplicated batch', async () => {
  const f = await fixture();
  const bodies: number[][] = [];
  const q = new Queries(
    new ApiClient(
      f.session,
      async (_input, init) => {
        bodies.push(JSON.parse(String(init!.body)));
        return Response.json(
          {
            State: 0,
            Value: [
              { Id: 1, CharacterId: 1, Name: '上市', Current: 0, State: 0 },
              {
                Id: 900,
                CharacterId: 2,
                Name: '募集',
                Begin: '2026-10-22T01:00:00',
                End: '2026-10-24T01:00:00',
                State: 0,
              },
              { Id: 901, CharacterId: 3, Name: '结束', End: '2026-10-23T08:00:00', State: 0 },
              { Id: 902, CharacterId: 4, Name: '其他', End: '2026-10-24T01:00:00', State: 2 },
              { Id: 903, CharacterId: 5, Name: '缺失期限', End: 'invalid', State: 0 },
              {
                Id: 904,
                CharacterId: 6,
                Name: '未开始',
                Begin: '2026-10-24T01:00:00+08:00',
                End: '2026-10-25T01:00:00+08:00',
                State: 0,
              },
            ],
          },
          { headers: { Date: 'Fri, 23 Oct 2026 00:00:00 GMT' } },
        );
      },
      undefined,
      0,
    ),
  );
  const r = await q.marketStatuses([1, 2, 3, 4, 5, 6, 7, 2]);
  assert.deepEqual(
    r.data.items.map((v) => v.status),
    ['listed', 'ico_active', 'ico_ended', 'other', 'unknown', 'ico_pending', 'not_in_market'],
  );
  assert.equal((r.data.items[1] as any).icoId, '900');
  assert.equal(r.data.items[1]!.characterId, 2);
  assert.deepEqual(bodies, [[1, 2, 3, 4, 5, 6, 7]]);
  const relations = { data: { items: [relation(1), relation(2, true)] }, observedAt: 'now' };
  // Use the exact normalized model the real adapters return.
  const normalized = {
    data: { items: relations.data.items.map((r) => ({ ...r, character: { characterId: 2, name: '同名' } })) },
    observedAt: 'now',
  };
  q.api = new ApiClient(
    f.session,
    async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init!.body)), [2]);
      return Response.json({
        State: 0,
        Value: [{ Id: 900, CharacterId: 2, Name: '募集', End: '2099-01-01T00:00:00', State: 0 }],
      });
    },
    undefined,
    0,
  );
  const joined = await q.attachMarket(normalized, true);
  assert.equal(joined.data.items.length, 2);
  assert.equal(joined.data.items[0].character.market.status, 'ico_active');
  assert.equal(joined.data.items[1].character.market.status, 'ico_active');
  assert.equal(f.writes.length, 0);
});

test('failed batch queries cannot label characters absent or authorize an ICO plan', async () => {
  const f = await fixture();
  const q = new Queries(
    new ApiClient(f.session, async () => Response.json({ State: 1, Message: '业务失败' }), undefined, 0),
  );
  await assert.rejects(q.marketStatuses([1]), { code: 'API_REJECTED' });
  const r = await q.attachMarket({ data: { characterId: 1 }, observedAt: 'now' }, true);
  assert.equal(r.data.market.status, 'unknown');
  assert.equal(r.data.marketError.code, 'API_REJECTED');
  const read = f.api.read.bind(f.api);
  f.api.read = async (request) => {
    if (request.path === 'chara/1' || request.path === 'chara/list')
      throw new AppError('API_REJECTED', '查询失败');
    return read(request);
  };
  await f.safety.policy({
    enabled: true,
    allowedActions: ['ico_start'],
    perTrade: '100000',
    daily: '500000',
    maxShares: 1000,
    acknowledgeUnverified: true,
  });
  await assert.rejects(
    f.safety.prepare('ico_start', { characterId: 1, amount: '10000', requestId: 'failed-query-no-ico' }),
    { code: 'API_REJECTED' },
  );
  assert.equal(f.writes.length, 0);
});

test('Bangumi empty results, out-of-range pages, missing images and API errors stay explicit', async () => {
  const empty = new BangumiQueries(
    new BangumiClient(async () => Response.json({ data: [], total: 0, limit: 2, offset: 2 }), 0),
  );
  const r = await empty.searchCharacters('无匹配', 2, 2);
  assert.deepEqual(r.data.items, []);
  assert.equal(r.data.pagination.hasMore, false);
  for (const status of [403, 404, 429, 503]) {
    let calls = 0;
    const b = new BangumiQueries(
      new BangumiClient(async () => {
        calls++;
        return new Response('not JSON', { status });
      }, 0),
    );
    await assert.rejects(b.character(1), {
      code: status === 429 ? 'BANGUMI_RATE_LIMIT' : 'BANGUMI_HTTP',
      details: { status, service: 'v0' },
    });
    assert.equal(calls, 1);
  }
  const badJson = new BangumiQueries(new BangumiClient(async () => new Response('<html>blocked</html>'), 0));
  await assert.rejects(badJson.character(1), { code: 'BANGUMI_SCHEMA' });
  const network = new BangumiQueries(
    new BangumiClient(async () => {
      throw Error('network');
    }, 0),
  );
  await assert.rejects(network.character(1), { code: 'BANGUMI_NETWORK' });
  const malformed = new BangumiQueries(
    new BangumiClient(async () => Response.json({ data: [{ ...relation(1), relation: {} }], total: 1 }), 0),
  );
  await assert.rejects(malformed.relations(1, 1, 30), { code: 'BANGUMI_SCHEMA' });
  const plain = new BangumiQueries(
    new BangumiClient(async () => Response.json({ id: 1, name: '无头像', images: null, infobox: null }), 0),
  );
  assert.equal((await plain.character(1)).data.avatar, null);
});
