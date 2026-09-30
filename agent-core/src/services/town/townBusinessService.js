/**
 * M4：基础经营闭环（town-update.md §6.5 的最小实现）。
 *
 * 账务全部走 economyService 复式账本（金钱总和恒为零），本模块不直接改余额/库存：
 * - 工资：work_shift 完成后从**场所经营账户**转账给居民，来源键 wage:{actionId}
 *   只支付一次；账户余额不足时不悄悄增发（返回 insufficient，由救助/缩减逻辑接手）。
 * - 消费：life_eat 完成后居民付饭钱（居民→经营账户）；余额不足走免费公共餐食
 *   （不发生账目，小镇默认温和）；每份餐同时消耗经营库存（预留+核销分段事务）。
 * - 补货：库存低于阈值时经营账户向外部供应商付款并转入食材；按小时桶记来源键，
 *   外部供给是**来源明确的资金/物资流入**（供应商库存按日经 seedStock 发行）。
 *
 * 历史账目保持历史含义；启动资金 seed 一次性（seedVersion 1，与旧开店时代 v2 补助并存）。
 */
import { createEconomyService } from './economyService.js';

const MEAL_RESOURCE = 'meal';
const EXTERNAL_SUPPLIER_OWNER = 'external:supplier';

const venueOwnerKey = (mapId, venueKey) => `venue:${mapId}:${venueKey}`;
const dayNumber = nowUtcMs => Math.floor(nowUtcMs / 86400000);

