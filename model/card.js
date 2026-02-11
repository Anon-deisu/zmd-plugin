/**
 * 卡片详情获取与缓存。
 *
 * apps/card.js / apps/build.js / apps/enduid.js 等都会用到同一份“卡片详情”。
 * 这里统一处理：
 * - 从 Redis 读取当前激活账号
 * - 调用 Skland 接口获取详情
 * - 可选 Redis 缓存（减少频繁请求）
 * - 基于角色列表刷新别名库（便于后续按别名查询）
 */
import cfg from "./config.js"
import { getActiveAccount } from "./store.js"
import { ensureSklandUserId } from "./account.js"
import { getCardDetail } from "./skland/client.js"
import { updateAliasMapFromChars } from "./alias.js"

// 保留历史 key 命名空间：避免老用户缓存失效或迁移困难。
const KEY_CARD_DETAIL = (userId, uid) => `Yz:EndUID:CardDetail:${userId}:${uid}`
const KEY_CARD_DETAIL_STALE = (userId, uid) => `Yz:EndUID:CardDetailStale:${userId}:${uid}`

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export async function getCardDetailForUser(userId, { force = false } = {}) {
  const { account } = await getActiveAccount(userId)
  if (!account?.uid) {
    return { ok: false, message: "[终末地] 未绑定账号，请先私聊 #zmd绑定 / #zmd登录" }
  }
  if (!account?.cred) {
    if (account?.uidOnly) {
      return { ok: false, message: "[终末地] 当前账号仅绑定UID（仅面板），不支持该功能；如需完整功能请私聊 #zmd绑定<cred|token>" }
    }
    return { ok: false, message: "[终末地] 未绑定账号，请先私聊 #zmd绑定 / #zmd登录" }
  }

  const uid = String(account.uid)
  const cacheSec = Math.max(0, Number(cfg.card?.cacheSec) || 0)
  const cacheKey = KEY_CARD_DETAIL(userId, uid)

  // A longer-lived cache used as fallback when live requests fail.
  const staleCacheSec = Math.max(0, Number(cfg.card?.staleCacheSec) || 0)
  const staleKey = KEY_CARD_DETAIL_STALE(userId, uid)
  let staleRes = null
  if (staleCacheSec > 0) {
    try {
      const cached = await redis.get(staleKey)
      const parsed = cached ? safeJsonParse(cached, null) : null
      if (parsed?.res?.code === 0) staleRes = parsed.res
    } catch {}
  }

  // 缓存按 QQ userId + 游戏 UID 作为 key。
  if (!force && cacheSec > 0) {
    try {
      const cached = await redis.get(cacheKey)
      const parsed = cached ? safeJsonParse(cached, null) : null
      if (parsed?.res?.code === 0) return { ok: true, account, res: parsed.res, fromCache: true }
    } catch {}
  }

  let sklandUserId = String(account.sklandUserId || "").trim()
  try {
    if (!sklandUserId) sklandUserId = await ensureSklandUserId(account.cred, account, userId)
  } catch {}

  if (!sklandUserId) {
    return { ok: false, message: "[终末地] 缺少 skland userId，且自动获取失败，请先检查 #zmd环境" }
  }

  let res
  try {
    res = await getCardDetail(account.cred, { uid, serverId: account.serverId || "1", userId: sklandUserId })
  } catch (err) {
    if (!force && staleRes) {
      return {
        ok: true,
        account,
        res: staleRes,
        fromCache: true,
        stale: true,
        error: `[终末地] 获取卡片详情异常：${err?.message || err}`,
      }
    }
    return { ok: false, message: `[终末地] 获取卡片详情异常：${err?.message || err}` }
  }

  if (!res) {
    if (!force && staleRes) {
      return { ok: true, account, res: staleRes, fromCache: true, stale: true, error: "[终末地] 获取卡片详情失败（请求失败）" }
    }
    return { ok: false, message: "[终末地] 获取卡片详情失败（请求失败）" }
  }
  if (res.code !== 0) {
    if (!force && staleRes) {
      return {
        ok: true,
        account,
        res: staleRes,
        fromCache: true,
        stale: true,
        error: `[终末地] 获取卡片详情失败：${res.message || res.code}`,
      }
    }
    return { ok: false, message: `[终末地] 获取卡片详情失败：${res.message || res.code}` }
  }

  // 尽力而为：用最新角色列表刷新别名库（失败不影响主流程）。
  try {
    await updateAliasMapFromChars(res?.data?.detail?.chars || [])
  } catch {}

  if (cacheSec > 0) {
    try {
      await redis.setEx(cacheKey, cacheSec, JSON.stringify({ updatedAt: Date.now(), res }))
    } catch {
      try {
        await redis.set(cacheKey, JSON.stringify({ updatedAt: Date.now(), res }), { EX: cacheSec })
      } catch {}
    }
  }

  if (staleCacheSec > 0) {
    try {
      await redis.setEx(staleKey, staleCacheSec, JSON.stringify({ updatedAt: Date.now(), res }))
    } catch {
      try {
        await redis.set(staleKey, JSON.stringify({ updatedAt: Date.now(), res }), { EX: staleCacheSec })
      } catch {}
    }
  }

  return { ok: true, account, res, fromCache: false }
}
