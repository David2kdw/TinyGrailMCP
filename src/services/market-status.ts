import { object, pick } from '../core.js';

export type MarketStatus =
  'listed' | 'ico_active' | 'ico_ended' | 'ico_pending' | 'not_in_market' | 'other' | 'unknown';
function tinygrailTime(value: unknown) {
  if (typeof value !== 'string') return NaN;
  const iso = value.replace(' ', 'T');
  // TinyGrail's timezone-free dates are China Standard Time.
  return Date.parse(iso + (/Z$|[+-]\d\d:\d\d$/.test(iso) ? '' : '+08:00'));
}
export function marketStatus(raw: unknown, now: number) {
  const v = object(raw);
  let status: MarketStatus = 'unknown';
  if (Object.hasOwn(v, 'Current') && v.Current !== null) status = 'listed';
  else if (v.State !== undefined && Number(v.State) !== 0) status = 'other';
  else if (v.End !== undefined && Number.isFinite(tinygrailTime(v.End))) {
    const begin = tinygrailTime(v.Begin);
    status = tinygrailTime(v.End) <= now ? 'ico_ended' : begin > now ? 'ico_pending' : 'ico_active';
  }
  return {
    status,
    ...pick(v, ['Name', 'State']),
    ...(status === 'listed'
      ? pick(v, ['Current', 'Level', 'Total', 'MarketValue'])
      : { icoId: v.Id, ...pick(v, ['Begin', 'End', 'Total', 'Users']) }),
  };
}
