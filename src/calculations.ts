import { Decimal } from 'decimal.js';
import { AppError } from './core.js';
Decimal.set({ precision: 40 });
export const D = (v: string | number) => new Decimal(v);
export function decimal(v: unknown): Decimal {
  if (typeof v !== 'string' && typeof v !== 'number') throw new AppError('SCHEMA', '缺少必要金额或数量。');
  let n: Decimal;
  try {
    n = D(v);
  } catch {
    throw new AppError('SCHEMA', '金额或数量的十进制格式无效。');
  }
  if (!n.isFinite()) throw new AppError('SCHEMA', '金额或数量不是有限值。');
  return n;
}
export function budget(price: string, amount: number, feeRate = '0') {
  const subtotal = D(price).mul(amount);
  const fee = subtotal.mul(feeRate);
  return {
    observedAt: new Date().toISOString(),
    inputs: { price, amount, feeRate },
    subtotal: subtotal.toFixed(),
    fee: fee.toFixed(),
    total: subtotal.plus(fee).toFixed(),
  };
}
export const FORMULA_SOURCE =
  'https://github.com/koorinyaa/magrail_app/blob/90f7b26de0474e03df4981684e3a4bc43d6a7275/lib/features/user/analysis/model/user_asset_analysis_calculations.dart';
export function templeIncome(v: Record<string, any>, includeDetails = false) {
  const rank = decimal(v.CharacterRank),
    stars = decimal(v.CharacterStars),
    assets = decimal(v.Assets);
  let single: Decimal;
  if (rank.gt(0) && rank.lte(500)) {
    const level = decimal(v.CharacterLevel),
      refine = decimal(v.Refine);
    single = decimal(v.Rate)
      .mul('0.005')
      .mul(D(601).minus(rank))
      .div(level.mul(2).plus(1))
      .mul(level.plus(refine).mul(2).plus(1));
  } else single = stars.mul(2);
  return {
    inputs: {
      assets: assets.toFixed(),
      rank: rank.toFixed(),
      ...(rank.gt(0) && rank.lte(500)
        ? {
            level: decimal(v.CharacterLevel).toFixed(),
            refine: decimal(v.Refine).toFixed(),
            rate: decimal(v.Rate).toFixed(),
          }
        : { stars: stars.toFixed() }),
    },
    estimatedDividendPerShare: single.toFixed(4),
    estimatedIncome: single.mul(assets).toFixed(2),
    ...(includeDetails
      ? {
          details: {
            formula: 'magrail-temple-income/90f7b26',
            source: FORMULA_SOURCE,
            serverRuleVerified: false,
            unrounded: { dividendPerShare: single.toFixed(), income: single.mul(assets).toFixed() },
          },
        }
      : {}),
  };
}
export function icoPrediction(total: string, users: number, investment?: string, includeDetails = false) {
  let level = 0,
    next = D(600000);
  const head = Math.max(Math.floor((users - 10) / 5), 0);
  while (D(total).gte(next) && level < head && level < 10000) {
    level++;
    next = next.plus(
      D(level + 1)
        .pow(2)
        .mul(100000),
    );
  }
  const shares = D(10000 + (level - 1) * 7500),
    price = Decimal.max(D(total).minus(500000).div(shares), 10);
  return {
    level,
    nextTotal: next.toFixed(),
    issuedShares: shares.toFixed(),
    estimatedListingLevel: Decimal.max(
      shares.div(7500).ln().div(D('1.3').ln()).plus(1).floor(),
      0,
    ).toNumber(),
    displayPrice: price.toFixed(2),
    nextUsersNeeded: Math.max(0, (level + 1) * 5 + 10 - users),
    ...(investment
      ? {
          estimatedShares: D(investment)
            .div(price.plus(D(500000).div(shares)))
            .floor()
            .toFixed(),
        }
      : {}),
    ...(includeDetails
      ? {
          details: {
            formula: 'magrail-ico/90f7b26',
            source:
              'https://github.com/koorinyaa/magrail_app/blob/90f7b26de0474e03df4981684e3a4bc43d6a7275/lib/features/chara/detail/model/character_detail_ico_prediction.dart',
            serverRuleVerified: false,
            unroundedPrice: price.toFixed(),
          },
        }
      : {}),
  };
}
