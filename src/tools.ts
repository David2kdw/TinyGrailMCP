import * as z from 'zod/v4';
import { AppError } from './core.js';
import { budget } from './calculations.js';
import type { Queries } from './services/queries.js';
import type { Safety, Action } from './safety/engine.js';
import type { GameAction } from './safety/game-actions.js';

export const id = z.number().int().positive().max(2147483647);
export const money = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/)
  .refine((v) => Number(v) > 0, '必须大于零');
export const quantity = z.number().int().min(1).max(100000000);
const pages = {
  page: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(1).max(100).default(30),
};
export interface Tool {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  prepare?: boolean;
  run: (a: any) => Promise<any>;
}
export function buildTools(q: Queries, safety: Safety, status: () => Promise<unknown>): Tool[] {
  const t = (name: string, description: string, shape: z.ZodRawShape, run: Tool['run']): Tool => ({
    name,
    description,
    schema: z.object(shape).strict(),
    run,
  });
  const tools: Tool[] = [
    t(
      'get_top_week',
      '查询整榜每周萌王、评分和竞拍情况；可按名称或角色筛选，排名保持整榜口径。',
      {
        keyword: z.string().trim().min(1).max(60).optional(),
        characterId: id.optional(),
        includeDetails: z.boolean().default(false),
      },
      async (a) => q.topWeek(a.keyword, a.characterId, a.includeDetails),
    ),
    t(
      'get_top_week_history',
      '分页浏览往期萌王结果；Level 为当期名次，CharacterLevel 为角色等级，Create 标识期次。每页 12 项可按 Magrail 浏览各期。',
      { ...pages, pageSize: pages.pageSize.default(12), includeDetails: z.boolean().default(false) },
      async (a) => q.topWeekHistory(a.page, a.pageSize, a.includeDetails),
    ),
    t(
      'get_characters',
      '批量查询角色行情，保留服务器返回的全部角色。',
      { characterIds: z.array(id).min(1).max(100) },
      async (a) => q.request({ path: 'chara/list', method: 'POST', body: [...new Set(a.characterIds)] }),
    ),
    t('get_character_links', '查询角色 LINK。', { characterId: id }, async (a) =>
      q.request({ path: `chara/links/${a.characterId}` }),
    ),
    t('get_character_votes', '查询角色删除投票记录。', { characterId: id }, async (a) =>
      q.request({ path: `chara/kill/votes/${a.characterId}`, auth: true }),
    ),
    t(
      'get_daily_status',
      '查询节日名称及幻想乡刮刮乐当日次数。',
      { category: z.enum(['holiday', 'lotus_count']) },
      async (a) =>
        q.request({
          path: a.category === 'holiday' ? 'event/holiday/bonus/check' : 'event/daily/count/10',
          auth: true,
        }),
    ),
    t(
      'get_user_profile',
      '按 Bangumi 用户名查询玩家公开资产资料或股息预测。',
      {
        username: z
          .string()
          .trim()
          .regex(/^[a-zA-Z0-9_-]{1,64}$/),
        category: z.enum(['profile', 'dividend']).default('profile'),
      },
      async (a) =>
        q.request({
          path: `${a.category === 'profile' ? 'chara/user/assets' : 'event/share/bonus/test'}/${encodeURIComponent(a.username)}`,
          auth: true,
        }),
    ),
    t(
      'get_user_character',
      '查询玩家公开可见的指定角色持股。',
      {
        username: z
          .string()
          .trim()
          .regex(/^[a-zA-Z0-9_-]{1,64}$/),
        characterId: id,
      },
      async (a) => q.request({ path: `chara/user/${a.characterId}/${encodeURIComponent(a.username)}/false` }),
    ),
    t(
      'list_user_assets',
      '分页浏览玩家公开持股、圣殿、LINK、ICO 和红包记录；省略用户名查询本人。支持服务端筛选。',
      {
        category: z.enum(['holdings', 'temples', 'links', 'ico', 'red_packets']),
        username: z
          .string()
          .trim()
          .regex(/^[a-zA-Z0-9_-]{1,64}$/)
          .optional(),
        sort: z
          .string()
          .regex(/^[a-zA-Z0-9_, -]{0,60}$/)
          .optional()
          .describe('服务端原生 sort 字符串；Magrail 未定义取值枚举，省略保持服务器顺序。'),
        keyword: z.string().trim().max(60).optional(),
        characterIds: z.array(id).max(100).optional(),
        ...pages,
      },
      async (a) => q.accountList(a.category, a.page, a.pageSize, undefined, a),
    ),
    t('ping', '检查 MCP 工具调用链路。', {}, async () => ({
      ok: true,
      time: new Date().toISOString(),
    })),
    t('get_server_status', '查询管理器、MCP、Tunnel、API 和交易权限状态。', {}, status),
    t('get_session_status', '查询并验证 TinyGrail 登录状态。', {}, async () => q.sessionStatus()),
    t('get_account_overview', '当前账户、现金余额和服务端总资产；金额为十进制字符串。', {}, async () =>
      q.overview(),
    ),
    t(
      'get_asset_breakdown',
      '查询账户及持股、圣殿、ICO、拍卖、道具的指定页，附请求与数据完整性状态。',
      pages,
      async (a) => q.breakdown(a.page, a.pageSize),
    ),
    t(
      'get_character',
      '按 Bangumi 角色 ID 查询行情、发行、等级、星之力与 ICO/上市状态。',
      { characterId: id },
      async (a) => q.character(a.characterId),
    ),
    t(
      'search_characters',
      '按名称搜索已上市角色和当前 ICO；纯数字按角色 ID 精确查询。',
      { keyword: z.string().trim().min(1).max(60), limit: z.number().int().min(1).max(50).default(30) },
      async (a) => q.search(a.keyword, a.limit),
    ),
    t('get_orderbook', '查询角色买卖盘，保留聚合及隐藏档位的 Type 标记。', { characterId: id }, async (a) =>
      q.request({ path: `chara/depth/${a.characterId}` }),
    ),
    t(
      'get_my_character_trading',
      '查询本人角色资产、当前委托及 AskHistory/BidHistory；历史按 TradeTime 降序，在服务器返回范围内分别分页。',
      { characterId: id, historyPage: pages.page, historyPageSize: pages.pageSize.default(100) },
      async (a) => q.trading(a.characterId, a.historyPage, a.historyPageSize),
    ),
    t('list_character_holders', '分页查询可见角色持有人。', { characterId: id, ...pages }, async (a) =>
      q.request({ path: `chara/users/${a.characterId}/${a.page}/${a.pageSize}` }, a.page, a.pageSize),
    ),
    t(
      'list_character_temples',
      '查询角色圣殿，在服务器返回范围内分页。LINK 使用 get_character_links。',
      { characterId: id, ...pages },
      async (a) => {
        const r = await q.api.read({ path: `chara/temple/${a.characterId}` });
        const { historyPageData } = await import('./models.js');
        return { data: historyPageData(r.value, a.page, a.pageSize, 'Time'), observedAt: r.observedAt };
      },
    ),
    t(
      'get_price_history',
      '查询角色历史行情，按 Time 降序分页；Begin/End 为开收价格，Price 为成交总额，Amount 为成交数量。',
      { characterId: id, since: z.iso.date(), page: pages.page, pageSize: pages.pageSize.default(100) },
      async (a) => q.priceHistory(a.characterId, a.since, a.page, a.pageSize),
    ),
    t(
      'get_auction_status',
      '查询当前拍卖：State 为竞拍人数、Type 为竞拍股数，Price/Amount 为本人出价。',
      { characterIds: z.array(id).min(1).max(30) },
      async (a) =>
        q.request(
          { path: 'chara/auction/list', method: 'POST', body: [...new Set(a.characterIds)], auth: true },
          1,
          100,
        ),
    ),
    t(
      'get_auction_history',
      '登录后查询某角色往期拍卖，服务器每页大小固定。',
      { characterId: id, page: pages.page },
      async (a) =>
        q.request({ path: `chara/auction/list/${a.characterId}/${a.page}`, auth: true }, a.page, 100),
    ),
    t(
      'get_ico_status',
      '查询 ICO 进度、发行预测和指定投入的预计股数。',
      { characterId: id, investment: money.optional(), includeDetails: z.boolean().default(false) },
      async (a) => q.ico(a.characterId, a.investment, a.includeDetails),
    ),
    t('get_my_ico_investment', '按 ICO 记录 ID 查询本人出资。', { icoId: id }, async (a) =>
      q.request({ path: `chara/initial/${a.icoId}`, auth: true }),
    ),
    t('list_ico_participants', '按 ICO 记录 ID 分页查询参与者。', { icoId: id, ...pages }, async (a) =>
      q.request({ path: `chara/initial/users/${a.icoId}/${a.page}/${a.pageSize}` }, a.page, a.pageSize),
    ),
    t(
      'list_market',
      '浏览上市角色、ICO、ST、英灵殿、幻想乡、通天塔、股息/市值/涨跌/精炼/首富榜、最新圣殿/LINK 和通天塔日志。',
      {
        category: z.enum([
          'ico',
          'valhalla',
          'fantasy',
          'tower',
          'dividend',
          'value',
          'rise',
          'fall',
          'all',
          'st',
          'refine',
          'wealth',
          'latest_temples',
          'latest_links',
          'tower_logs',
        ]),
        ...pages,
      },
      async (a) => {
        const route: Record<string, string> = {
          ico: 'mri',
          tower: 'babel',
          dividend: 'msrc',
          value: 'mvc',
          rise: 'mrc',
          fall: 'mfc',
          all: 'msrc',
          st: 'delist/chara',
          refine: 'refine/temple',
          wealth: 'top',
          latest_temples: 'temple/last',
          latest_links: 'link/last',
          tower_logs: 'star/log',
        };
        if (a.category === 'valhalla' || a.category === 'fantasy')
          return q.request(
            {
              path: `chara/user/chara/${a.category === 'valhalla' ? 'tinygrail' : 'blueleaf'}/${a.page}/${a.pageSize}`,
              method: 'POST',
            },
            a.page,
            a.pageSize,
          );
        return q.request(
          {
            path: `chara/${route[a.category]}/${a.page}/${a.pageSize}`,
            ...(a.category === 'st' ? { method: 'POST' as const } : {}),
          },
          a.page,
          a.pageSize,
        );
      },
    ),
    t(
      'get_character_pools',
      '查询角色奖池股数及英灵殿、幻想乡的系统持股。',
      { characterId: id },
      async (a) => {
        const pool = await q.request({ path: `chara/pool/${a.characterId}` });
        const valhalla = await q.request({ path: `chara/user/${a.characterId}/tinygrail/false` });
        const fantasy = await q.request({ path: `chara/user/${a.characterId}/blueleaf/false` });
        return {
          data: { prizePoolShares: pool, valhalla, fantasy },
          observedAt: new Date().toISOString(),
        };
      },
    ),
    t(
      'estimate_temple_income',
      '估算本人单个圣殿的每股股息和单期收益；includeDetails 可查看公式依据。',
      { characterId: id, includeDetails: z.boolean().default(false) },
      async (a) => q.templeAnalysis(a.characterId, a.includeDetails),
    ),
    t(
      'get_dividend_forecast',
      '查询服务器的全账户股息预测、计息股份、圣殿数量、税额及登录奖励。',
      {},
      async () => q.dividendForecast(),
    ),
    t(
      'calculate_budget',
      '按单价、股数及指定费率计算本金、费用和总额。',
      {
        price: money,
        amount: quantity,
        feeRate: z
          .string()
          .regex(/^(?:0(?:\.\d{1,8})?|1)$/)
          .default('0'),
      },
      async (a) => budget(a.price, a.amount, a.feeRate),
    ),
    t('get_trade_plan', '查看本人交易计划状态和回执。', { planId: z.string().uuid() }, async (a) =>
      safety.get(a.planId),
    ),
  ];
  const lists = {
    list_holdings: ['holdings', '分页查询持股、可用股数、现价和市值估算。'],
    list_temples: ['temples', '分页查询本人圣殿、精炼、星之力和固定资产。'],
    list_my_icos: ['ico', '分页查询本人 ICO。'],
    list_my_auctions: ['auctions', '分页查询本人拍卖竞价。'],
    list_links: ['links', '分页查询本人圣殿连接。'],
    list_items: ['items', '分页查询道具。'],
    list_balance_history: ['balance', '分页查询现金变动日志。'],
  };
  for (const [name, [kind, description]] of Object.entries(lists))
    tools.push(t(name, description!, pages, async (a) => q.accountList(kind!, a.page, a.pageSize)));
  tools.push(
    t(
      'list_orders',
      '分页查询本人的委买或委卖角色；单个角色详细订单使用 get_my_character_trading。',
      { side: z.enum(['buy', 'sell']), ...pages },
      async (a) => q.accountList(a.side === 'buy' ? 'bids' : 'asks', a.page, a.pageSize),
    ),
  );
  const common = {
    characterId: id,
    requestId: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[\w-]+$/)
      .describe('同一交易意图使用稳定且唯一的请求 ID；重复调用复用原计划。'),
  };
  const preparations: [string, Action, string, z.ZodRawShape][] = [
    [
      'prepare_buy_order',
      'buy',
      '准备限价买入委托',
      { price: money, amount: quantity, iceberg: z.boolean().default(false) },
    ],
    [
      'prepare_sell_order',
      'sell',
      '准备限价卖出委托',
      { price: money, amount: quantity, iceberg: z.boolean().default(false) },
    ],
    [
      'prepare_cancel_order',
      'cancel_order',
      '准备撤销本人指定委托',
      { side: z.enum(['buy', 'sell']), orderId: id },
    ],
    ['prepare_auction_bid', 'auction_bid', '准备拍卖竞价', { price: money, amount: quantity }],
    ['prepare_auction_cancel', 'auction_cancel', '准备撤销本人竞价', { auctionId: id }],
    ['prepare_ico_invest', 'ico_invest', '准备向当前角色 ICO 投资', { amount: money }],
    ['prepare_sacrifice', 'sacrifice', '准备献祭活股', { amount: quantity }],
    ['prepare_financing', 'financing', '准备将活股出售给幻想乡', { amount: quantity }],
    ['prepare_star_conversion', 'star', '准备消耗圣殿固定资产转换星之力', { amount: quantity }],
    ['prepare_temple_refine', 'refine', '准备消耗固定资产和资金精炼圣殿', {}],
  ];
  for (const [name, action, description, fields] of preparations)
    tools.push({
      ...t(name, `${description}，需在本地管理界面批准。`, { ...common, ...fields }, async (a) =>
        safety.prepare(action, a),
      ),
      prepare: true,
    });
  const requestId = common.requestId;
  const url = z
    .url()
    .refine(
      (s) => /^https:\/\/tinygrail\.oss-cn-hangzhou\.aliyuncs\.com\/(cover|avatar)\/[a-zA-Z0-9_.-]+$/.test(s),
      '需要 TinyGrail OSS 图片地址',
    );
  const text = z.string().trim().min(1).max(1000);
  const operation = (action: string, fields: z.ZodRawShape = {}) =>
    z.object({ action: z.literal(action), ...fields }).strict();
  const grouped = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    resolve: (a: any) => { action: GameAction; args: any },
  ) => {
    tools.push({
      ...t(name, description + '，需在本地管理界面批准。', { requestId, ...shape }, async (a) => {
        const r = resolve(a);
        return safety.prepare(r.action, { ...r.args, requestId: a.requestId });
      }),
      prepare: true,
    });
  };
  grouped('prepare_ico_start', '准备发起角色 ICO', { characterId: id, amount: money }, (a) => ({
    action: 'ico_start',
    args: a,
  }));
  grouped(
    'prepare_temple_update',
    '准备编辑本人圣殿台词、封面或重置封面',
    {
      characterId: id,
      operation: z.discriminatedUnion('action', [
        operation('line', { text: z.string().trim().max(1000) }),
        operation('cover', { url }),
        operation('reset'),
      ]),
    },
    (a) => ({
      action: `temple_${a.operation.action}` as GameAction,
      args: { characterId: a.characterId, ...a.operation },
    }),
  );
  grouped('prepare_temple_link', '准备连接本人两座圣殿', { characterId: id, targetCharacterId: id }, (a) => ({
    action: 'temple_link',
    args: a,
  }));
  grouped('prepare_temple_destroy', '准备拆除本人圣殿', { characterId: id }, (a) => ({
    action: 'temple_destroy',
    args: a,
  }));
  grouped(
    'prepare_magic',
    '准备消耗资产使用魔法',
    {
      characterId: id,
      operation: z.discriminatedUnion('action', [
        operation('chaos'),
        operation('guidepost', { targetCharacterId: id }),
        operation('fisheye', { targetCharacterId: id }),
        operation('starbreak', { targetCharacterId: id }),
        operation('stardust', { targetCharacterId: id, amount: quantity }),
        operation('stardust2', { targetCharacterId: id, amount: quantity }),
      ]),
    },
    (a) => ({ action: a.operation.action, args: { characterId: a.characterId, ...a.operation } }),
  );
  grouped(
    'prepare_character_update',
    '准备头像修改或资料同步',
    {
      characterId: id,
      operation: z.discriminatedUnion('action', [operation('avatar', { url }), operation('profile_sync')]),
    },
    (a) => ({ action: a.operation.action, args: { characterId: a.characterId, ...a.operation } }),
  );
  grouped(
    'prepare_reward',
    '准备领取分红、签到、节日福利或购买一次刮刮乐',
    {
      action: z.enum(['weekly_bonus', 'daily_bonus', 'holiday_bonus', 'scratch', 'scratch_lotus']),
    },
    (a) => ({ action: a.action, args: a }),
  );
  grouped(
    'prepare_send_red_packet',
    '准备向指定玩家发送红包',
    { username: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), amount: money, text },
    (a) => ({ action: 'send', args: a }),
  );
  grouped(
    'prepare_image_upload',
    '准备上传 JPEG/PNG 并更换本人圣殿封面或角色头像',
    {
      characterId: id,
      kind: z.enum(['cover', 'avatar']),
      mime: z.enum(['image/jpeg', 'image/png']),
      imageBase64: z
        .string()
        .min(4)
        .max(1398104)
        .regex(/^[a-zA-Z0-9+/]*={0,2}$/),
    },
    (a) => ({ action: 'image_upload', args: a }),
  );
  grouped('prepare_session_logout', '准备退出服务器会话', {}, (a) => ({ action: 'remote_logout', args: a }));
  return tools;
}
export async function invoke(tools: Tool[], name: string, args: unknown) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new AppError('TOOL_NOT_FOUND', '没有此工具。');
  const parsed = t.schema.safeParse(args);
  if (!parsed.success)
    throw new AppError(
      'INVALID_INPUT',
      '工具参数不符合 Schema。',
      parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    );
  const result = await t.run(parsed.data);
  if (JSON.stringify(result).length > 100000)
    throw new AppError('OUTPUT_LIMIT', '结果超过输出限制，请缩小范围。');
  return result;
}
