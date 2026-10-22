import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Safety, actions } from '../src/safety/engine.js';
import { atomicJson } from '../src/core.js';
import { fixture } from './helpers.js';
import { isGameAction } from '../src/safety/game-actions.js';

test('prepare is immutable, idempotent and cannot write without local approval; double approval dispatches once', async () => {
  const f = await fixture();
  const args = { characterId: 1, price: '10.01', amount: 2, requestId: 'request-0001' };
  const p = await f.safety.prepare('buy', args);
  assert.equal(f.writes.length, 0);
  p.terms.args.amount = 999;
  const again = await f.safety.prepare('buy', args);
  assert.equal(again.terms.args.amount, 2);
  assert.equal(again.id, p.id);
  await assert.rejects(f.safety.prepare('buy', { ...args, amount: 3 }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.safety.approve(again.id, again.fingerprint), { code: 'WRITE_DISABLED' });
  await f.enable();
  const receipts = await Promise.all([
    f.safety.approve(again.id, again.fingerprint),
    f.safety.approve(again.id, again.fingerprint),
  ]);
  assert.equal(f.writes.length, 1);
  assert.equal(receipts[0].status, 'executed');
  assert.equal(receipts[1].status, 'executed');
  assert.equal(f.writes[0], 'chara/bid/1/10.01/2');
});
test('account boundaries, changed state, wrong fingerprint and expiry prevent dispatch', async () => {
  const f = await fixture();
  await f.enable();
  const a = { characterId: 1, price: '10', amount: 2, requestId: 'request-0002' };
  const p = await f.safety.prepare('buy', a);
  await assert.rejects(f.safety.approve(p.id, '0'.repeat(64)), { code: 'PLAN_CHANGED' });
  f.account.Balance = '99999';
  await assert.rejects(f.safety.approve(p.id, p.fingerprint), { code: 'STATE_CHANGED' });
  assert.equal(f.writes.length, 0);
  const p2 = await f.safety.prepare('buy', { ...a, requestId: 'request-0003' });
  f.session.epoch = 'another-session';
  await assert.rejects(f.safety.approve(p2.id, p2.fingerprint), { code: 'ACCOUNT_CHANGED' });
  assert.equal(f.writes.length, 0);
  const future = new Safety(f.q, f.dir, () => Date.now() + 300000);
  await future.init();
  await future.policy({
    enabled: true,
    allowedActions: ['buy'],
    perTrade: '1000',
    daily: '5000',
    maxShares: 100,
    acknowledgeUnverified: true,
  });
  assert.equal(future.list().find((v) => v.id === p2.id)?.status, 'expired');
});
test('lost write response is outcome_unknown; repeated approval/restart never repeats the POST', async () => {
  const f = await fixture();
  await f.enable();
  f.flags.unknown = true;
  const p = await f.safety.prepare('buy', {
    characterId: 1,
    price: '10',
    amount: 2,
    requestId: 'request-0004',
  });
  const r = await f.safety.approve(p.id, p.fingerprint);
  assert.equal(r.status, 'outcome_unknown');
  assert.equal(f.writes.length, 1);
  await f.safety.approve(p.id, p.fingerprint);
  assert.equal(f.writes.length, 1);
  await assert.rejects(
    f.safety.prepare('buy', { characterId: 1, price: '10', amount: 2, requestId: 'request-new1' }),
    { code: 'UNKNOWN_BLOCK' },
  );
  const recovered = new Safety(f.q, f.dir);
  await recovered.init();
  assert.equal(recovered.status().policy.enabled, false);
  assert.equal(recovered.list()[0]?.status, 'outcome_unknown');
  await recovered.approve(p.id, p.fingerprint);
  assert.equal(f.writes.length, 1);
  assert.equal(
    (await recovered.acknowledgeUnknown(p.id, '已经在游戏核对该买入委托确实存在')).status,
    'outcome_unknown',
  );
});
test('durable dispatch marker recovers as unknown; tampering fails closed', async () => {
  const f = await fixture();
  const p = await f.safety.prepare('buy', {
    characterId: 1,
    price: '10',
    amount: 2,
    requestId: 'request-crash',
  });
  const path = join(f.dir, 'ledger.json'),
    data = JSON.parse(await readFile(path, 'utf8'));
  data.plans[0].status = 'dispatching';
  await atomicJson(path, data);
  const recovered = new Safety(f.q, f.dir);
  await recovered.init();
  assert.equal(recovered.list()[0]?.status, 'outcome_unknown');
  assert.equal(f.writes.length, 0);
  data.plans[0].terms.args.amount = 99;
  await atomicJson(path, data);
  await assert.rejects(new Safety(f.q, f.dir).init(), { code: 'LEDGER' });
});
test('limits include previous dispatches, emergency stop invalidates pending plans', async () => {
  const f = await fixture();
  await f.safety.policy({
    enabled: true,
    allowedActions: ['buy'],
    perTrade: '30',
    daily: '30',
    maxShares: 2,
    acknowledgeUnverified: true,
  });
  const p = await f.safety.prepare('buy', {
    characterId: 1,
    price: '10',
    amount: 2,
    requestId: 'request-limit1',
  });
  await f.safety.approve(p.id, p.fingerprint);
  const p2 = await f.safety.prepare('buy', {
    characterId: 1,
    price: '10',
    amount: 2,
    requestId: 'request-limit2',
  });
  await assert.rejects(f.safety.approve(p2.id, p2.fingerprint), { code: 'DAILY_LIMIT' });
  await f.safety.stop();
  assert.equal((await f.safety.get(p2.id)).status, 'invalidated');
  assert.equal(f.writes.length, 1);
});
test('each supported action has a concrete bounded adapter and post-dispatch read reconciliation', async () => {
  for (const action of actions.filter((a) => !isGameAction(a))) {
    const f = await fixture();
    await f.enable();
    let args: any = { characterId: 1, requestId: `request-${action}`, amount: 2, price: '10' };
    if (action === 'cancel_order') {
      f.trading.Bids = [{ Id: 42, CharacterId: 1, UserId: 123, Price: 10, Amount: 2 }];
      args = { characterId: 1, requestId: 'request-cancel', side: 'buy', orderId: 42 };
    }
    if (action === 'auction_cancel') {
      const bid = await f.safety.prepare('auction_bid', {
        characterId: 1,
        requestId: 'request-auction-initial',
        amount: 2,
        price: '10',
      });
      await f.safety.approve(bid.id, bid.fingerprint);
      args = { characterId: 1, requestId: 'request-cancel-auction', auctionId: 501 };
    }
    if (action === 'ico_invest') {
      delete f.chara.Current;
      f.chara.Id = 9;
      f.chara.End = '2099-01-01T00:00:00+08:00';
      f.chara.Total = '1000000';
      f.chara.Users = 20;
      args.amount = '100';
    }
    const p = await f.safety.prepare(action, args),
      before = f.writes.length;
    const r = await f.safety.approve(p.id, p.fingerprint);
    assert.equal(f.writes.length, before + 1, action);
    assert.equal(r.status, 'executed', action);
    assert.ok(r.receipt.verified, action);
  }
});
test('server business rejection is final and never retried', async () => {
  const f = await fixture();
  await f.enable();
  f.flags.rejected = true;
  const p = await f.safety.prepare('sell', {
    characterId: 1,
    price: '10',
    amount: 2,
    requestId: 'request-reject',
  });
  assert.equal((await f.safety.approve(p.id, p.fingerprint)).status, 'rejected');
  await f.safety.approve(p.id, p.fingerprint);
  assert.equal(f.writes.length, 1);
});
test('iceberg orders retain their route flag and are verified against own order type', async () => {
  for (const action of ['buy', 'sell'] as const) {
    const f = await fixture();
    await f.enable();
    const p = await f.safety.prepare(action, {
      characterId: 1,
      requestId: `iceberg-${action}`,
      price: '10',
      amount: 2,
      iceberg: true,
    });
    assert.equal((await f.safety.approve(p.id, p.fingerprint)).status, 'executed');
    assert.equal(f.writes[0], `chara/${action === 'buy' ? 'bid' : 'ask'}/1/10/2/true`);
  }
});
