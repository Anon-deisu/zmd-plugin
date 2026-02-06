/**
 * 签到统计。
 *
 * 记录每天的成功/已签/失败聚合计数，存储为 Redis hash。
 * 当提供 uid 时会按“每天每个 UID 一条状态”去重并覆盖（后写状态生效），
 * 避免重复触发导致统计虚高。
 *
 * 并设置滚动过期（默认 14 天）。
 */
const KEY_SIGN_STATS = dateStr => `Yz:EndUID:SignStats:${dateStr}`
const KEY_SIGN_USER_STATE = dateStr => `Yz:EndUID:SignStatsUser:${dateStr}`
const EXPIRE_DAYS = 14
const SHANGHAI_TZ = "Asia/Shanghai"
const FIELDS = new Set(["success", "signed", "fail"])

function pad2(n) {
  return String(n).padStart(2, "0")
}

function toDateStr(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d)
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: SHANGHAI_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(dt)
  } catch {
    // 兜底：Intl 不可用时退回本地时区日期。
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
  }
}

function getYesterdayDateStr(d = new Date()) {
  const [y, m, day] = toDateStr(d)
    .split("-")
    .map(n => Number.parseInt(n, 10))
  if (![y, m, day].every(n => Number.isFinite(n))) {
    const fallback = d instanceof Date ? new Date(d.getTime()) : new Date(d)
    fallback.setDate(fallback.getDate() - 1)
    return toDateStr(fallback)
  }

  const prev = new Date(Date.UTC(y, m - 1, day) - 86400 * 1000)
  return `${prev.getUTCFullYear()}-${pad2(prev.getUTCMonth() + 1)}-${pad2(prev.getUTCDate())}`
}

async function touchExpire(dateStr) {
  const ttl = 86400 * EXPIRE_DAYS
  await redis.expire(KEY_SIGN_STATS(dateStr), ttl)
  await redis.expire(KEY_SIGN_USER_STATE(dateStr), ttl)
}

async function recordUnique(dateStr, field, uid) {
  const id = String(uid || "").trim()
  if (!id || !FIELDS.has(field)) return false

  const statKey = KEY_SIGN_STATS(dateStr)
  const stateKey = KEY_SIGN_USER_STATE(dateStr)
  try {
    const prev = String((await redis.hGet(stateKey, id)) || "").trim()
    if (prev === field) {
      await touchExpire(dateStr)
      return true
    }

    if (FIELDS.has(prev)) {
      const prevCount = Number(await redis.hGet(statKey, prev)) || 0
      if (prevCount > 0) await redis.hIncrBy(statKey, prev, -1)
    }
    await redis.hSet(stateKey, id, field)
    await redis.hIncrBy(statKey, field, 1)
    await touchExpire(dateStr)
    return true
  } catch {
    return false
  }
}

async function incr(dateStr, field, count, { uid } = {}) {
  if (uid != null && String(uid).trim()) {
    const ok = await recordUnique(dateStr, field, uid)
    if (ok) return
  }

  const n = Number(count) || 0
  if (n <= 0) return
  const key = KEY_SIGN_STATS(dateStr)
  try {
    await redis.hIncrBy(key, field, n)
    await touchExpire(dateStr)
  } catch {}
}

export async function recordSuccess(count = 1, { date, uid } = {}) {
  return incr(toDateStr(date), "success", count, { uid })
}

export async function recordSigned(count = 1, { date, uid } = {}) {
  return incr(toDateStr(date), "signed", count, { uid })
}

export async function recordFail(count = 1, { date, uid } = {}) {
  return incr(toDateStr(date), "fail", count, { uid })
}

export async function getCounts(dateStr) {
  const key = KEY_SIGN_STATS(String(dateStr || "").trim())
  try {
    const raw = (await redis.hGetAll(key)) || {}
    return {
      success: Math.max(0, Number(raw.success) || 0),
      signed: Math.max(0, Number(raw.signed) || 0),
      fail: Math.max(0, Number(raw.fail) || 0),
    }
  } catch {
    return { success: 0, signed: 0, fail: 0 }
  }
}

export async function getTodayCounts() {
  return getCounts(toDateStr())
}

export async function getYesterdayCounts() {
  return getCounts(getYesterdayDateStr())
}
