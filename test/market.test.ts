import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../src/api/client.js';
import { Queries } from '../src/services/queries.js';
import { buildTools, invoke } from '../src/tools.js';
import { fixture } from './helpers.js';
test('top week uses entire board score base before filtering and keeps server rank distinct from tower rank', async () => {
  const f = await fixture();
  const rows = [
    {
      CharacterId: 10,
      CharacterName: '空鱼',
      CharacterLevel: 8,
      Type: 2,
      Assets: 100,
      Sacrifices: 20,
      Price: 10,
      Extra: 1000,
      CharacterRank: 99,
    },
    {
      CharacterId: 11,
      CharacterName: '角色乙',
      CharacterLevel: 2,
      Type: 1,
      Assets: 0,
      Sacrifices: 0,
      Price: 10,
      Extra: 2000,
      CharacterRank: 1,
    },
  ];
  const q = new Queries(
    new ApiClient(
      f.session,
      async () => Response.json({ State: 0, Value: rows }),
      'https://tinygrail.com/api/',
      0,
    ),
  );
  const r = await q.topWeek('空鱼', undefined, true);
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.totalItems, 2);
  const item = r.data.items[0];
  assert.equal(item.rank, 1);
  assert.equal(item.estimatedScore, '30');
  assert.equal(item.estimatedAveragePrice, '12.00');
  assert.equal(item.server.CharacterRank, '99');
  assert.equal((await q.topWeek(undefined, 11)).data.items[0].estimatedAveragePrice, '0.00');
});
test('historical ranks come from Level and pagination survives sorting mixed periods', async () => {
  const f = await fixture();
  const q = new Queries(
    new ApiClient(
      f.session,
      async () =>
        Response.json({
          State: 0,
          Value: {
            CurrentPage: 2,
            ItemsPerPage: 3,
            TotalPages: 10,
            TotalItems: 30,
            Items: [
              {
                CharacterId: 10,
                Name: '空鱼',
                Level: 12,
                CharacterLevel: 7,
                Assets: 5,
                Create: '2026-10-18',
              },
              {
                CharacterId: 20,
                Name: '角色乙',
                Level: 1,
                CharacterLevel: 8,
                Assets: 6,
                Create: '2026-10-18',
              },
              {
                CharacterId: 30,
                Name: '角色丙',
                Level: 1,
                CharacterLevel: 9,
                Assets: 7,
                Create: '2026-10-11',
              },
            ],
          },
        }),
      'https://tinygrail.com/api/',
      0,
    ),
  );
  const r = await q.topWeekHistory(2, 3);
  assert.deepEqual(
    r.data.items.map((v: any) => v.characterId),
    [20, 10, 30],
  );
  assert.equal(r.data.items[0].rank, 1);
  assert.equal(r.data.items[0].level, 8);
  assert.equal(r.data.items[0].bidders, '6');
  assert.equal(r.data.pagination.hasMore, true);
  assert.equal(r.data.pagination.totalItems, 30);
});
test('ST uses POST query; user filters retain native query parameters; malformed magic fails before reads', async () => {
  const f = await fixture();
  const requests: any[] = [];
  const api = new ApiClient(
    f.session,
    async (input, init) => {
      requests.push({ url: new URL(String(input)), init });
      if (String(input).includes('chara/user/assets')) return Response.json({ State: 0, Value: f.account });
      return Response.json({
        State: 0,
        Value: { CurrentPage: 1, ItemsPerPage: 3, TotalItems: 0, TotalPages: 0, Items: null },
      });
    },
    'https://tinygrail.com/api/',
    0,
  );
  const tools = buildTools(new Queries(api), f.safety, async () => ({}));
  await invoke(tools, 'list_market', { category: 'st', pageSize: 3 });
  assert.equal(requests[0].init.method, 'POST');
  await invoke(tools, 'list_user_assets', {
    category: 'temples',
    keyword: '空鱼',
    characterIds: [10],
    pageSize: 3,
  });
  assert.equal(requests.at(-1).url.searchParams.get('keyword'), '空鱼');
  assert.equal(requests.at(-1).url.searchParams.get('characterIds'), '10');
  const count = requests.length;
  await assert.rejects(
    invoke(tools, 'prepare_magic', {
      characterId: 1,
      requestId: 'invalid-magic',
      operation: { action: 'guidepost' },
    }),
    { code: 'INVALID_INPUT' },
  );
  assert.equal(requests.length, count);
  assert.equal(f.writes.length, 0);
});
