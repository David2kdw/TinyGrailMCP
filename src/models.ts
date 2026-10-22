import { AppError, object, pick } from './core.js';
// Explicit export allowlist. Never forward arbitrary API properties (IP addresses, tokens, etc.).
export const FIELDS =
  `Id CharacterId UserId Name Nickname CharacterName SubjectId SubjectName Current Price Amount Total UserTotal UserAmount Balance Assets Sacrifices StarForces NextStar Stars Rank LastIndex MarketValue Rate Level Refine CharacterLevel CharacterRank CharacterStars CharacterStarForces ZeroCount Fluctuation Change Asks Bids AskHistory BidHistory Begin End Start Bid Create Upgrade Last LastOrder LastDeal LastUpdate ListedDate AirDate State Type Users Count TotalItems ItemsPerPage TotalPages CurrentPage Items Link LinkId LinkedAssets Extra Bonus OrderId AuctionId InitialId Cost Value Time TradeTime LogTime RelatedId Seller Buyer SellerName BuyerName Date Open Close High Low Volume Turnover Tax Fee Capital Principal Income Interest Description Title Delta Amounts BidsAmount AsksAmount Ask`.split(
    ' ',
  );
FIELDS.push('Temples', 'Share', 'Daily', 'AuctionUsers', 'AuctionTotal');
FIELDS.push(
  ...`Icon Avatar Cover LargeCover Line Source Slots LastActive LastLink Crown RaidWin RaidLose BattleWin BattleLose TotalBalance LastActiveDate Username UserName FromCharacterId OldRank Loss ShowDaily ShowWeekly ShowHoliday HolidayName Limit CurrentPrice SellPrice SellAmount FinancePrice Reason VoteTime`.split(
    ' ',
  ),
);
FIELDS.push(
  'RelatedName',
  'UpdateTime',
  'NickName',
  'CharacterTotalItems',
  'IcoTotalItems',
  'LinkTotalItems',
  'TempleTotalItems',
);
export function safeData(value: any, depth = 0): any {
  if (depth > 8) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => safeData(v, depth + 1));
  const allowed = pick(object(value), FIELDS);
  return Object.fromEntries(Object.entries(allowed).map(([k, v]) => [k, safeData(v, depth + 1)]));
}
// These endpoints return arrays without server paging or a total history count.
export function historyPageData(value: unknown, page: number, size: number, timeField: 'Time' | 'TradeTime') {
  if (!Array.isArray(value)) throw new AppError('SCHEMA', '历史响应不是数组。');
  // The server uses a consistent date-time format. Keep its timezone-free values unchanged.
  const time = (item: any) =>
    typeof item?.[timeField] === 'string' ? item[timeField].replace(' ', 'T') : '';
  const sorted = [...value].sort((a, b) => time(b).localeCompare(time(a)));
  const items = sorted.slice((page - 1) * size, page * size).map((v) => safeData(v));
  return {
    items,
    pagination: {
      scope: 'server_response',
      page,
      pageSize: size,
      returned: items.length,
      totalItems: value.length,
      totalPages: Math.ceil(value.length / size),
      hasMore: page * size < value.length,
      complete: page === 1 && items.length === value.length,
      serverHistoryComplete: null,
    },
  };
}
export function pageData(value: any, page: number, size: number) {
  if (Array.isArray(value))
    return {
      items: safeData(value),
      pagination: {
        page,
        pageSize: size,
        returned: value.length,
        totalItems: null,
        totalPages: null,
        pageComplete: value.length <= size,
        complete: false,
        hasMore: null,
        truncated: false,
      },
    };
  const v = object(value);
  // Observed on the real empty LINK endpoint: State=0, TotalItems=0, Items=null.
  if (v.Items === null && Number(v.TotalItems) === 0) v.Items = [];
  if (!Array.isArray(v.Items)) throw new AppError('SCHEMA', '分页响应缺少 Items 数组。');
  const current = Number(v.CurrentPage ?? page);
  const total = v.TotalItems === undefined ? null : Number(v.TotalItems);
  const pages = v.TotalPages === undefined ? null : Number(v.TotalPages);
  const serverSize = Number(v.ItemsPerPage ?? size);
  if (
    !Number.isSafeInteger(current) ||
    current < 1 ||
    !Number.isSafeInteger(serverSize) ||
    serverSize < 1 ||
    (total !== null && (!Number.isSafeInteger(total) || total < 0)) ||
    (pages !== null && (!Number.isSafeInteger(pages) || pages < 0))
  )
    throw new AppError('SCHEMA', '非法分页元数据。');
  const expected =
    total === null ? null : Math.min(serverSize, Math.max(0, total - (current - 1) * serverSize));
  const pageComplete = current === page && (expected === null || v.Items.length === expected);
  const hasMore = pages !== null ? current < pages : total !== null ? current * serverSize < total : null;
  return {
    items: safeData(v.Items),
    pagination: {
      page: current,
      pageSize: serverSize,
      returned: v.Items.length,
      totalItems: total,
      totalPages: pages,
      pageComplete,
      complete: current === 1 && pageComplete && hasMore === false,
      hasMore,
      truncated: false,
    },
  };
}
