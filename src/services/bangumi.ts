import { BangumiClient } from '../api/bangumi.js';
import type { ApiResult } from '../api/client.js';
import { AppError, object, pick } from '../core.js';

export interface BangumiCharacter {
  characterId: number;
  name: string;
  nameCn: string;
  avatar: string | null;
}
export interface BangumiCharacterRelation {
  character: BangumiCharacter;
  relation: {
    id: number;
    name: string;
    description: string;
    primary?: boolean;
    skipViceVersa?: boolean;
    viceVersaTo?: number;
  };
  spoiler: boolean;
  ended: boolean;
  comment: string;
}
function identity(v: any) {
  if (!Number.isSafeInteger(v.id) || v.id < 1 || typeof v.name !== 'string')
    throw new AppError('BANGUMI_SCHEMA', 'Bangumi 条目缺少有效 ID 或名称。');
}
export function bangumiCharacter(raw: unknown): BangumiCharacter {
  const v = object(raw);
  identity(v);
  const cn = v.nameCN ?? v.name_cn ?? v.infobox?.find?.((f: any) => f.key === '简体中文名')?.value;
  return {
    characterId: v.id,
    name: v.name,
    nameCn: typeof cn === 'string' ? cn : '',
    avatar: v.images?.small ?? v.images?.medium ?? null,
  };
}
function subject(raw: unknown) {
  const v = object(raw);
  identity(v);
  if (!Number.isInteger(v.type)) throw new AppError('BANGUMI_SCHEMA', 'Bangumi 作品缺少类型。');
  return {
    subjectId: v.id,
    name: v.name,
    nameCn: v.name_cn ?? v.nameCN ?? '',
    type: v.type,
    ...pick(v, ['platform', 'date', 'info']),
    cover: v.images?.common ?? v.images?.small ?? null,
  };
}
function pageResult(r: ApiResult, page: number, pageSize: number, map: (v: any) => any) {
  const v = object(r.value),
    offset = (page - 1) * pageSize;
  if (
    !Array.isArray(v.data) ||
    !Number.isSafeInteger(v.total) ||
    v.total < 0 ||
    (v.offset !== undefined && v.offset !== offset) ||
    (v.limit !== undefined && v.limit !== pageSize)
  )
    throw new AppError('BANGUMI_SCHEMA', 'Bangumi 分页响应格式不匹配。');
  const nextOffset = offset + v.data.length;
  return {
    data: {
      items: v.data.map(map),
      pagination: {
        page,
        pageSize,
        offset,
        returned: v.data.length,
        totalItems: v.total,
        totalPages: Math.ceil(v.total / pageSize),
        hasMore: nextOffset < v.total,
        nextOffset: nextOffset < v.total ? nextOffset : null,
      },
    },
    observedAt: r.observedAt,
  };
}
const paging = (page: number, size: number) => `limit=${size}&offset=${(page - 1) * size}`;
export class BangumiQueries {
  constructor(public client = new BangumiClient()) {}
  async searchCharacters(keyword: string, page: number, size: number) {
    const r = await this.client.request('v0', `search/characters?${paging(page, size)}`, {
      keyword,
      filter: {},
    });
    return pageResult(r, page, size, bangumiCharacter);
  }
  async searchSubjects(keyword: string, page: number, size: number, types?: number[], sort = 'match') {
    const r = await this.client.request('v0', `search/subjects?${paging(page, size)}`, {
      keyword,
      sort,
      filter: types?.length ? { type: types } : {},
    });
    return pageResult(r, page, size, subject);
  }
  async subject(subjectId: number, includeDetails = false) {
    const r = await this.client.request('v0', `subjects/${subjectId}`),
      v = object(r.value);
    return {
      data: {
        ...subject(v),
        ...pick(v, ['summary', 'eps', 'volumes', 'total_episodes']),
        rating: v.rating ? pick(v.rating, ['score', 'rank', 'total']) : null,
        ...(includeDetails ? pick(v, ['infobox', 'tags', 'images']) : {}),
      },
      observedAt: r.observedAt,
    };
  }
  async character(characterId: number, includeDetails = false) {
    const r = await this.client.request('v0', `characters/${characterId}`),
      v = object(r.value);
    return {
      data: {
        ...bangumiCharacter(v),
        ...pick(v, ['summary', 'type', 'gender']),
        ...(includeDetails
          ? pick(v, ['infobox', 'images', 'birth_year', 'birth_mon', 'birth_day', 'blood_type'])
          : {}),
      },
      observedAt: r.observedAt,
    };
  }
  async subjectCharacters(subjectId: number, page: number, size: number, appearanceType?: number) {
    const r = await this.client.request(
      'p1',
      `subjects/${subjectId}/characters?${paging(page, size)}${appearanceType === undefined ? '' : `&type=${appearanceType}`}`,
    );
    return pageResult(r, page, size, (v) => ({
      character: bangumiCharacter(v.character),
      appearanceType: v.type,
      order: v.order,
    }));
  }
  async casts(
    characterId: number,
    page: number,
    size: number,
    subjectType?: number,
    appearanceType?: number,
  ) {
    const r = await this.client.request(
      'p1',
      `characters/${characterId}/casts?${paging(page, size)}${subjectType === undefined ? '' : `&subjectType=${subjectType}`}${appearanceType === undefined ? '' : `&type=${appearanceType}`}`,
    );
    return pageResult(r, page, size, (v) => ({ subject: subject(v.subject), appearanceType: v.type }));
  }
  async relations(characterId: number, page: number, size: number) {
    const r = await this.client.request('p1', `characters/${characterId}/relations?${paging(page, size)}`);
    return pageResult(r, page, size, (v): BangumiCharacterRelation => {
      const rel = object(v.relation);
      if (
        !Number.isInteger(rel.id) ||
        typeof rel.cn !== 'string' ||
        typeof rel.desc !== 'string' ||
        typeof v.spoiler !== 'boolean' ||
        typeof v.ended !== 'boolean' ||
        typeof v.comment !== 'string'
      )
        throw new AppError('BANGUMI_SCHEMA', 'Bangumi 人物关系字段不完整。');
      return {
        character: bangumiCharacter(v.character),
        relation: {
          id: rel.id,
          name: rel.cn,
          description: rel.desc,
          ...pick(rel, ['primary', 'skipViceVersa', 'viceVersaTo']),
        },
        spoiler: v.spoiler,
        ended: v.ended,
        comment: v.comment,
      };
    });
  }
}
