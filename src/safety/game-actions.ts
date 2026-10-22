import { AppError, object, pick } from '../core.js';
import { decimal, D } from '../calculations.js';
import { safeData } from '../models.js';
import type { Queries } from '../services/queries.js';
import { createHash } from 'node:crypto';

export const gameActions = [
  'ico_start',
  'temple_line',
  'temple_cover',
  'temple_reset',
  'temple_destroy',
  'temple_link',
  'chaos',
  'guidepost',
  'fisheye',
  'stardust',
  'stardust2',
  'starbreak',
  'avatar',
  'profile_sync',
  'weekly_bonus',
  'daily_bonus',
  'holiday_bonus',
  'scratch',
  'scratch_lotus',
  'send',
  'image_upload',
  'remote_logout',
] as const;
export type GameAction = (typeof gameActions)[number];
export const gameLabels: Record<GameAction, string> = {
  ico_start: '发起 ICO',
  temple_line: '编辑圣殿台词',
  temple_cover: '更换圣殿封面',
  temple_reset: '重置本人圣殿封面',
  temple_destroy: '拆除圣殿',
  temple_link: '连接圣殿',
  chaos: '混沌魔方',
  guidepost: '虚空道标',
  fisheye: '鲤鱼之眼',
  stardust: '星光碎片补塔',
  stardust2: '星光碎片降塔',
  starbreak: '闪光结晶',
  avatar: '更换角色头像',
  profile_sync: '同步角色资料',
  weekly_bonus: '领取每周分红',
  daily_bonus: '领取签到奖励',
  holiday_bonus: '领取节日福利',
  scratch: '环保刮刮乐',
  scratch_lotus: '幻想乡刮刮乐',
  send: '发送红包',
  image_upload: '上传并更换图片',
  remote_logout: '退出 TinyGrail 服务端会话',
};
export const isGameAction = (action: string): action is GameAction =>
  (gameActions as readonly string[]).includes(action);
const list = (v: any): any[] => {
  if (Array.isArray(v)) return v;
  if (v?.Items == null && Number(v?.TotalItems) === 0) return [];
  if (Array.isArray(v?.Items)) return v.Items;
  throw new AppError('SCHEMA', '缺少资产列表。');
};
const nonCharacter = new Set([
  'weekly_bonus',
  'daily_bonus',
  'holiday_bonus',
  'scratch',
  'scratch_lotus',
  'send',
  'remote_logout',
]);
const templeActions = new Set([
  'temple_line',
  'temple_cover',
  'temple_reset',
  'temple_destroy',
  'temple_link',
  'chaos',
  'guidepost',
  'fisheye',
  'starbreak',
]);
const characterState = (v: any) =>
  pick(object(v), [
    'Id',
    'CharacterId',
    'Name',
    'Current',
    'Level',
    'Total',
    'End',
    'Sacrifices',
    'StarForces',
    'Icon',
    'Avatar',
  ]);
