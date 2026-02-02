import cfg from "./config.js"
import { getActiveAccount } from "./store.js"
import { ensureSklandUserId } from "./account.js"
import { getCardDetail } from "./skland/client.js"
import { updateAliasMapFromChars } from "./alias.js"

const KEY_CARD_DETAIL = (userId, uid) => `Yz:EndUID:CardDetail:${userId}:${uid}`

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export async function getCardDetailForUser(userId, { force = false } = {}) {
  const { account } = await getActiveAccount(userId)
  if (!account?.cred || !account?.uid) {
    return { ok: false, message: "[终末地] 未绑定账号，请先私聊 #zmd绑定 / #zmd登录" }
  }

  const uid = String(account.uid)
  const cacheSec = Math.max(0, Number(cfg.card?.cacheSec) || 0)
  const cacheKey = KEY_CARD_DETAIL(userId, uid)

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
    return { ok: false, message: `[终末地] 获取卡片详情异常：${err?.message || err}` }
  }

  if (!res) return { ok: false, message: "[终末地] 获取卡片详情失败（请求失败）" }
  if (res.code !== 0) return { ok: false, message: `[终末地] 获取卡片详情失败：${res.message || res.code}` }

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

  return { ok: true, account, res, fromCache: false }
}
