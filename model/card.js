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
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import { getActiveAccount } from "./store.js"
import { ensureSklandUserId } from "./account.js"
import { getCardDetail } from "./skland/client.js"
import { updateAliasMapFromChars } from "./alias.js"
import { LEGACY_PLUGIN_DATA_DIR, PLUGIN_DATA_DIR } from "./pluginMeta.js"

// 保留历史 key 命名空间：避免老用户缓存失效或迁移困难。
const KEY_CARD_DETAIL = (userId, uid) => `Yz:EndUID:CardDetail:${userId}:${uid}`
const KEY_CARD_DETAIL_STALE = (userId, uid) => `Yz:EndUID:CardDetailStale:${userId}:${uid}`

const FILE_DATA_DIR = path.join(PLUGIN_DATA_DIR, "card")
const FILE_DATA_DIR_LEGACY = path.join(LEGACY_PLUGIN_DATA_DIR, "card")

function sanitizeFilename(name) {
  return String(name || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
}

function cardFilePaths(userId, uid) {
  const u = sanitizeFilename(uid)
  const q = sanitizeFilename(userId)
  const name = `${q}_${u}.json`
  return {
    filePath: path.join(FILE_DATA_DIR, name),
    legacyPath: path.join(FILE_DATA_DIR_LEGACY, name),
  }
}

async function saveJson(filePath, data) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(data), "utf8")
  } catch {}
}

async function loadJson(filePath) {
  if (!filePath || !fsSync.existsSync(filePath)) return null
  try {
    const raw = await fs.readFile(filePath, "utf8")
    const data = safeJsonParse(raw, null)
    return data && typeof data === "object" ? data : null
  } catch {
    return null
  }
}

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

  const { filePath, legacyPath } = cardFilePaths(userId, uid)

  // A longer-lived cache used as fallback when live requests fail.
  const staleCacheSec = Math.max(0, Number(cfg.card?.staleCacheSec) || 0)
  const staleKey = KEY_CARD_DETAIL_STALE(userId, uid)
  let staleRes = null
  let staleUpdatedAt = 0
  if (staleCacheSec > 0) {
    try {
      const cached = await redis.get(staleKey)
      const parsed = cached ? safeJsonParse(cached, null) : null
      if (parsed?.res?.code === 0) {
        staleRes = parsed.res
        staleUpdatedAt = Number(parsed.updatedAt) || 0
      }
    } catch {}
  }

  // Local persistent cache (data/card/*.json), used as fallback when requests fail.
  try {
    let local = await loadJson(filePath)
    let fromLegacy = false
    if (!local) {
      local = await loadJson(legacyPath)
      fromLegacy = !!local
    }
    if (local?.res?.code === 0) {
      const ts = Number(local.updatedAt) || 0
      if (!staleRes || ts >= staleUpdatedAt) {
        staleRes = local.res
        staleUpdatedAt = ts
      }

      // Best-effort: migrate legacy cache to the new bot-level data dir.
      if (fromLegacy) saveJson(filePath, local).catch(() => {})
    }
  } catch {}

  // 缓存按 QQ userId + 游戏 UID 作为 key。
  if (!force && cacheSec > 0) {
    try {
      const cached = await redis.get(cacheKey)
      const parsed = cached ? safeJsonParse(cached, null) : null
      if (parsed?.res?.code === 0) {
        // Best-effort: persist the cache to local disk.
        saveJson(filePath, { updatedAt: Number(parsed.updatedAt) || Date.now(), res: parsed.res }).catch(() => {})
        return { ok: true, account, res: parsed.res, fromCache: true }
      }
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
    if (staleRes) {
      // Ensure persisted cache exists even when Redis gets cleared.
      saveJson(filePath, { updatedAt: staleUpdatedAt || Date.now(), res: staleRes }).catch(() => {})
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
    if (staleRes) {
      saveJson(filePath, { updatedAt: staleUpdatedAt || Date.now(), res: staleRes }).catch(() => {})
      return { ok: true, account, res: staleRes, fromCache: true, stale: true, error: "[终末地] 获取卡片详情失败（请求失败）" }
    }
    return { ok: false, message: "[终末地] 获取卡片详情失败（请求失败）" }
  }
  if (res.code !== 0) {
    if (staleRes) {
      saveJson(filePath, { updatedAt: staleUpdatedAt || Date.now(), res: staleRes }).catch(() => {})
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

  // Persist to disk (no TTL). Best-effort.
  saveJson(filePath, { updatedAt: Date.now(), res }).catch(() => {})

  return { ok: true, account, res, fromCache: false }
}