export async function gameSnapshot(q: Queries, action: GameAction, a: any) {
  const profile = (await q.account()).value;
  const read = async (path: string) => (await q.api.read({ path, auth: true })).value;
  const s: any = {
    account: String(profile.Id),
    name: profile.Name,
    balance: decimal(profile.Balance).toFixed(),
    character: {},
    game: { profile: pick(profile, ['ShowDaily', 'ShowWeekly', 'ShowHoliday']) },
  };
  const temple = async (id: number) => {
    const rows = list(await read(`chara/user/temple/${encodeURIComponent(s.name)}/1/100?characterIds=${id}`));
    const found = rows.find((v) => Number(v.CharacterId) === id);
    return found
      ? pick(found, [
          'Id',
          'UserId',
          'CharacterId',
          'Assets',
          'Sacrifices',
          'Level',
          'Refine',
          'StarForces',
          'LinkId',
          'LinkedAssets',
          'Cover',
          'Line',
        ])
      : null;
  };
  if (!nonCharacter.has(action)) {
    try {
      s.character = characterState(await read(`chara/${a.characterId}`));
    } catch (e) {
      // A rejected detail request alone does not establish absence from the market.
      if (action !== 'ico_start' || !(e instanceof AppError) || e.code !== 'API_REJECTED') throw e;
      const market = await q.marketStatuses([a.characterId]);
      if (market.data.items[0]?.status !== 'not_in_market') throw e;
      s.character = { CharacterId: a.characterId, unissued: true };
    }
  }
  if (templeActions.has(action)) s.game.temple = await temple(a.characterId);
  if (action === 'image_upload' && a.kind === 'cover') s.game.temple = await temple(a.characterId);
  if (['temple_link', 'guidepost', 'fisheye', 'stardust', 'stardust2', 'starbreak'].includes(action)) {
    s.game.target = characterState(await read(`chara/${a.targetCharacterId}`));
    if (action === 'temple_link') s.game.targetTemple = await temple(a.targetCharacterId);
    if (action === 'fisheye')
      s.game.fantasy = safeData(await read(`chara/user/${a.targetCharacterId}/blueleaf/false`));
  }
  if (
    ['stardust', 'stardust2', 'avatar'].includes(action) ||
    (action === 'image_upload' && a.kind === 'avatar')
  ) {
    s.game.trading = safeData(await read(`chara/user/${a.characterId}`));
    if (String(s.game.trading.Id) !== s.account)
      throw new AppError('ACCOUNT_CHANGED', '交易资料不属于当前账号。');
  }
  if (action === 'avatar' || (action === 'image_upload' && a.kind === 'avatar'))
    s.game.board = list(await read(`chara/users/${a.characterId}/1/10`)).map((v) => ({
      Id: v.Id,
      Name: v.Name,
      State: v.State,
      active: Number(v.State) !== 666 && Date.now() - Date.parse(v.LastActiveDate) < 5 * 86400000,
    }));
  if (action === 'ico_start') s.game.votes = safeData(await read(`chara/kill/votes/${a.characterId}`));
  if (action === 'weekly_bonus') s.game.forecast = safeData(await read('event/share/bonus/test'));
  if (action === 'holiday_bonus') s.game.holiday = await read('event/holiday/bonus/check');
  if (action === 'scratch_lotus') s.game.count = await read('event/daily/count/10');
  if (action === 'send') {
    s.game.recipient = pick(object(await read(`chara/user/assets/${encodeURIComponent(a.username)}`)), [
      'Id',
      'Name',
      'Nickname',
      'State',
    ]);
    s.game.logs = safeData(await read(`chara/user/send/log/${encodeURIComponent(s.name)}/1/30`));
  }
  if (action === 'temple_link') s.game.links = safeData(await read(`chara/links/${a.characterId}`));
  if (['chaos', 'guidepost', 'scratch', 'scratch_lotus'].includes(action)) {
    const holdings: Record<string, string> = {};
    for (let page = 1; ; page++) {
      const v = object(
        await q.api
          .read({
            path: `chara/user/chara/${encodeURIComponent(s.name)}/${page}/100`,
            method: 'POST',
            auth: true,
          })
          .then((r) => r.value),
      );
      const rows = list(v);
      if (!Number.isSafeInteger(Number(v.TotalPages)) || Number(v.TotalPages) > 10000)
        throw new AppError('SCHEMA', '无法完整核对抽奖持股。');
      if (Number(v.CurrentPage) !== page) throw new AppError('SCHEMA', '持股页码与请求不一致。');
      for (const item of rows) holdings[String(item.CharacterId)] = decimal(item.UserAmount).toFixed();
      if (page >= Number(v.TotalPages)) {
        if (Object.keys(holdings).length !== Number(v.TotalItems))
          throw new AppError('SCHEMA', '持股分页不完整。');
        break;
      }
      if (!rows.length) throw new AppError('SCHEMA', '持股分页提前结束。');
    }
    s.game.holdings = Object.fromEntries(Object.entries(holdings).sort(([a], [b]) => a.localeCompare(b)));
  }
  if (['stardust', 'stardust2', 'starbreak'].includes(action)) {
    s.game.targetTemples = safeData(await read(`chara/temple/${a.targetCharacterId}`));
  }
  if (['daily_bonus', 'weekly_bonus', 'holiday_bonus'].includes(action))
    s.game.balanceLogs = safeData(await read('chara/user/balance/1/30'));
  return s;
}
export async function gamePreflight(q: Queries, action: GameAction, a: any) {
  const s = await gameSnapshot(q, action, a);
  let cash = D(0),
    risk = D(0);
  const g = s.game;
  if (templeActions.has(action) && (!g.temple || String(g.temple.UserId) !== s.account))
    throw new AppError('NO_TEMPLE', '没有属于当前账号的圣殿。');
  if (action === 'ico_start') {
    if (!s.character.unissued) throw new AppError('ICO_EXISTS', '该角色已有发行或 ICO 记录。');
    if (list(g.votes).length >= 3) throw new AppError('KILL_VOTES', '角色删除投票已达到限制。');
    cash = decimal(a.amount);
    if (cash.lt(10000)) throw new AppError('ICO_MINIMUM', '发起 ICO 至少需要 10000。');
  }
  if (action === 'temple_link') {
    if (
      a.characterId === a.targetCharacterId ||
      !g.targetTemple ||
      String(g.targetTemple.UserId) !== s.account
    )
      throw new AppError('LINK_TARGET', '需要本人另一座圣殿。');
    risk = decimal(g.temple.Assets).mul(decimal(s.character.Current));
  }
  const cost = action === 'chaos' ? 10 : ['guidepost', 'fisheye', 'starbreak'].includes(action) ? 100 : 0;
  if (cost) {
    if (decimal(g.temple.Assets).lt(cost) || Number(g.temple.Level) <= 0)
      throw new AppError('TEMPLE_ASSETS', '圣殿固定资产或等级不足。');
    risk = decimal(s.character.Current).mul(cost);
  }
  if (action === 'fisheye' && !decimal(g.fantasy.Amount).gt(0))
    throw new AppError('POOL_EMPTY', '幻想乡没有目标角色股份。');
  if (['stardust', 'stardust2'].includes(action)) {
    if (decimal(g.trading.Amount).lt(a.amount)) throw new AppError('SHARES', '可用活股不足。');
    risk = decimal(s.character.Current).mul(a.amount);
  }
  if (action === 'temple_destroy') risk = decimal(g.temple.Assets).mul(decimal(s.character.Current));
  if (action === 'avatar' || (action === 'image_upload' && a.kind === 'avatar')) {
    const board = list(g.board),
      index = board.findIndex((v) => v.Name === s.name),
      chair = board[0];
    const active = chair?.active;
    if (index < 0 || (active ? index !== 0 : index === 0))
      throw new AppError('AVATAR_PERMISSION', '未满足 Magrail 的董事会头像编辑条件。');
  }
  if (action === 'image_upload') {
    imageData(a);
    if (a.kind === 'cover' && (!g.temple || String(g.temple.UserId) !== s.account))
      throw new AppError('NO_TEMPLE', '没有属于当前账号的圣殿。');
  }
  for (const [kind, flag] of [
    ['daily_bonus', 'ShowDaily'],
    ['weekly_bonus', 'ShowWeekly'],
  ] as const)
    if (action === kind && (g.profile[flag] === false || String(g.profile[flag]) === '0'))
      throw new AppError('ALREADY_CLAIMED', '当前没有可领取奖励。');
  if (action === 'scratch') cash = D(1000);
  if (action === 'scratch_lotus') {
    const n = Number(g.count);
    if (!Number.isSafeInteger(n) || n < 0 || n > 30) throw new AppError('SCHEMA', '刮刮乐次数无效。');
    cash = D(2).pow(n).mul(2000);
  }
  if (action === 'send') {
    if (String(g.recipient.Id) === s.account) throw new AppError('RECIPIENT', '不能给本人发红包。');
    if (!g.recipient.Id) throw new AppError('RECIPIENT', '收款玩家不存在。');
    cash = decimal(a.amount);
  }
  if (cash.gt(decimal(s.balance))) throw new AppError('BALANCE', '可用余额不足。');
  return { snapshot: s, cash: cash.toFixed(), risk: risk.plus(cash).toFixed(), warnings: [] as string[] };
}
export function gameRequest(
  action: GameAction,
  a: any,
  s: any,
): { path: string; method?: 'GET' | 'POST'; body?: unknown } {
  const c = a.characterId,
    t = a.targetCharacterId;
  switch (action) {
    case 'ico_start':
      return { path: `chara/init/${c}/${a.amount}` };
    case 'temple_line':
      return { path: `chara/temple/line/${c}`, body: a.text };
    case 'temple_cover':
      return { path: `chara/temple/cover/${c}`, body: a.url };
    case 'temple_reset':
      return { path: `chara/temple/cover/reset/${c}/${s.account}` };
    case 'temple_destroy':
      return { path: `chara/temple/destroy/${c}` };
    case 'temple_link':
      return { path: `chara/link/${c}/${t}` };
    case 'chaos':
      return { path: `magic/chaos/${c}` };
    case 'guidepost':
    case 'fisheye':
    case 'starbreak':
      return { path: `magic/${action}/${c}/${t}` };
    case 'stardust':
    case 'stardust2':
      return { path: `magic/${action}/${c}/${t}/${a.amount}/false` };
    case 'avatar':
      return { path: `chara/avatar/${c}`, body: a.url };
    case 'profile_sync':
      return { path: `chara/update/${c}`, method: 'GET' };
    case 'weekly_bonus':
      return { path: 'event/share/bonus' };
    case 'daily_bonus':
      return { path: 'event/bangumi/bonus/daily' };
    case 'holiday_bonus':
      return { path: 'event/holiday/bonus', method: 'GET' };
    case 'scratch':
      return { path: 'event/scratch/bonus2' };
    case 'scratch_lotus':
      return { path: 'event/scratch/bonus2/true' };
    case 'send':
      return {
        path: `event/send/${encodeURIComponent(a.username)}/${a.amount}/${encodeURIComponent(a.text)}`,
      };
    case 'image_upload':
      throw new AppError('ACTION', '图片上传需要分阶段执行。');
    case 'remote_logout':
      return { path: 'account/logout' };
  }
}
export function gameReconcile(action: GameAction, a: any, b: any, n: any, receipt?: any) {
  if (b.account !== n.account) return false;
  const g = n.game,
    old = b.game;
  if (action === 'remote_logout') return g.loggedOut === true;
  if (action === 'temple_line') return !!g.temple && (g.temple.Line ?? '') === a.text;
  if (action === 'temple_cover') return g.temple?.Cover === a.url;
  if (action === 'temple_reset')
    return !!old.temple?.Cover && (!g.temple?.Cover || g.temple.Cover !== old.temple.Cover);
  if (action === 'temple_destroy') return old.temple && !g.temple;
  if (action === 'avatar') return n.character.Icon === a.url || n.character.Avatar === a.url;
  if (action === 'profile_sync')
    return (
      !!receipt && typeof n.character.Name === 'string' && String(n.character.Id) === String(b.character.Id)
    );
  if (action === 'image_upload') {
    const url = imageData(a).url;
    return a.kind === 'cover'
      ? g.temple?.Cover === url
      : n.character.Icon === url || n.character.Avatar === url;
  }
  if (action === 'temple_link')
    return (
      Number(g.temple?.LinkId) === Number(g.targetTemple?.Id) ||
      Number(g.targetTemple?.LinkId) === Number(g.temple?.Id)
    );
  if (action === 'ico_start')
    return (
      !n.character.unissued && !!n.character.End && decimal(b.balance).minus(decimal(n.balance)).eq(a.amount)
    );
  if (['chaos', 'guidepost', 'scratch', 'scratch_lotus'].includes(action)) {
    const rewards = Array.isArray(receipt) ? receipt : [receipt];
    if (!rewards.length || rewards.some((v) => !v?.Id || v.Amount === undefined)) return false;
    const totals = new Map<string, any>();
    for (const r of rewards)
      totals.set(String(r.Id), (totals.get(String(r.Id)) ?? D(0)).plus(decimal(r.Amount)));
    for (const [id, amount] of totals)
      if (
        !decimal(g.holdings[id] ?? 0)
          .minus(decimal(old.holdings[id] ?? 0))
          .eq(amount)
      )
        return false;
    if (action === 'chaos' || action === 'guidepost')
      return decimal(old.temple.Assets)
        .minus(decimal(g.temple.Assets))
        .eq(action === 'chaos' ? 10 : 100);
    const price = action === 'scratch' ? D(1000) : D(2).pow(Number(old.count)).mul(2000);
    return decimal(b.balance).minus(decimal(n.balance)).eq(price);
  }
  if (action === 'send')
    return (
      list(g.logs).some(
        (v) =>
          !list(old.logs).some((o) => String(o.Id) === String(v.Id)) &&
          Number(v.Type) === 16 &&
          v.RelatedName === a.username &&
          decimal(v.Change).eq(decimal(a.amount).neg()),
      ) && decimal(b.balance).minus(decimal(n.balance)).gte(a.amount)
    );
  if (action === 'fisheye')
    return (
      decimal(old.temple.Assets).minus(decimal(g.temple.Assets)).eq(100) &&
      decimal(old.fantasy.Amount).gt(decimal(g.fantasy.Amount))
    );
  if (action === 'starbreak')
    return (
      decimal(old.temple.Assets).minus(decimal(g.temple.Assets)).eq(100) &&
      decimal(old.target.StarForces).gt(decimal(g.target.StarForces))
    );
  if (['stardust', 'stardust2'].includes(action))
    return (
      decimal(old.trading.Amount).minus(decimal(g.trading.Amount)).eq(a.amount) &&
      (action === 'stardust2'
        ? decimal(old.target.Sacrifices).gt(decimal(g.target.Sacrifices))
        : list(g.targetTemples).some((v) =>
            list(old.targetTemples).some(
              (o) => String(o.Id) === String(v.Id) && decimal(v.Assets).gt(decimal(o.Assets)),
            ),
          ))
    );
  if (['daily_bonus', 'weekly_bonus', 'holiday_bonus'].includes(action)) {
    const flag =
      action === 'daily_bonus' ? 'ShowDaily' : action === 'weekly_bonus' ? 'ShowWeekly' : 'ShowHoliday';
    return (
      (old.profile[flag] === true || String(old.profile[flag]) === '1') &&
      (g.profile[flag] === false || String(g.profile[flag]) === '0') &&
      decimal(n.balance).gt(decimal(b.balance))
    );
  }
  return false;
}
export function imageData(a: any) {
  const bytes = Buffer.from(a.imageBase64, 'base64');
  const jpeg = a.mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png =
    a.mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (
    !bytes.length ||
    bytes.length > 1024 * 1024 ||
    (!jpeg && !png) ||
    bytes.toString('base64') !== a.imageBase64
  )
    throw new AppError('IMAGE', '需要不超过 1MB 的 JPEG 或 PNG 图片。');
  const hash = createHash('md5').update(`data:${a.mime};base64,${a.imageBase64}`).digest('hex');
  return {
    bytes,
    hash,
    url: `https://tinygrail.oss-cn-hangzhou.aliyuncs.com/${a.kind}/${hash}.${a.mime === 'image/jpeg' ? 'jpg' : 'png'}`,
  };
}
