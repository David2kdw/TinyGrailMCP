import { ApiClient, type ApiResult, type ReadRequest } from '../api/client.js';
import { AppError, object, pick, publicError } from '../core.js';
import { historyPageData, pageData, safeData } from '../models.js';
import { decimal, icoPrediction, templeIncome } from '../calculations.js';
import { BangumiQueries } from './bangumi.js';
import { marketStatus } from './market-status.js';

export function result<T>(r: ApiResult, data: T) {
  return {
    data,
    observedAt: r.observedAt,
    serverTime: r.serverTime,
  };
}
export class Queries {
  constructor(
    public api: ApiClient,
    public bangumi = new BangumiQueries(),
  ) {}
  async marketStatuses(characterIds: number[]) {
    const ids = [...new Set(characterIds)];
    if (!ids.length) return { data: { items: [] }, observedAt: new Date().toISOString() };
    const r = await this.api.read({ path: 'chara/list', method: 'POST', body: ids });
    if (!Array.isArray(r.value)) throw new AppError('SCHEMA', '角色批量响应不是数组。');
    const records = new Map<number, any>();
    for (const v of r.value) {
      const characterId = Number(v?.CharacterId);
      if (!ids.includes(characterId) || records.has(characterId))
        throw new AppError('SCHEMA', '角色批量响应包含重复或非请求角色。');
      records.set(characterId, v);
    }
    const serverNow = Date.parse(r.serverTime ?? r.observedAt);
    return result(r, {
      items: ids.map((characterId) => ({
        characterId,
        ...(records.has(characterId)
          ? marketStatus(records.get(characterId), serverNow)
          : { status: 'not_in_market' as const }),
      })),
    });
  }
  async attachMarket(r: { data: any; observedAt: string }, includeMarket: boolean) {
    if (!includeMarket) return r;
    const entries: any[] = r.data.items ?? [r.data];
    const characters = entries.map((v) => v.character ?? v);
    try {
      const market = await this.marketStatuses(characters.map((v) => v.characterId));
      const byId = new Map(market.data.items.map((v) => [v.characterId, v]));
      for (const character of characters) {
        const { characterId: _, ...state } = byId.get(character.characterId)!;
        character.market = state;
      }
      r.data.marketObservedAt = market.observedAt;
    } catch (e) {
      for (const character of characters) character.market = { status: 'unknown' };
      r.data.marketError = publicError(e);
    }
    return r;
  }
  async account() {
    const r = await this.api.read({ path: 'chara/user/assets', auth: true });
    const v = object(r.value);
    decimal(v.Balance);
    decimal(v.Assets);
    this.api.session.authenticated(v);
    return r;
  }
  async sessionStatus() {
    if (!(await this.api.session.cookie())) return this.api.session.status();
    try {
      await this.account();
      return this.api.session.status();
    } catch (e) {
      return { ...this.api.session.status(), checkError: publicError(e) };
    }
  }
  async overview() {
    const r = await this.account();
    return result(
      r,
      pick(r.value, [
        'Id',
        'Name',
        'Nickname',
        'Balance',
        'Assets',
        'LastIndex',
        'State',
        'Type',
        'ShowDaily',
        'ShowWeekly',
        'ShowHoliday',
      ]),
    );
  }
  async character(characterId: number) {
    const r = await this.api.read({ path: `chara/${characterId}` });
    const v = object(r.value);
    if (!v.Id || typeof v.Name !== 'string') throw new AppError('SCHEMA', '角色数据缺少身份字段。');
    return result(r, {
      ...safeData(v),
      marketType: Object.hasOwn(v, 'Current') ? 'listed' : 'ico',
      marketStatus: marketStatus(v, Date.parse(r.serverTime ?? r.observedAt)).status,
    });
  }
  async topWeek(keyword?: string, characterId?: number, includeDetails = false) {
    const r = await this.api.read({ path: 'chara/topweek' });
    if (!Array.isArray(r.value)) throw new AppError('SCHEMA', '萌王榜响应不是数组。');
    const sum = (key: string) => r.value.reduce((n: any, v: any) => n.plus(decimal(v[key])), decimal('0'));
    const users = sum('Type');
    const base = users.gt(0) ? sum('Extra').div(users) : decimal('0');
    const items = r.value.map((v: any, i: number) => ({
      ...(includeDetails ? { server: safeData(v) } : {}),
      rank: i + 1,
      characterId: Number(v.CharacterId),
      name: v.CharacterName,
      level: Number(v.CharacterLevel),
      bidders: Number(v.Type),
      bidShares: v.Assets,
      valhallaShares: v.Sacrifices,
      evaluationPrice: v.Price,
      surplus: v.Extra,
      estimatedScore: decimal(v.Extra)
        .plus(base.mul(decimal(v.Type)))
        .div(100)
        .toDecimalPlaces(0)
        .toFixed(),
      estimatedAveragePrice: decimal(v.Assets).gt(0)
        ? decimal(v.Extra)
            .plus(decimal(v.Price).mul(decimal(v.Sacrifices)))
            .div(decimal(v.Assets))
            .toFixed(2)
        : '0.00',
    }));
    const norm = (s: string) => s.normalize('NFKC').toLocaleLowerCase();
    return result(r, {
      items: items.filter(
        (v: any) =>
          (!characterId || v.characterId === characterId) &&
          (!keyword || norm(v.name).includes(norm(keyword))),
      ),
      totalItems: items.length,
      ranking: 'server_topweek_order',
      ...(includeDetails
        ? {
            calculation: {
              source: 'Magrail TopWeekRepository 90f7b26',
              scoreBase: base.toFixed(),
              score: '(Extra + Type * sum(Extra) / sum(Type)) / 100',
              averagePrice: '(Extra + Price * Sacrifices) / Assets',
            },
          }
        : {}),
    });
  }
  async topWeekHistory(page: number, size: number, includeDetails = false) {
    const r = await this.api.read({ path: `chara/topweek/history/${page}/${size}` });
    const data = pageData(r.value, page, size);
    data.items = data.items
      .map((v: any) => ({
        ...(includeDetails ? { server: v } : {}),
        characterId: Number(v.CharacterId),
        name: v.Name,
        rank: Number(v.Level),
        level: Number(v.CharacterLevel),
        bidders: v.Assets,
        surplus: v.Extra,
        totalFunds: v.Price,
        period: v.Create,
      }))
      .sort((a: any, b: any) => b.period.localeCompare(a.period) || a.rank - b.rank);
    return result(r, data);
  }
  async search(keyword: string, limit: number) {
    if (/^[1-9]\d{0,9}$/.test(keyword) && Number(keyword) <= 2147483647) {
      const exact = await this.character(Number(keyword));
      return {
        ...exact,
        data: {
          items: [exact.data],
          pagination: { returned: 1, complete: true },
          match: 'exact_character_id',
        },
      };
    }
    const norm = (s: string) => s.normalize('NFKC').toLocaleLowerCase();
    const hits = new Map<string, any>(),
      errors: Record<string, unknown> = {};
    let listedComplete = false;
    try {
      const r = await this.api.read({
        path: `chara/search/character?keyword=${encodeURIComponent(keyword)}`,
        auth: true,
      });
      if (!Array.isArray(r.value)) throw new AppError('SCHEMA', '角色搜索响应不是数组。');
      for (const v of r.value)
        hits.set(String(v.CharacterId ?? v.Id), { ...safeData(v), marketType: 'listed' });
      listedComplete = true;
    } catch (e) {
      errors.listed = publicError(e);
    }
    let icoComplete = false,
      pagesScanned = 0;
    // The real search endpoint omitted an active ICO even on exact name. Scan the sourced ICO list.
    for (let page = 1; page <= 5; page++) {
      try {
        const r = await this.api.read({ path: `chara/mri/${page}/100` });
        if (!Array.isArray(r.value)) throw new AppError('SCHEMA', 'ICO 列表响应不是数组。');
        pagesScanned++;
        for (const v of r.value)
          if (typeof v.Name === 'string' && norm(v.Name).includes(norm(keyword)))
            hits.set(String(v.CharacterId), { ...safeData(v), marketType: 'ico' });
        if (r.value.length < 100) {
          icoComplete = true;
          break;
        }
      } catch (e) {
        errors.ico = publicError(e);
        break;
      }
    }
    return {
      data: {
        items: [...hits.values()].slice(0, limit),
        pagination: {
          returned: Math.min(hits.size, limit),
          truncated: hits.size > limit,
          complete: listedComplete && icoComplete && hits.size <= limit,
        },
        icoScan: { pagesScanned, complete: icoComplete },
        ...(Object.keys(errors).length ? { errors } : {}),
      },
      observedAt: new Date().toISOString(),
    };
  }
  async request(request: ReadRequest, page?: number, size = 30) {
    const r = await this.api.read(request);
    return result(r, page === undefined ? safeData(r.value) : pageData(r.value, page, size));
  }
  async accountList(
    kind: string,
    page: number,
    size: number,
    characterId?: number,
    options: { username?: string; sort?: string; keyword?: string; characterIds?: number[] } = {},
  ) {
    const account = await this.account();
    const name = encodeURIComponent(options.username ?? account.value.Name);
    const paths: Record<string, ReadRequest> = {
      holdings: { path: `chara/user/chara/${name}/${page}/${size}`, method: 'POST' },
      temples: {
        path: `chara/user/temple/${name}/${page}/${size}${characterId ? `?characterIds=${characterId}` : ''}`,
      },
      ico: { path: `chara/user/initial/${name}/${page}/${size}`, method: 'POST' },
      links: { path: `chara/user/link/${name}/${page}/${size}`, method: 'POST' },
      items: { path: `chara/user/item/0/${page}/${size}` },
      auctions: { path: `chara/user/auction/${page}/${size}` },
      bids: { path: `chara/bids/0/${page}/${size}` },
      asks: { path: `chara/asks/0/${page}/${size}` },
      balance: { path: `chara/user/balance/${page}/${size}` },
      red_packets: { path: `chara/user/send/log/${name}/${page}/${size}` },
      trades: { path: `chara/user/history/${account.value.Id}/${page}/${size}` },
    };
    const req = paths[kind];
    if (!req) throw new AppError('INVALID_INPUT', '不支持的资产分类。');
    const query = new URLSearchParams();
    if (kind === 'holdings' && options.sort) query.set('sort', options.sort);
    if (kind === 'temples' && options.keyword) query.set('keyword', options.keyword);
    if (['holdings', 'temples'].includes(kind) && options.characterIds?.length)
      query.set('characterIds', options.characterIds.join(','));
    if (query.size) req.path += (req.path.includes('?') ? '&' : '?') + query.toString();
    const r = await this.api.read({ ...req, auth: true });
    const data = pageData(r.value, page, size);
    if (kind === 'holdings') {
      for (const item of data.items) {
        if (item.UserTotal !== undefined && item.Current !== undefined)
          item.estimatedMarketValue = decimal(item.UserTotal).mul(decimal(item.Current)).toFixed();
      }
    }
    if (kind === 'auctions') {
      for (const item of data.items)
        item.clientStateInterpretation =
          Number(item.State) === 0 ? 'active' : Number(item.State) === 1 ? 'successful' : 'other_not_active';
    }
    return result(r, data);
  }
  async priceHistory(characterId: number, since: string, page: number, size: number) {
    const r = await this.api.read({ path: `chara/charts/${characterId}/${since}` });
    return result(r, historyPageData(r.value, page, size, 'Time'));
  }
  async trading(characterId: number, historyPage = 1, historyPageSize = 100) {
    await this.account();
    const r = await this.api.read({ path: `chara/user/${characterId}`, auth: true });
    const v = object(r.value);
    decimal(v.Amount);
    decimal(v.Balance);
    if (String(v.Id) !== this.api.session.account)
      throw new AppError('ACCOUNT_CHANGED', '交易资料不属于当前账号。');
    if (!Array.isArray(v.Bids) || !Array.isArray(v.Asks))
      throw new AppError('SCHEMA', '交易资料缺少委托列表。');
    const frozenBids = v.Bids.reduce(
      (sum: any, b: any) => sum.plus(decimal(b.Price).mul(decimal(b.Amount))),
      decimal('0'),
    ).toFixed();
    const data = safeData(v);
    const historyPagination: Record<string, unknown> = {};
    for (const field of ['AskHistory', 'BidHistory']) {
      if (v[field] === undefined || v[field] === null) {
        if (v[field] === null) data[field] = null;
        historyPagination[field] = null;
        continue;
      }
      const history = historyPageData(v[field], historyPage, historyPageSize, 'TradeTime');
      data[field] = history.items;
      historyPagination[field] = history.pagination;
    }
    return result(r, { ...data, historyPagination, estimatedFrozenBidPrincipal: frozenBids });
  }
  async breakdown(page: number, size: number) {
    const overview = await this.overview();
    const parts: Record<string, unknown> = {};
    let requestsSucceeded = true,
      requestedPagesComplete = true,
      allAssetsComplete = true;
    for (const kind of ['holdings', 'temples', 'ico', 'auctions', 'items']) {
      try {
        const part = await this.accountList(kind, page, size);
        parts[kind] = part;
        requestedPagesComplete &&= part.data.pagination.pageComplete;
        allAssetsComplete &&= part.data.pagination.complete;
      } catch (e) {
        requestsSucceeded = requestedPagesComplete = allAssetsComplete = false;
        parts[kind] = { error: publicError(e) };
      }
    }
    return {
      ...overview,
      data: {
        account: overview.data,
        parts,
        completeness: { requestsSucceeded, requestedPagesComplete, allAssetsComplete },
      },
    };
  }
  async ico(characterId: number, investment?: string, includeDetails = false) {
    const r = await this.api.read({ path: `chara/${characterId}` });
    const v = object(r.value);
    if (Object.hasOwn(v, 'Current')) throw new AppError('NOT_ICO', '该角色当前已上市。');
    decimal(v.Total);
    if (!Number.isSafeInteger(Number(v.Users)) || Number(v.Users) < 0)
      throw new AppError('SCHEMA', '缺少 ICO 参与人数。');
    return result(r, {
      server: safeData(v),
      prediction: icoPrediction(String(v.Total), Number(v.Users), investment, includeDetails),
    });
  }
  async templeAnalysis(characterId: number, includeDetails = false) {
    const r = await this.accountList('temples', 1, 100, characterId);
    const page = r.data as ReturnType<typeof pageData>;
    const v = page.items.find((v: any) => Number(v.CharacterId) === characterId);
    if (!v) throw new AppError('NO_TEMPLE', '当前账号未查到该角色圣殿。');
    return {
      observedAt: r.observedAt,
      serverTime: r.serverTime,
      data: { characterId, scope: 'single_temple', ...templeIncome(v, includeDetails) },
    };
  }
  async dividendForecast() {
    const r = await this.api.read({ path: 'event/share/bonus/test', auth: true });
    const v = object(r.value);
    return result(r, {
      scope: 'account',
      interestBearingShares: decimal(v.Total).toFixed(),
      templeCount: decimal(v.Temples).toFixed(),
      estimatedDividend: decimal(v.Share).toFixed(2),
      estimatedTax: decimal(v.Tax).toFixed(2),
      dailyBonus: decimal(v.Daily).toFixed(2),
    });
  }
}