export function createTownBusinessService({ db, registry, businessConfig }) {
  if (!db?.prepare || !registry?.getWorldEpoch || !businessConfig) throw new TypeError('townBusinessService missing dependency');
  const economy = createEconomyService({ db, clock: { now: Date.now },
    getWorldEpoch: registry.getWorldEpoch, getActor: registry.getActor });
  const swallow = error => ['SOURCE_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(error?.code);

  /** 场所经营账户（不存在则建并一次性注入启动资金；重复执行不重复发放）。 */
  function ensureVenueAccount({ worldId, worldEpoch, mapId, venueKey, nowUtcMs }) {
    const ownerKey = venueOwnerKey(mapId, venueKey);
    const account = economy.ensureAccount({ worldId, worldEpoch, ownerKey, accountType: 'business' });
    try {
      economy.seed({ worldId, worldEpoch, accountId: account.accountId, amount: businessConfig.venueSeed,
        seedVersion: 1, idempotencyKey: `venue-seed:${account.accountId}`, reasonCode: 'VENUE_OPENING_GRANT' });
    } catch (error) { if (!swallow(error)) throw error; }
    return account;
  }

  /** 居民账户（玩家已有开局补助 v2，这里只给非玩家居民一次性有限启动资金）。 */
  function ensureActorAccount({ worldId, worldEpoch, actorId }) {
    const account = economy.ensureAccount({ worldId, worldEpoch, ownerKey: `actor:${actorId}`, actorId, accountType: 'actor' });
    const actor = registry.getActor(actorId, worldId, { followMerged: false });
    if (actor?.playerId) return account; // 玩家：由 townResponsibilityRuntime 的 seed v2 负责
    try {
      economy.seed({ worldId, worldEpoch, accountId: account.accountId, amount: businessConfig.actorSeed,
        seedVersion: 1, idempotencyKey: `actor-seed:${account.accountId}`, reasonCode: 'RESIDENT_OPENING_GRANT' });
    } catch (error) { if (!swallow(error)) throw error; }
    return account;
  }

  function ensureVenueStock({ worldId, worldEpoch, mapId, venueKey }) {
    return economy.ensureStock({ worldId, worldEpoch, ownerKey: venueOwnerKey(mapId, venueKey), resourceKey: MEAL_RESOURCE });
  }

  /** 外部供应商：资金账户与食材库存都是明确的外部流入出口（不参与居民间循环）。 */
  function ensureSupplier({ worldId, worldEpoch }) {
    const account = economy.ensureAccount({ worldId, worldEpoch, ownerKey: EXTERNAL_SUPPLIER_OWNER, accountType: 'fund' });
    const stock = economy.ensureStock({ worldId, worldEpoch, ownerKey: EXTERNAL_SUPPLIER_OWNER, resourceKey: MEAL_RESOURCE });
    // 每日一次的外部食材到货（按天号做 seedVersion，重复执行不重复到货）
    try {
      economy.seedStock({ worldId, worldEpoch, stockId: stock.stockId,
        amount: businessConfig.supplierDailyImport, seedVersion: dayNumber(Date.now()),
        idempotencyKey: `supplier-import:${stock.stockId}:${dayNumber(Date.now())}`,
        reasonCode: 'EXTERNAL_SUPPLY_IMPORT' });
    } catch (error) { if (!swallow(error)) throw error; }
    return { account, stock };
  }

  /**
   * 发工资：场所经营账户 → 居民。同一 work_shift 动作只支付一次；
   * 余额不足不增发。@returns {'paid'|'insufficient'}
   */
  function payWageFromVenue({ worldId, worldEpoch, mapId, venueKey, actorId, actionId, nowUtcMs }) {
    const venue = ensureVenueAccount({ worldId, worldEpoch, mapId, venueKey, nowUtcMs });
    const worker = ensureActorAccount({ worldId, worldEpoch, actorId });
    try {
      economy.transfer({ worldId, worldEpoch, fromAccountId: venue.accountId, toAccountId: worker.accountId,
        amount: businessConfig.wagePerShift, sourceKey: `wage:${actionId}`,
        idempotencyKey: `wage:${actionId}`, reasonCode: 'SHIFT_WAGE' });
      return 'paid';
    } catch (error) {
      if (error?.code === 'INSUFFICIENT_FUNDS') return 'insufficient';
      if (swallow(error)) return 'paid'; // 幂等重放：之前已支付
      throw error;
    }
  }

  /**
   * 消费收费：居民 → 经营账户，同时核销一份餐食库存（预留+核销两段，均可幂等恢复）。
   * @returns {'paid'|'public'} public = 居民余额不足，走免费公共餐食（不发生账目）
   */
  function chargeMeal({ worldId, worldEpoch, mapId, venueKey, actorId, actionId, nowUtcMs }) {
    const venue = ensureVenueAccount({ worldId, worldEpoch, mapId, venueKey, nowUtcMs });
    const diner = ensureActorAccount({ worldId, worldEpoch, actorId });
    const stock = ensureVenueStock({ worldId, worldEpoch, mapId, venueKey });
    // 库存交付（分段事务：两步各自幂等，中断后重试自愈）
    try {
      const reserved = economy.reserveStock({ worldId, worldEpoch, stockId: stock.stockId, amount: 1,
        ownerRef: `meal:${actionId}`, sourceKey: `meal-stock:${actionId}`,
        idempotencyKey: `meal-stock:${actionId}`, reasonCode: 'MEAL_STOCK' });
      economy.captureStock({ worldId, worldEpoch, reservationId: reserved.reservation.reservationId,
        expectedVersion: reserved.reservation.version, consume: true,
        sourceKey: `meal-capture:${actionId}`, idempotencyKey: `meal-capture:${actionId}`,
        reasonCode: 'MEAL_CONSUMED' });
    } catch (error) {
      if (!['INSUFFICIENT_STOCK', 'RESERVATION_OWNER_CONFLICT'].includes(error?.code) && !swallow(error)) throw error;
    }
    try {
      economy.transfer({ worldId, worldEpoch, fromAccountId: diner.accountId, toAccountId: venue.accountId,
        amount: businessConfig.mealPrice, sourceKey: `meal:${actionId}`,
        idempotencyKey: `meal:${actionId}`, reasonCode: 'MEAL_PURCHASE' });
      return 'paid';
    } catch (error) {
      if (error?.code === 'INSUFFICIENT_FUNDS') return 'public';
      if (swallow(error)) return 'paid';
      throw error;
    }
  }

  /**
   * 补货：餐食库存低于阈值时，经营账户向外部供应商付款并转入食材。
   * 付款与到货是两段（各自幂等，中断后重试自愈）；同一小时桶只补一次。
   * @returns {'bought'|'enough'|'insufficient'}
   */
  function procureStock({ worldId, worldEpoch, mapId, venueKey, nowUtcMs }) {
    const venue = ensureVenueAccount({ worldId, worldEpoch, mapId, venueKey, nowUtcMs });
    const stock = ensureVenueStock({ worldId, worldEpoch, mapId, venueKey });
    const current = db.prepare('SELECT quantity FROM town_resource_stocks WHERE stock_id = ?').get(stock.stockId)?.quantity ?? 0;
    if (current >= businessConfig.procureThreshold) return 'enough';
    const supplier = ensureSupplier({ worldId, worldEpoch });
    const bucket = Math.floor(nowUtcMs / businessConfig.procureIntervalMs);
    try {
      economy.transfer({ worldId, worldEpoch, fromAccountId: venue.accountId, toAccountId: supplier.account.accountId,
        amount: businessConfig.procureCost, sourceKey: `procure-pay:${venueOwnerKey(mapId, venueKey)}:${bucket}`,
        idempotencyKey: `procure-pay:${venueOwnerKey(mapId, venueKey)}:${bucket}`, reasonCode: 'STOCK_PROCUREMENT' });
    } catch (error) {
      if (error?.code === 'INSUFFICIENT_FUNDS') return 'insufficient';
      if (!swallow(error)) throw error;
    }
    try {
      economy.transferStock({ worldId, worldEpoch, fromStockId: supplier.stock.stockId, toStockId: stock.stockId,
        amount: businessConfig.procureBatch, sourceKey: `procure-stock:${venueOwnerKey(mapId, venueKey)}:${bucket}`,
        idempotencyKey: `procure-stock:${venueOwnerKey(mapId, venueKey)}:${bucket}`, reasonCode: 'STOCK_PROCUREMENT' });
      return 'bought';
    } catch (error) {
      if (error?.code === 'INSUFFICIENT_STOCK') return 'insufficient'; // 外部到货未及：下个桶再试
      if (!swallow(error)) throw error;
      return 'bought';
    }
  }

  return { ensureVenueAccount, ensureActorAccount, ensureVenueStock, ensureSupplier,
    payWageFromVenue, chargeMeal, procureStock };
}
