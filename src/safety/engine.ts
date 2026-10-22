import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as z from 'zod/v4';
import {
  AppError,
  atomicJson,
  DATA,
  fingerprint,
  Mutex,
  object,
  pick,
  publicError,
  readJson,
} from '../core.js';
import { D, decimal } from '../calculations.js';
import { safeData } from '../models.js';
import type { Queries } from '../services/queries.js';
import {
  gameActions,
  gameLabels,
  isGameAction,
  gamePreflight,
  gameSnapshot,
  gameRequest,
  gameReconcile,
  imageData,
} from './game-actions.js';

export const actions = [
  'buy',
  'sell',
  'cancel_order',
  'auction_bid',
  'auction_cancel',
  'ico_invest',
  'sacrifice',
  'financing',
  'star',
  'refine',
  ...gameActions,
] as const;
export type Action = (typeof actions)[number];
export const actionLabels: Record<Action, string> = {
  ...gameLabels,
  buy: '限价买入',
  sell: '限价卖出',
  cancel_order: '撤销委托',
  auction_bid: '拍卖竞价',
  auction_cancel: '撤销竞价',
  ico_invest: 'ICO 投资',
  sacrifice: '献祭活股',
  financing: '股权融资',
  star: '转换星之力',
  refine: '精炼圣殿',
};
export const policySchema = z
  .object({
    enabled: z.boolean(),
    allowedActions: z.array(z.enum(actions)).max(actions.length),
    perTrade: z.string().regex(/^[1-9]\d{0,11}(?:\.\d{1,6})?$/),
    daily: z.string().regex(/^[1-9]\d{0,11}(?:\.\d{1,6})?$/),
    maxShares: z.number().int().min(1).max(100000000),
    acknowledgeUnverified: z.boolean(),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;
export const defaultPolicy: Policy = {
  enabled: false,
  allowedActions: [],
  perTrade: '1000',
  daily: '5000',
  maxShares: 100,
  acknowledgeUnverified: false,
};
interface Snapshot {
  account: string;
  name: string;
  balance: string;
  available?: string;
  character: Record<string, any>;
  trading?: any;
  temple?: any;
  auction?: any;
  ownAuction?: any;
  icoInvestment?: any;
  game?: any;
}
interface Terms {
  account: string;
  epoch: string;
  action: Action;
  args: Record<string, any>;
  createdAt: string;
  expiresAt: string;
  riskValue: string;
  cashPrincipal: string;
  snapshot: Snapshot;
  warnings?: string[];
}
export interface Plan {
  id: string;
  terms: Terms;
  fingerprint: string;
  status: 'pending' | 'dispatching' | 'executed' | 'rejected' | 'expired' | 'invalidated' | 'outcome_unknown';
  receipt?: any;
  approvedAt?: string;
  dispatchedAt?: string;
  resolvedAt?: string;
  resolutionNote?: string;
}
interface Ledger {
  version: number;
  policy: Policy;
  plans: Plan[];
}
const day = (time: string) => new Date(time).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const keyFields = [
  'Id',
  'CharacterId',
  'Name',
  'Current',
  'Total',
  'Users',
  'End',
  'State',
  'Sacrifices',
  'StarForces',
  'Level',
  'Price',
  'Rate',
];
function allList(v: any) {
  const list = Array.isArray(v) ? v : object(v).Items;
  if (!Array.isArray(list)) throw new AppError('SCHEMA', '列表结构发生变化。');
  return list;
}
export class Safety {
  private ledger: Ledger = { version: 1, policy: { ...defaultPolicy }, plans: [] };
  private disk = new Mutex();
  readonly mutex = new Mutex();
  executing = false;
  faulted = false;
  constructor(
    private q: Queries,
    private dir = DATA,
    private now = () => Date.now(),
  ) {}
  private get file() {
    return join(this.dir, 'ledger.json');
  }
  async init() {
    this.ledger = await readJson<Ledger>(this.file, this.ledger);
    if (this.ledger.version !== 1 || !Array.isArray(this.ledger.plans))
      throw new AppError('LEDGER', '交易账本格式不兼容。');
    this.ledger.policy = policySchema.parse(this.ledger.policy);
    this.ledger.policy.enabled = false;
    for (const p of this.ledger.plans) {
      if (fingerprint(p.terms) !== p.fingerprint)
        throw new AppError('LEDGER', '交易计划指纹不一致，禁止启动写操作。');
      if (p.status === 'dispatching') {
        p.status = 'outcome_unknown';
        p.receipt = {
          error: { code: 'CRASH_RECOVERY', message: '写请求发出期间程序终止，结果未知，禁止重试。' },
        };
      }
      if (p.status === 'pending' && Date.parse(p.terms.expiresAt) <= this.now()) p.status = 'expired';
    }
    await this.persist();
  }
  private async persist() {
    return this.disk.run(async () => {
      try {
        await atomicJson(this.file, this.ledger);
      } catch (e) {
        this.faulted = true;
        this.ledger.policy.enabled = false;
        throw new AppError('LEDGER_IO', '无法持久化账本，已关闭写操作。');
      }
    });
  }
  status() {
    return {
      policy: structuredClone(this.ledger.policy),
      executing: this.executing,
      faulted: this.faulted,
      pending: this.ledger.plans.filter(
        (p) => p.status === 'pending' && Date.parse(p.terms.expiresAt) > this.now(),
      ).length,
      unknown: this.ledger.plans.filter((p) => p.status === 'outcome_unknown' && !p.resolvedAt).length,
      liveWriteVerified: false,
    };
  }
  async policy(value: unknown) {
    return this.mutex.run(async () => {
      const policy = policySchema.parse(value);
      if (policy.enabled && (!policy.acknowledgeUnverified || !policy.allowedActions.length))
        throw new AppError('ACK_REQUIRED', '请明确选择动作，并确认这些写入尚未经过真实账户验收。');
      if (D(policy.daily).lt(policy.perTrade)) throw new AppError('LIMIT', '每日额度不能低于单次额度。');
      this.ledger.policy = policy;
      await this.persist();
      return this.status();
    });
  }
  // No mutex: a stop takes effect even while approval is waiting for fresh server data.
  async stop() {
    this.ledger.policy.enabled = false;
    for (const p of this.ledger.plans) if (p.status === 'pending') p.status = 'invalidated';
    await this.persist();
    return this.status();
  }
  async invalidate() {
    await this.stop();
  }
  list() {
    return this.ledger.plans
      .slice(-100)
      .reverse()
      .map((p) => this.display(p));
  }
  private display(p: Plan) {
    const copy = structuredClone(p);
    for (const snapshot of [copy.terms.snapshot, copy.receipt?.after]) {
      const holdings = snapshot?.game?.holdings;
      if (holdings) {
        snapshot.game.holdingsAudit = {
          characters: Object.keys(holdings).length,
          fingerprint: fingerprint(holdings),
        };
        delete snapshot.game.holdings;
      }
    }
    if (copy.terms.action === 'image_upload') {
      const data = imageData(copy.terms.args);
      delete copy.terms.args.imageBase64;
      copy.terms.args.image = { bytes: data.bytes.length, hash: data.hash, url: data.url };
    }
    if (copy.status === 'pending' && Date.parse(copy.terms.expiresAt) <= this.now()) copy.status = 'expired';
    return copy;
  }
  async get(id: string) {
    const p = this.find(id);
    if (p.terms.epoch !== this.q.api.session.epoch || p.terms.account !== this.q.api.session.account)
      throw new AppError('ACCOUNT_CHANGED', '此计划不属于当前登录会话。');
    return this.display(p);
  }
  async previewImage(id: string) {
    await this.get(id); // Same account and epoch boundary as the plan viewer.
    const p = this.find(id);
    if (p.terms.action !== 'image_upload') throw new AppError('IMAGE', '此计划没有图片。');
    return { bytes: imageData(p.terms.args).bytes, mime: p.terms.args.mime };
  }
  private find(id: string) {
    const p = this.ledger.plans.find((p) => p.id === id);
    if (!p) throw new AppError('PLAN_NOT_FOUND', '未找到交易计划。');
    return p;
  }
  async prepare(action: Action, args: Record<string, any>) {
    return this.mutex.run(async () => {
      const epoch = this.q.api.session.epoch;
      const repeated = this.ledger.plans.find(
        (p) => p.terms.epoch === epoch && p.terms.args.requestId === args.requestId,
      );
      if (repeated) {
        if (repeated.terms.action !== action || fingerprint(repeated.terms.args) !== fingerprint(args))
          throw new AppError('IDEMPOTENCY_CONFLICT', '同一 requestId 的交易参数不能改变。');
        return this.display(repeated);
      }
      if (
        this.ledger.plans.length >= 10000 ||
        this.ledger.plans.filter((p) => p.status === 'pending').length >= 50
      )
        throw new AppError('PLAN_LIMIT', '计划数量已达上限，请先处理现有计划。');
      if (this.ledger.plans.some((p) => p.status === 'outcome_unknown' && !p.resolvedAt))
        throw new AppError('UNKNOWN_BLOCK', '存在结果未知的写请求，请先在本地核对。');
      const { snapshot, cash, risk, warnings } = await this.preflight(action, args);
      if (epoch !== this.q.api.session.epoch) throw new AppError('SESSION_CHANGED', '登录会话发生变更。');
      const terms: Terms = {
        account: snapshot.account,
        epoch,
        action,
        args: structuredClone(args),
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + 120000).toISOString(),
        riskValue: risk,
        cashPrincipal: cash,
        snapshot,
        ...(warnings.length ? { warnings } : {}),
      };
      const same = this.ledger.plans.find(
        (p) =>
          p.status === 'pending' &&
          p.terms.epoch === epoch &&
          p.terms.action === action &&
          fingerprint({ ...p.terms.args, requestId: '' }) === fingerprint({ ...args, requestId: '' }) &&
          Date.parse(p.terms.expiresAt) > this.now(),
      );
      if (same) return this.display(same);
      const p: Plan = { id: randomUUID(), terms, fingerprint: fingerprint(terms), status: 'pending' };
      this.ledger.plans.push(p);
      await this.persist();
      return this.display(p);
    });
  }
  private limits(p: Plan) {
    const policy = this.ledger.policy;
    if (!policy.enabled || this.faulted || !policy.allowedActions.includes(p.terms.action))
      throw new AppError('WRITE_DISABLED', '当前动作的真实写权限已关闭。');
    if (p.terms.epoch !== this.q.api.session.epoch || p.terms.account !== this.q.api.session.account)
      throw new AppError('ACCOUNT_CHANGED', '计划已跨越账号或登录会话边界。');
    if (Date.parse(p.terms.expiresAt) <= this.now())
      throw new AppError('PLAN_EXPIRED', '计划已过期，请重新准备。');
    if (fingerprint(p.terms) !== p.fingerprint)
      throw new AppError('PLAN_CHANGED', '计划内容与批准指纹不一致。');
    if (this.ledger.plans.some((x) => x.status === 'outcome_unknown' && !x.resolvedAt))
      throw new AppError('UNKNOWN_BLOCK', '结果未知的请求阻止继续交易。');
    const cancelOrder =
      p.terms.action === 'cancel_order'
        ? (p.terms.args.side === 'buy' ? p.terms.snapshot.trading.Bids : p.terms.snapshot.trading.Asks).find(
            (v: any) => Number(v.Id) === p.terms.args.orderId,
          )
        : undefined;
    const shares = ['chaos', 'guidepost', 'fisheye', 'starbreak'].includes(p.terms.action)
      ? p.terms.action === 'chaos'
        ? 10
        : 100
      : p.terms.action === 'temple_destroy'
        ? Number(p.terms.snapshot.game.temple.Assets)
        : typeof p.terms.args.amount === 'number'
          ? p.terms.args.amount
          : p.terms.action === 'refine'
            ? 1
            : p.terms.action === 'auction_cancel'
              ? Number(p.terms.snapshot.ownAuction.Amount)
              : Number(cancelOrder?.Amount ?? 0);
    if (shares > policy.maxShares || D(p.terms.riskValue).gt(policy.perTrade))
      throw new AppError('LIMIT', '超过单次金额或股数限制。');
    const consumed = this.ledger.plans
      .filter(
        (x) =>
          x.id !== p.id && x.dispatchedAt && day(x.dispatchedAt) === day(new Date(this.now()).toISOString()),
      )
      .reduce((sum, x) => sum.plus(x.terms.riskValue), D(0));
    if (consumed.plus(p.terms.riskValue).gt(policy.daily))
      throw new AppError('DAILY_LIMIT', '超过今日风险额度（含已发出及结果未知请求）。');
  }
  // Called only by authenticated local admin route. There is deliberately no MCP commit/approve tool.
  async approve(id: string, expectedFingerprint: string) {
    return this.mutex.run(async () => {
      const p = this.find(id);
      if (p.status !== 'pending') return this.display(p);
      if (expectedFingerprint !== p.fingerprint)
        throw new AppError('PLAN_CHANGED', '本地展示的计划已经改变。');
      this.limits(p);
      this.executing = true;
      try {
        const fresh = await this.preflight(p.terms.action, p.terms.args);
        if (fingerprint(fresh.snapshot) !== fingerprint(p.terms.snapshot)) {
          p.status = 'invalidated';
          await this.persist();
          throw new AppError('STATE_CHANGED', '账户、持仓或市场状态已变化，旧计划已失效，请重新准备。');
        }
        this.limits(p); // Includes emergency stop and expiry after network awaits.
        p.status = 'dispatching';
        p.approvedAt = new Date(this.now()).toISOString();
        p.dispatchedAt = p.approvedAt;
        await this.persist(); // Durable intent before the first and only write dispatch.
        try {
          let request;
          if (p.terms.action === 'image_upload') {
            const data = imageData(p.terms.args);
            const url = await this.q.api.uploadImage(
              p.terms.args.kind,
              data.hash,
              p.terms.args.mime,
              data.bytes,
              () => this.limits(p),
            );
            request = {
              path: `chara/${p.terms.args.kind === 'cover' ? 'temple/cover' : 'avatar'}/${p.terms.args.characterId}`,
              body: url,
            };
          } else
            request = isGameAction(p.terms.action)
              ? gameRequest(p.terms.action, p.terms.args, p.terms.snapshot)
              : { path: this.writePath(p) };
          const response = await this.q.api.write(request.path, () => this.limits(p), request);
          p.receipt = {
            serverAcknowledged: true,
            response: safeData(response.value),
            observedAt: response.observedAt,
          };
          try {
            const after =
              p.terms.action === 'remote_logout'
                ? {
                    ...p.terms.snapshot,
                    game: {
                      loggedOut:
                        !(await this.q.api.session.cookie()) || (await this.q.sessionStatus()).requiresLogin,
                    },
                  }
                : await this.preflightSnapshot(p.terms.action, p.terms.args);
            const verified = this.reconcile(p, after);
            p.status = verified ? 'executed' : 'outcome_unknown';
            if (p.terms.action === 'remote_logout' && verified) {
              this.ledger.policy.enabled = false;
              await this.q.api.session.logout();
            }
            p.receipt = {
              ...p.receipt,
              verified,
              after,
              ...(!verified ? { note: '服务器已应答，尚无法核实资产变化；请在本地对账，禁止重试。' } : {}),
            };
          } catch (e) {
            p.status = 'outcome_unknown';
            p.receipt.verificationError = publicError(e);
          }
        } catch (e) {
          p.status =
            e instanceof AppError && e.code === 'API_REJECTED'
              ? 'rejected'
              : e instanceof AppError && e.code === 'NOT_DISPATCHED'
                ? 'invalidated'
                : 'outcome_unknown';
          p.receipt = { error: publicError(e), retryAllowed: false };
        }
        await this.persist();
        return this.display(p);
      } finally {
        this.executing = false;
      }
    });
  }
  async reject(id: string) {
    return this.mutex.run(async () => {
      const p = this.find(id);
      if (p.status === 'pending') {
        p.status = 'rejected';
        await this.persist();
      }
      return this.display(p);
    });
  }
  async acknowledgeUnknown(id: string, note: string) {
    return this.mutex.run(async () => {
      const p = this.find(id);
      if (p.status !== 'outcome_unknown' || note.trim().length < 12)
        throw new AppError('RECONCILE', '请核对服务器订单和资产，并填写至少 12 字的核对说明。');
      p.resolvedAt = new Date(this.now()).toISOString();
      p.resolutionNote = note.slice(0, 1000);
      await this.persist();
      return this.display(p);
    });
  }
  private async preflightSnapshot(action: Action, a: Record<string, any>): Promise<Snapshot> {
    if (isGameAction(action)) return gameSnapshot(this.q, action, a);
    const profile = (await this.q.account()).value;
    const chara = object((await this.q.api.read({ path: `chara/${a.characterId}` })).value);
    const s: Snapshot = {
      account: String(profile.Id),
      name: String(profile.Name),
      balance: decimal(profile.Balance).toFixed(),
      character: pick(chara, keyFields),
    };
    if (action !== 'ico_invest') {
      const t = object((await this.q.api.read({ path: `chara/user/${a.characterId}`, auth: true })).value);
      if (String(t.Id) !== s.account) throw new AppError('ACCOUNT_CHANGED', '角色交易资料账号不匹配。');
      if (!Array.isArray(t.Asks) || !Array.isArray(t.Bids))
        throw new AppError('SCHEMA', '交易资料缺少订单。');
      s.available = decimal(t.Amount).toFixed();
      s.trading = pick(t, ['Amount', 'Sacrifices', 'Asks', 'Bids', 'AskHistory', 'BidHistory']);
      // Drop IP fields from the durable plan too.
      s.trading = safeData(s.trading);
    }
    if (['sacrifice', 'financing', 'star', 'refine'].includes(action)) {
      const value = (
        await this.q.api.read({
          path: `chara/user/temple/${encodeURIComponent(s.name)}/1/2?characterIds=${a.characterId}`,
          auth: true,
        })
      ).value;
      s.temple = allList(value).find((v: any) => Number(v.CharacterId) === a.characterId);
      s.temple = s.temple
        ? pick(s.temple, [
            'Id',
            'UserId',
            'CharacterId',
            'Assets',
            'Sacrifices',
            'Level',
            'Refine',
            'StarForces',
          ])
        : null;
    }
    if (action === 'auction_bid' || action === 'auction_cancel') {
      s.auction = safeData(
        (
          await this.q.api.read({
            path: 'chara/auction/list',
            method: 'POST',
            body: [a.characterId],
            auth: true,
          })
        ).value,
      );
      const list = allList(s.auction);
      s.ownAuction = list.find((v: any) => Number(v.CharacterId) === a.characterId) ?? null;
      if (action === 'auction_bid') {
        const pool = object(
          (await this.q.api.read({ path: `chara/user/${a.characterId}/tinygrail/false` })).value,
        );
        s.character.pool = pick(pool, ['Amount', 'Price', 'Rate', 'Sacrifices']);
      }
    }
    if (action === 'ico_invest') {
      try {
        s.icoInvestment = safeData(
          (await this.q.api.read({ path: `chara/initial/${chara.Id}`, auth: true })).value,
        );
      } catch (e) {
        if (e instanceof AppError && e.code === 'API_REJECTED')
          s.icoInvestment = { participationUnavailable: true };
        else throw e;
      }
    }
    return s;
  }
  private async preflight(action: Action, a: Record<string, any>) {
    if (isGameAction(action)) return gamePreflight(this.q, action, a);
    const s = await this.preflightSnapshot(action, a);
    let cash = D(0),
      risk = D(0);
    const warnings: string[] = [];
    if (
      ['buy', 'sell', 'sacrifice', 'financing', 'star', 'refine', 'auction_bid'].includes(action) &&
      s.character.Current === undefined
    )
      throw new AppError('NOT_LISTED', '角色未上市，不能执行此动作。');
    if (['buy', 'sell', 'auction_bid'].includes(action)) {
      risk = decimal(a.price).mul(decimal(a.amount));
      if (action !== 'sell') cash = risk;
    }
    if (['sell', 'sacrifice', 'financing'].includes(action) && decimal(a.amount).gt(decimal(s.available)))
      throw new AppError('SHARES', '可用活股不足。');
    if (['sacrifice', 'financing', 'star'].includes(action))
      risk = decimal(s.character.Current).mul(decimal(a.amount));
    if (action === 'cancel_order') {
      const list = a.side === 'buy' ? s.trading.Bids : s.trading.Asks;
      const order = list.find(
        (v: any) =>
          Number(v.Id) === a.orderId && Number(v.CharacterId) === a.characterId && decimal(v.Amount).gt(0),
      );
      if (!order) throw new AppError('ORDER_NOT_FOUND', '此委托不属于当前角色或当前账号。');
      risk = decimal(order.Price).mul(decimal(order.Amount));
    }
    if (
      action === 'auction_cancel' &&
      (!s.ownAuction || Number(s.ownAuction.Id) !== a.auctionId || !decimal(s.ownAuction.Amount).gt(0))
    )
      throw new AppError('AUCTION_NOT_FOUND', '未找到本人可撤销竞价。');
    if (action === 'auction_cancel') {
      risk = decimal(s.ownAuction.Price).mul(decimal(s.ownAuction.Amount));
      warnings.push(`撤拍手续费按客户端 20% 估算为 ₵${risk.mul('0.2').toFixed(2)}，实际扣费尚未核实。`);
    }
    if (action === 'auction_bid') {
      const pool = object(s.character.pool);
      if (
        decimal(a.amount).gt(decimal(pool.Amount)) ||
        decimal(a.price).lt(decimal(s.character.Price).ceil())
      )
        throw new AppError('AUCTION_LIMIT', '竞价股数超过英灵殿持股或价格低于客户端拍卖底价。');
      if (s.ownAuction && decimal(s.ownAuction.Amount).gt(0))
        throw new AppError('AUCTION_EXISTS', '已有竞价，请先通过独立计划撤销，避免未知的覆盖/追加规则。');
    }
    if (action === 'ico_invest') {
      if (s.character.Current !== undefined || !s.character.End)
        throw new AppError('NOT_ICO', '没有可投资的 ICO。');
      const end = String(s.character.End);
      const endTime = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(end) ? end : `${end}+08:00`);
      if (!Number.isFinite(endTime) || endTime <= this.now())
        throw new AppError('ICO_ENDED', 'ICO 已结束或结束时间不明。');
      cash = decimal(a.amount);
      risk = cash;
    }
    if (action === 'star' || action === 'refine') {
      if (!s.temple || String(s.temple.UserId) !== s.account)
        throw new AppError('NO_TEMPLE', '没有属于当前账号的圣殿。');
      if (action === 'star' && decimal(a.amount).gt(decimal(s.temple.Assets)))
        throw new AppError('TEMPLE_ASSETS', '圣殿固定资产不足。');
      if (action === 'refine') {
        if (decimal(s.temple.Assets).lt(2500) || decimal(s.temple.Sacrifices).lt(2500))
          throw new AppError('REFINE_LIMIT', '未达到客户端精炼门槛 2500 固定资产。');
        cash = D('1.3').pow(decimal(s.temple.Refine)).mul(10000).ceil();
        risk = cash.plus(decimal(s.character.Current));
      }
    }
    if (cash.gt(decimal(s.balance))) throw new AppError('BALANCE', '当前可用余额不足。');
    return { snapshot: s, cash: cash.toFixed(), risk: risk.toFixed(), warnings };
  }
  private writePath(p: Plan): string {
    const a = p.terms.args,
      c = a.characterId,
      n = a.amount,
      price = a.price;
    switch (p.terms.action) {
      case 'buy':
        return `chara/bid/${c}/${price}/${n}${a.iceberg ? '/true' : ''}`;
      case 'sell':
        return `chara/ask/${c}/${price}/${n}${a.iceberg ? '/true' : ''}`;
      case 'cancel_order':
        return `chara/${a.side === 'buy' ? 'bid' : 'ask'}/cancel/${a.orderId}`;
      case 'auction_bid':
        return `chara/auction/${c}/${price}/${n}`;
      case 'auction_cancel':
        return `chara/auction/cancel/${a.auctionId}`;
      case 'ico_invest':
        return `chara/join/${p.terms.snapshot.character.Id}/${n}`;
      case 'sacrifice':
        return `chara/sacrifice/${c}/${n}/false`;
      case 'financing':
        return `chara/sacrifice/${c}/${n}/true`;
      case 'star':
        return `chara/star/${c}/${n}`;
      case 'refine':
        return `magic/refine/${c}`;
    }
    throw new AppError('ACTION', '不支持的交易动作。');
  }
  private reconcile(p: Plan, after: Snapshot): boolean {
    if (isGameAction(p.terms.action))
      return gameReconcile(p.terms.action, p.terms.args, p.terms.snapshot, after, p.receipt?.response);
    if (after.account !== p.terms.account) return false;
    const before = p.terms.snapshot,
      a = p.terms.args,
      action = p.terms.action;
    if (action === 'cancel_order')
      return !(a.side === 'buy' ? after.trading.Bids : after.trading.Asks).some(
        (v: any) => Number(v.Id) === a.orderId && decimal(v.Amount).gt(0),
      );
    if (action === 'buy' || action === 'sell') {
      const fields = action === 'buy' ? ['Bids', 'BidHistory'] : ['Asks', 'AskHistory'];
      return fields.some((field) =>
        (after.trading[field] ?? []).some(
          (v: any) =>
            !(before.trading[field] ?? []).some((b: any) => b.Id === v.Id) &&
            decimal(v.Price).eq(a.price) &&
            decimal(v.Amount).eq(a.amount) &&
            (!a.iceberg || field.endsWith('History') || Number(v.Type) === 1),
        ),
      );
    }
    if (action === 'auction_bid')
      return (
        !!after.ownAuction &&
        decimal(after.ownAuction.Price).eq(a.price) &&
        decimal(after.ownAuction.Amount).eq(a.amount)
      );
    if (action === 'auction_cancel')
      return (
        !after.ownAuction ||
        Number(after.ownAuction.Id) !== a.auctionId ||
        !decimal(after.ownAuction.Amount).gt(0)
      );
    if (action === 'ico_invest')
      return (
        before.icoInvestment?.Amount !== undefined &&
        after.icoInvestment?.Amount !== undefined &&
        decimal(after.icoInvestment.Amount).minus(decimal(before.icoInvestment.Amount)).eq(a.amount)
      );
    if (action === 'refine')
      return (
        after.temple &&
        decimal(after.temple.Refine).eq(decimal(before.temple.Refine).plus(1)) &&
        decimal(before.temple.Assets).minus(decimal(after.temple.Assets)).eq(1)
      );
    if (action === 'star')
      return (
        after.temple &&
        decimal(before.temple.Assets).minus(decimal(after.temple.Assets)).eq(a.amount) &&
        decimal(after.temple.StarForces).gt(decimal(before.temple.StarForces))
      );
    if (action === 'sacrifice' || action === 'financing')
      return decimal(before.available).minus(decimal(after.available)).eq(a.amount);
    return false;
  }
}
