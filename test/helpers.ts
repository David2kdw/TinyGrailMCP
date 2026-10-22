import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../src/api/client.js';
import { Session } from '../src/auth/session.js';
import { Vault } from '../src/auth/vault.js';
import { Queries } from '../src/services/queries.js';
import { Safety, actions } from '../src/safety/engine.js';

export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'tinygrail-test-'));
  const vault = new Vault(dir);
  vault.set = async () => {};
  vault.get = async () => undefined;
  vault.remove = async () => {};
  const session = new Session(vault);
  session.account = '123';
  session.state = 'authenticated';
  await session.jar.setCookie(
    '.AspNetCore.Identity.Application=FAKE_ONLY; Secure; HttpOnly; Path=/',
    'https://tinygrail.com/',
  );
  const account: any = {
    Id: 123,
    Name: 'fixture_user',
    Nickname: '测试账号',
    Balance: '1000000.123456',
    Assets: '1200000.123456',
  };
  const chara: any = {
    Id: 1,
    CharacterId: 1,
    Name: '测试角色',
    Current: '10',
    Price: '10',
    Level: 2,
    State: 0,
    Sacrifices: 5000,
  };
  const trading: any = {
    Id: 123,
    Balance: account.Balance,
    Amount: 1000,
    Sacrifices: 3000,
    Bids: [],
    Asks: [],
    BidHistory: [],
    AskHistory: [],
  };
  const temple: any = {
    Id: 101,
    UserId: 123,
    CharacterId: 1,
    Assets: 3000,
    Sacrifices: 3000,
    StarForces: 0,
    Refine: 0,
    CharacterRank: 1,
    CharacterLevel: 2,
    CharacterStars: 1,
    Rate: '10',
  };
  let auction: any[] = [],
    investment = 1000,
    unknown = false,
    rejected = false,
    malformed = false,
    authExpired = false;
  let permissionDenied = false;
  const writes: string[] = [],
    reads: string[] = [];
  const page = (items: any[]) => ({
    CurrentPage: 1,
    TotalPages: items.length ? 1 : 0,
    TotalItems: items.length,
    ItemsPerPage: 30,
    Items: items,
  });
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname.replace('/api/', '');
    const write =
      /^(?:chara\/(?:bid|ask|sacrifice|join|star|auction\/(?:cancel|1\/))|magic\/refine)/.test(path) &&
      path !== 'chara/auction/list';
    let value: any;
    if (write) {
      writes.push(path);
      const parts = path.split('/');
      if (rejected) return Response.json({ State: 1, Message: 'fixture reject' });
      if (path.startsWith('chara/bid/cancel')) trading.Bids = [];
      else if (path.startsWith('chara/ask/cancel')) trading.Asks = [];
      else if (path.startsWith('chara/bid/')) {
        const n = Number(parts[4]);
        trading.Bids.push({
          Id: 500 + writes.length,
          CharacterId: 1,
          UserId: 123,
          Price: parts[3],
          Amount: n,
          Type: parts[5] === 'true' ? 1 : 0,
        });
      } else if (path.startsWith('chara/ask/')) {
        const n = Number(parts[4]);
        trading.Asks.push({
          Id: 500 + writes.length,
          CharacterId: 1,
          UserId: 123,
          Price: parts[3],
          Amount: n,
          Type: parts[5] === 'true' ? 1 : 0,
        });
        trading.Amount -= n;
      } else if (path.startsWith('chara/auction/cancel/')) auction = [];
      else if (path.startsWith('chara/auction/'))
        auction = [{ Id: 501, CharacterId: 1, Price: parts[3], Amount: parts[4], State: 1, Type: parts[4] }];
      else if (path.startsWith('chara/join/')) investment += Number(parts[3]);
      else if (path.startsWith('chara/sacrifice/')) {
        trading.Amount -= Number(parts[3]);
        temple.Assets += Number(parts[3]) * 2;
      } else if (path.startsWith('chara/star/')) {
        temple.Assets -= Number(parts[3]);
        temple.StarForces += Number(parts[3]);
      } else if (path.startsWith('magic/refine/')) {
        temple.Refine++;
        temple.Assets--;
      }
      value = 'fixture accepted';
      if (unknown) throw new Error('simulated lost response after side effect');
    } else {
      reads.push(path);
      if (path === 'chara/user/assets') {
        if (authExpired) return Response.json({ State: 1, Message: 'unauthorized' });
        value = account;
      } else if (permissionDenied && path === 'chara/user/1')
        return Response.json({ State: 1, Message: '没有权限' });
      else if (path.startsWith('chara/charts/')) value = [];
      else if (path === 'chara/1') value = chara;
      else if (path === 'chara/user/1') value = trading;
      else if (path.includes('/tinygrail/false')) value = { Amount: 1000, Price: 10 };
      else if (path.startsWith('chara/user/temple/')) value = page([temple]);
      else if (path === 'chara/auction/list') value = auction;
      else if (path.startsWith('chara/initial/')) value = { Amount: investment };
      else if (path.startsWith('chara/user/chara/'))
        value = page([
          {
            Id: 1,
            CharacterId: 1,
            UserTotal: 1000,
            UserAmount: 1000,
            Current: '10',
            Price: 2,
            SellerIp: 'NEVER_EXPORT',
            Token: 'NEVER_EXPORT',
          },
        ]);
      else value = page([]);
    }
    return Response.json(malformed ? { Value: value } : { State: 0, Value: value }, {
      headers: { Date: 'Thu, 22 Oct 2026 12:00:00 GMT' },
    });
  };
  const api = new ApiClient(session, fakeFetch, 'https://tinygrail.com/api/', 0),
    q = new Queries(api),
    safety = new Safety(q, dir);
  await safety.init();
  return {
    dir,
    vault,
    session,
    account,
    chara,
    trading,
    temple,
    api,
    q,
    safety,
    writes,
    reads,
    fakeFetch,
    flags: {
      set permissionDenied(v: boolean) {
        permissionDenied = v;
      },
      set unknown(v: boolean) {
        unknown = v;
      },
      set rejected(v: boolean) {
        rejected = v;
      },
      set malformed(v: boolean) {
        malformed = v;
      },
      set authExpired(v: boolean) {
        authExpired = v;
      },
    },
    enable: () =>
      safety.policy({
        enabled: true,
        allowedActions: [...actions],
        perTrade: '100000',
        daily: '500000',
        maxShares: 1000,
        acknowledgeUnverified: true,
      }),
  };
}
