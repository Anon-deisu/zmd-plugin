/**
 * 签到统计。
 *
 * 仅记录每天的成功/失败聚合计数，存储为 Redis hash，
 * 并设置滚动过期（默认 14 天）。
 */
const KEY_SIGN_STATS = dateStr => `Yz:EndUID:SignStats:${dateStr}`
const EXPIRE_DAYS = 14

function pad2(n) {
  return String(n).padStart(2, "0")
}

function toDateStr(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d)
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
}

function getYesterdayDateStr() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return toDateStr(d)
}

async function incr(dateStr, field, count) {
  const n = Number(count) || 0
  if (n <= 0) return
  const key = KEY_SIGN_STATS(dateStr)
  try {
    await redis.hIncrBy(key, field, n)
    await redis.expire(key, 86400 * EXPIRE_DAYS)
  } catch {}
}

export async function recordSuccess(count = 1, { date } = {}) {
  return incr(toDateStr(date), "success", count)
}

export async function recordFail(count = 1, { date } = {}) {
  return incr(toDateStr(date), "fail", count)
}

export async function getCounts(dateStr) {
  const key = KEY_SIGN_STATS(String(dateStr || "").trim())
  try {
    const raw = (await redis.hGetAll(key)) || {}
    return {
      success: Number(raw.success) || 0,
      fail: Number(raw.fail) || 0,
    }
  } catch {
    return { success: 0, fail: 0 }
  }
}

export async function getTodayCounts() {
  return getCounts(toDateStr())
}

export async function getYesterdayCounts() {
  return getCounts(getYesterdayDateStr())
}
