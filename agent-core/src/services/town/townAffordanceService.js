/**
 * M2：场所能力（affordance）——每个地点「能提供哪些生活动作」的显式声明层。
 *
 * 只认结构化配置（town_locations.business_kind / kind），不从建筑名字猜测营业能力
 * （town-update.md §6.3 场所配置：无服务的住宅、地标不因名字像餐馆就获得能力）。
 * M2 以预置供给验证动作（公共餐食/读物），消费结算与库存联动在 M4 接入。
 * 注意：此处「可提供动作」与玩家互动权限（service/trade capabilities）是不同层次，
 * 不扩大也不替代既有权限检查。
 */

/** 生活动作目录（与 townActionRunner 的 life_* 类型一一对应）。 */
export const LIFE_OFFER_TYPES = Object.freeze(['eat', 'read', 'sit']);

/**
 * 由地点行推导生活供给目录。
 * @param {Array} locations 运行实例的地点视图 [{ key, kind, businessKind, x, y }]
 * @returns {Array} [{ key, offers, business, x, y }]，只含有供给的地点；
 *          business=true 表示经营性场所（参与 M4 补货/账目），住宅类供给不参与经营
 */
export function listLifeVenues(locations) {
  const venues = [];
  for (const loc of locations || []) {
    if (!loc?.key || !Number.isInteger(loc.x) || !Number.isInteger(loc.y)) continue;
    const offers = [];
    let business = false;
    if (loc.businessKind === 'tavern' || loc.businessKind === 'cafe') { offers.push('eat'); business = true; }
    if (loc.businessKind === 'study') { offers.push('read', 'sit'); business = true; }
    if (loc.kind === 'home') offers.push('eat', 'sit');   // 自己家：预置食物与落座（非经营）
    if (loc.kind === 'outdoor') offers.push('sit');       // 广场/长椅等露天休憩点（非经营）
    if (offers.length > 0) venues.push({ key: loc.key, offers, business, x: loc.x, y: loc.y });
  }
  return venues;
}
