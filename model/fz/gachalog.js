/**
 * 明日方舟（#fz）抽卡记录模块。
 *
 * 参考：gxy12345/arknights-plugin 的“卡池类别 + history 分页拉取”链路。
 * 这里复用本插件已有的 Skland 绑定/设备头逻辑，并将数据写入 bot 的 data 目录。
 */

import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import https from "node:https"

import fetch from "node-fetch"

import { PLUGIN_DATA_DIR } from "../pluginMeta.js"
import { buildHypergryphHeaders, getOrCreateHypergryphDevice } from "../store.js"
import { OAUTH_API } from "../skland/api.js"
import { getFzAccountForUser } from "./account.js"

const GAME_TITLE = "[明日方舟]"

const DATA_DIR = path.join(PLUGIN_DATA_DIR, "fz", "gachalog")

// Hypergryph binding flow
const BINDING_APP_CODE = "be36d44aa36bfb5b"
const U8_TOKEN_BY_UID_URL = "https://binding-api-account-prod.hypergryph.com/account/binding/v1/u8_token_by_uid"

// Arknights official web API
const AK_LOGIN_API = "https://ak.hypergryph.com/user/api/role/login"
const AK_GACHA_CATE_API = "https://ak.hypergryph.com/user/api/inquiry/gacha/cate"
const AK_GACHA_HISTORY_API = "https://ak.hypergryph.com/user/api/inquiry/gacha/history"

// Gacha table (pool meta) used for grouping by "限定/常驻/中坚".
// 优先使用官数镜像，第三方站点作为兜底，避免单点失效导致整个分类回退到启发式判断。
const GACHA_TABLE_URLS = [
  "https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/gacha_table.json",
  "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/refs/heads/master/zh_CN/gamedata/excel/gacha_table.json",
  "https://weedy.prts.wiki/gacha_table.json",
]
const GACHA_TABLE_REDIS_KEY = "Yz:EndUID:FzGachaTable"
const GACHA_TABLE_TTL_SEC = 1800

const GACHA_RULE_TYPES = {
  limit: new Set([1, 2, 3, 8]),
  norm: new Set([0, 5, 9]),
  doub: new Set([4, 6, 7, 10]),
}

const GROUP_ORDER = ["limit", "norm", "doub", "other"]
const GROUP_TITLE = { limit: "限定", norm: "常驻", doub: "中坚", other: "其他" }

let gachaTableCache = { ruleTypeById: null, expiresAt: 0 }

const running = new Set()

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

async function readJsonSafe(resp) {
  const text = await resp.text()
  return safeJsonParse(text, null)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function safeInt(value, def = 0) {
  const n = Number.parseInt(`${value ?? ""}`, 10)
  return Number.isFinite(n) ? n : def
}

function pickGroupKeyByRuleType(ruleType) {
  const t = safeInt(ruleType, -1)
  if (GACHA_RULE_TYPES.limit.has(t)) return "limit"
  if (GACHA_RULE_TYPES.norm.has(t)) return "norm"
  if (GACHA_RULE_TYPES.doub.has(t)) return "doub"
  return "other"
}

function inferGachaRuleType(poolId) {
  const id = String(poolId || "")
    .trim()
    .toUpperCase()
  if (!id) return -1
  if (id.includes("LINKAGE") || id.includes("LIMITED")) return 1
  if (id.includes("CLASSIC")) return 4
  return 0
}

function buildRuleTypeById(tableData) {
  const arr = Array.isArray(tableData?.gachaPoolClient) ? tableData.gachaPoolClient : []
  if (!arr.length) return null
  const map = new Map()
  for (const p of arr) {
    const id = String(p?.gachaPoolId || "").trim()
    if (!id) continue
    const t = safeInt(p?.gachaRuleType, -1)
    if (t >= 0) map.set(id, t)
  }
  return map
}

async function fetchJsonWithTimeout(url, { timeoutMs = 10000, headers } = {}) {
  const timeout = Math.max(1, Number(timeoutMs) || 10000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const resp = await fetch(String(url), {
      method: "GET",
      headers: headers && typeof headers === "object" ? headers : undefined,
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const text = await resp.text()
    return safeJsonParse(text, null)
  } finally {
    clearTimeout(timer)
  }
}

async function getGachaRuleTypeById() {
  const now = Date.now()
  if (gachaTableCache.ruleTypeById && gachaTableCache.expiresAt > now) return gachaTableCache.ruleTypeById

  // Redis cache (JSON string)
  try {
    const cached = await redis.get(GACHA_TABLE_REDIS_KEY)
    const parsed = cached ? safeJsonParse(cached, null) : null
    const map = parsed ? buildRuleTypeById(parsed) : null
    if (map) {
      gachaTableCache = { ruleTypeById: map, expiresAt: now + Math.max(60, GACHA_TABLE_TTL_SEC - 60) * 1000 }
      return map
    }
  } catch {}

  // Network fetch
  for (const url of GACHA_TABLE_URLS) {
    try {
      const json = await fetchJsonWithTimeout(url, {
        timeoutMs: 20000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      })

      if (!json || typeof json !== "object") continue

      const map = buildRuleTypeById(json)
      if (!map) continue

      try {
        const raw = JSON.stringify(json)
        try {
          await redis.setEx(GACHA_TABLE_REDIS_KEY, GACHA_TABLE_TTL_SEC, raw)
        } catch {
          await redis.set(GACHA_TABLE_REDIS_KEY, raw, { EX: GACHA_TABLE_TTL_SEC })
        }
      } catch {}

      gachaTableCache = { ruleTypeById: map, expiresAt: now + Math.max(60, GACHA_TABLE_TTL_SEC - 60) * 1000 }
      return map
    } catch {}
  }

  return null
}

function sortTsPosDesc(a, b) {
  const ta = safeInt(a?.gachaTs)
  const tb = safeInt(b?.gachaTs)
  if (ta !== tb) return tb - ta
  return safeInt(b?.pos) - safeInt(a?.pos)
}

function sortTsPosAsc(a, b) {
  const ta = safeInt(a?.gachaTs)
  const tb = safeInt(b?.gachaTs)
  if (ta !== tb) return ta - tb
  return safeInt(a?.pos) - safeInt(b?.pos)
}

function formatYmdHmFromMs(ms) {
  const t = Number(ms) || 0
  if (t <= 0) return "-"
  const d = new Date(t)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

function formatMdFromMs(ms) {
  const t = Number(ms) || 0
  if (t <= 0) return "-"
  const d = new Date(t)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${mm}.${dd}`
}

function abbrText(text, maxLen = 8) {
  const s = String(text ?? "").trim()
  if (!s) return "-"
  if (s.length <= maxLen) return s
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`
}

function getQqAvatarUrl(userId) {
  const id = String(userId ?? "").trim()
  if (!id) return ""
  return `https://q.qlogo.cn/headimg_dl?dst_uin=${encodeURIComponent(id)}&spec=640`
}

function getOperatorAvatarUrl(charId) {
  const id = String(charId ?? "").trim()
  if (!id) return ""
  return `https://web.hycdn.cn/arknights/game/assets/char_skin/avatar/${encodeURIComponent(`${id}#1`)}.png`
}

function getItemKey(item) {
  const poolId = String(item?.poolId || "")
  const gachaTs = String(item?.gachaTs ?? "")
  const pos = String(item?.pos ?? "")
  if (!poolId && !gachaTs && !pos) return ""
  return `${poolId}|${gachaTs}|${pos}`
}

function getLatestCursor(items) {
  if (!Array.isArray(items) || !items.length) return { gachaTs: 0, pos: -1 }

  let latest = { gachaTs: 0, pos: -1 }
  for (const item of items) {
    const gachaTs = safeInt(item?.gachaTs, 0)
    const pos = safeInt(item?.pos, -1)
    if (gachaTs > latest.gachaTs || (gachaTs === latest.gachaTs && pos > latest.pos)) {
      latest = { gachaTs, pos }
    }
  }
  return latest
}

function isRecordNewerThanCursor(record, cursor) {
  const currentTs = safeInt(record?.gachaTs, 0)
  const currentPos = safeInt(record?.pos, -1)
  const latestTs = safeInt(cursor?.gachaTs, 0)
  const latestPos = safeInt(cursor?.pos, -1)

  if (!latestTs) return true
  if (currentTs !== latestTs) return currentTs > latestTs
  return currentPos > latestPos
}

async function getHypergryphHeadersForUser(userId, { json = true } = {}) {
  const uid = String(userId ?? "").trim()
  if (!uid) return buildHypergryphHeaders(null, { json })
  try {
    const device = await getOrCreateHypergryphDevice(uid)
    return buildHypergryphHeaders(device, { json })
  } catch {
    return buildHypergryphHeaders(null, { json })
  }
}

async function getGrantToken(hgToken, { deviceToken, userId } = {}) {
  const payload = { token: String(hgToken), appCode: BINDING_APP_CODE, type: 1 }
  const dt = String(deviceToken || "").trim()
  if (dt) payload.deviceToken = dt

  const resp = await fetch(OAUTH_API, {
    method: "POST",
    headers: await getHypergryphHeadersForUser(userId),
    body: JSON.stringify(payload),
  })

  if (!resp.ok) throw new Error(`获取授权码失败：HTTP ${resp.status}`)
  const json = await readJsonSafe(resp)
  if (!json || json.status !== 0 || !json.data?.token) throw new Error(`获取授权码失败：${json?.msg || "未知错误"}`)
  return String(json.data.token)
}

async function getRoleTokenByUid(uid, grantToken, { userId } = {}) {
  const resp = await fetch(U8_TOKEN_BY_UID_URL, {
    method: "POST",
    headers: await getHypergryphHeadersForUser(userId),
    body: JSON.stringify({ uid: String(uid), token: String(grantToken) }),
  })

  if (!resp.ok) throw new Error(`获取角色令牌失败：HTTP ${resp.status}`)
  const json = await readJsonSafe(resp)
  if (!json || json.status !== 0 || !json.data?.token) throw new Error(`获取角色令牌失败：${json?.msg || "未知错误"}`)
  return String(json.data.token)
}

function extractAkUserCenterCookie(setCookieText) {
  const s = String(setCookieText || "")
  if (!s) return ""
  const m = s.match(/(?:^|;\s*)ak-user-center=([^;]+)/i)
  return m?.[1] ? String(m[1]) : ""
}

async function getAkCookieByHttps(roleToken) {
  return new Promise(resolve => {
    const postData = JSON.stringify({ token: String(roleToken) })
    const options = {
      hostname: "ak.hypergryph.com",
      port: 443,
      path: "/user/api/role/login",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    }

    const req = https.request(options, res => {
      res.on("data", () => {})
      res.on("end", () => {
        const setCookies = res.headers?.["set-cookie"]
        if (Array.isArray(setCookies) && setCookies.length) {
          const joined = setCookies.join("; ")
          const cookie = extractAkUserCenterCookie(joined)
          resolve(cookie)
          return
        }
        resolve("")
      })
    })
    req.on("error", () => resolve(""))
    req.write(postData)
    req.end()
  })
}

async function getAkCookie(roleToken) {
  const t = String(roleToken || "").trim()
  if (!t) return ""

  try {
    const resp = await fetch(AK_LOGIN_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ token: t }),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

    // Try multiple ways to access Set-Cookie (depends on fetch implementation).
    let setCookieText = ""
    if (typeof resp.headers?.getSetCookie === "function") {
      const arr = resp.headers.getSetCookie()
      if (Array.isArray(arr) && arr.length) setCookieText = arr.join("; ")
    }
    if (!setCookieText) setCookieText = resp.headers?.get?.("set-cookie") || ""
    if (!setCookieText && typeof resp.headers?.raw === "function") {
      const raw = resp.headers.raw()
      const arr = raw?.["set-cookie"]
      if (Array.isArray(arr) && arr.length) setCookieText = arr.join("; ")
    }

    const cookie = extractAkUserCenterCookie(setCookieText)
    if (cookie) return cookie
  } catch {}

  // Fallback: native https (most reliable for Set-Cookie).
  return await getAkCookieByHttps(t)
}

function buildAkHeaders({ accountToken, roleToken, akCookie }) {
  return {
    "X-Account-Token": String(accountToken || ""),
    "X-Role-Token": String(roleToken || ""),
    Cookie: `ak-user-center=${String(akCookie || "")}`,
  }
}

async function getGachaCategories(uid, { accountToken, roleToken, akCookie } = {}) {
  const resp = await fetch(`${AK_GACHA_CATE_API}?uid=${encodeURIComponent(String(uid))}`, {
    method: "GET",
    headers: buildAkHeaders({ accountToken, roleToken, akCookie }),
  })
  if (!resp.ok) throw new Error(`获取卡池类别失败：HTTP ${resp.status}`)
  const json = await readJsonSafe(resp)
  if (!json || json.code !== 0) throw new Error(`获取卡池类别失败：${json?.msg || json?.message || json?.code || "未知错误"}`)
  return Array.isArray(json.data) ? json.data : []
}

async function getGachaHistory(uid, category, { accountToken, roleToken, akCookie, gachaTs, pos } = {}) {
  let url = `${AK_GACHA_HISTORY_API}?uid=${encodeURIComponent(String(uid))}&category=${encodeURIComponent(String(category))}&size=100`
  if (gachaTs && pos != null) url += `&gachaTs=${encodeURIComponent(String(gachaTs))}&pos=${encodeURIComponent(String(pos))}`

  const resp = await fetch(url, {
    method: "GET",
    headers: buildAkHeaders({ accountToken, roleToken, akCookie }),
  })
  if (!resp.ok) throw new Error(`获取抽卡记录失败：HTTP ${resp.status}`)
  const json = await readJsonSafe(resp)
  if (!json || json.code !== 0) throw new Error(`获取抽卡记录失败：${json?.msg || json?.message || json?.code || "未知错误"}`)
  return json.data || null
}

function normalizeRecord(raw) {
  const r = raw && typeof raw === "object" ? raw : null
  if (!r) return null

  const poolId = String(r.poolId || "").trim()
  const gachaTs = safeInt(r.gachaTs, 0)
  const pos = safeInt(r.pos, -1)
  if (!poolId || !gachaTs || pos < 0) return null

  return {
    poolId,
    poolName: String(r.poolName || "").trim(),
    charId: String(r.charId || "").trim(),
    charName: String(r.charName || "").trim(),
    rarity: safeInt(r.rarity, -1),
    isNew: !!r.isNew,
    gachaTs,
    pos,
  }
}

async function getAllGachaRecords(uid, category, { accountToken, roleToken, akCookie, latestCursor = null } = {}) {
  let all = []
  let page = await getGachaHistory(uid, category, { accountToken, roleToken, akCookie })

  let prevTs = null
  let prevPos = null

  while (page && Array.isArray(page.list) && page.list.length) {
    const list = page.list

    const newRecords = []
    for (const rec of list) {
      if (!latestCursor || isRecordNewerThanCursor(rec, latestCursor)) newRecords.push(rec)
      else return all.concat(newRecords)
    }

    all = all.concat(newRecords)

    if (!page.hasMore || newRecords.length === 0) break

    const last = list[list.length - 1]
    const nextTs = safeInt(last?.gachaTs)
    const nextPos = safeInt(last?.pos, -1)
    if (!nextTs || nextPos < 0) break

    if (nextTs === prevTs && nextPos === prevPos) break
    prevTs = nextTs
    prevPos = nextPos

    await sleep(80)
    page = await getGachaHistory(uid, category, { accountToken, roleToken, akCookie, gachaTs: nextTs, pos: nextPos })
  }

  return all
}

function buildTopCostByItems(items, { topRarity = 5 } = {}) {
  const sorted = (items || []).slice().sort(sortTsPosAsc)
  const cost = new Map()
  let since = 0
  for (const it of sorted) {
    since += 1
    if (safeInt(it?.rarity) !== topRarity) continue
    cost.set(getItemKey(it), since)
    since = 0
  }
  return cost
}

function getPityFromRecent(items, { topRarity = 5 } = {}) {
  const sorted = (items || []).slice().sort(sortTsPosDesc)
  let pity = 0
  for (const it of sorted) {
    if (safeInt(it?.rarity) === topRarity) break
    pity += 1
  }
  return pity
}

function formatYmdRangeFromMs(items) {
  if (!Array.isArray(items) || !items.length) return "-"
  const times = items.map(i => Number(i?.gachaTs) || 0).filter(Boolean)
  if (!times.length) return "-"
  const min = Math.min(...times)
  const max = Math.max(...times)
  const start = formatYmdHmFromMs(min).slice(0, 10).replaceAll("-", ".")
  const end = formatYmdHmFromMs(max).slice(0, 10).replaceAll("-", ".")
  return `${start} ~ ${end}`
}

function buildPoolStats(items) {
  const total = Array.isArray(items) ? items.length : 0
  const six = (items || []).filter(i => safeInt(i?.rarity) === 5).length
  const avg = six > 0 && total > 0 ? total / six : null
  return { total, six, avg }
}

function mergeRecords(existing, incoming, { full = false } = {}) {
  const base = full ? [] : (Array.isArray(existing) ? existing.slice() : [])
  const baseKeys = new Set(base.map(getItemKey))

  const added = []
  for (const r of incoming || []) {
    const key = getItemKey(r)
    if (!key || baseKeys.has(key)) continue
    baseKeys.add(key)
    base.push(r)
    added.push(r)
  }

  // Full mode: de-duplicate incoming as well.
  if (full) {
    const uniq = []
    const keys = new Set()
    for (const r of incoming || []) {
      const key = getItemKey(r)
      if (!key || keys.has(key)) continue
      keys.add(key)
      uniq.push(r)
    }
    uniq.sort(sortTsPosDesc)
    return { merged: uniq, newCount: Math.max(0, uniq.length - (Array.isArray(existing) ? existing.length : 0)) }
  }

  base.sort(sortTsPosDesc)
  return { merged: base, newCount: added.length }
}

function exportFilePath(akUid) {
  const uid = String(akUid ?? "").trim()
  return path.join(DATA_DIR, `${uid}.json`)
}

async function loadExport(akUid) {
  const fp = exportFilePath(akUid)
  try {
    if (!fsSync.existsSync(fp)) return null
    const text = await fs.readFile(fp, "utf8")
    const data = safeJsonParse(text, null)
    if (!data || typeof data !== "object") return null
    if (!Array.isArray(data.list)) data.list = []
    if (!data.info || typeof data.info !== "object") data.info = {}
    return data
  } catch {
    return null
  }
}

async function saveExport(akUid, exportData) {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const fp = exportFilePath(akUid)
  await fs.writeFile(fp, JSON.stringify(exportData, null, 2), "utf8")
  return fp
}

function normalizeImportPayload(raw) {
  const parsed = typeof raw === "string" ? safeJsonParse(raw, null) : raw
  if (!parsed) return { ok: false, message: `${GAME_TITLE} 导入失败：JSON 格式无效` }

  const info = parsed?.info && typeof parsed.info === "object" ? parsed.info : {}
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.list) ? parsed.list : []
  if (!Array.isArray(list) || !list.length) return { ok: false, message: `${GAME_TITLE} 导入失败：记录列表为空` }

  const normalized = list.map(normalizeRecord).filter(Boolean)
  if (!normalized.length) return { ok: false, message: `${GAME_TITLE} 导入失败：未识别到有效抽卡记录` }

  return { ok: true, info, list: normalized }
}

export async function updateFzGachaLogsForUser(userId, { full = false } = {}) {
  const acc = await getFzAccountForUser(userId)
  if (!acc.ok) return { ok: false, message: acc.message }

  const hgToken = String(acc.token || "").trim()
  if (!hgToken) {
    return { ok: false, message: `${GAME_TITLE} 抽卡记录需要 Hypergryph token，请先私聊 #zmd登录 重新绑定` }
  }

  const akUid = String(acc.akUid)
  if (running.has(akUid)) return { ok: false, message: `${GAME_TITLE} 抽卡记录正在刷新中，请稍后再试（请勿重复触发）` }
  running.add(akUid)

  try {
    const existing = await loadExport(akUid)
    const existingList = Array.isArray(existing?.list) ? existing.list : []
    const oldCount = existingList.length
    const latestCursor = full ? null : getLatestCursor(existingList)

    const grantToken = await getGrantToken(hgToken, { deviceToken: acc.deviceToken, userId })
    const roleToken = await getRoleTokenByUid(akUid, grantToken, { userId })
    const akCookie = await getAkCookie(roleToken)
    if (!akCookie) throw new Error("获取 ak-user-center cookie 失败")

    const categories = await getGachaCategories(akUid, { accountToken: hgToken, roleToken, akCookie })
    if (!categories.length) throw new Error("卡池类别为空")

    let fetched = []
    for (const cate of categories) {
      const id = cate?.id ?? cate?.cateId ?? cate?.category
      if (id == null || String(id).trim() === "") continue
      const records = await getAllGachaRecords(akUid, id, {
        accountToken: hgToken,
        roleToken,
        akCookie,
        latestCursor,
      })
      fetched.push(...records)
    }

    const normalized = fetched.map(normalizeRecord).filter(Boolean)
    const { merged, newCount } = mergeRecords(existingList, normalized, { full })

    if (full && oldCount > 0 && merged.length === 0) {
      return { ok: false, message: `${GAME_TITLE} 全量重拉返回空数据，已取消覆盖本地记录（请稍后重试）` }
    }

    const exportData = {
      info: {
        uid: akUid,
        lang: "zh-cn",
        timezone: 8,
        exportTimestamp: Math.floor(Date.now() / 1000),
        version: "v1.0",
      },
      list: merged,
    }

    const filePath = await saveExport(akUid, exportData)

    return {
      ok: true,
      mode: full ? "full" : "incremental",
      akUid,
      nickname: acc.nickname,
      channelName: acc.channelName,
      filePath,
      oldCount,
      total: merged.length,
      newCount,
      exportTimestamp: exportData.info.exportTimestamp,
    }
  } catch (err) {
    return { ok: false, message: `${GAME_TITLE} 刷新抽卡记录失败：${err?.message || err}` }
  } finally {
    running.delete(akUid)
  }
}

export async function exportFzGachaLogsForUser(userId) {
  const acc = await getFzAccountForUser(userId)
  if (!acc.ok) return { ok: false, message: acc.message }

  const akUid = String(acc.akUid)
  const exportData = await loadExport(akUid)
  if (!exportData) return { ok: false, message: `${GAME_TITLE} 未找到抽卡记录，请先使用：#fz更新抽卡记录` }

  return {
    ok: true,
    akUid,
    filePath: exportFilePath(akUid),
    fileName: `arknights-gachalog-${akUid}.json`,
    exportData,
  }
}

export async function deleteFzGachaLogsForUser(userId) {
  const acc = await getFzAccountForUser(userId)
  if (!acc.ok) return { ok: false, message: acc.message }

  const akUid = String(acc.akUid)
  const filePath = exportFilePath(akUid)
  if (!fsSync.existsSync(filePath)) return { ok: false, message: `${GAME_TITLE} 未找到抽卡记录，无需删除` }

  await fs.mkdir(DATA_DIR, { recursive: true })
  const backupPath = path.join(DATA_DIR, `${akUid}.${Date.now()}.bak.json`)
  await fs.rename(filePath, backupPath)
  return { ok: true, akUid, backupPath }
}

export async function importFzGachaLogsFromJsonForUser(userId, raw, { replace = false } = {}) {
  const acc = await getFzAccountForUser(userId)
  if (!acc.ok) return { ok: false, message: acc.message }

  const akUid = String(acc.akUid)
  const parsed = normalizeImportPayload(raw)
  if (!parsed.ok) return parsed

  const importUid = String(parsed.info?.uid || parsed.info?.akUid || "").trim()
  if (importUid && importUid !== akUid) {
    return { ok: false, message: `${GAME_TITLE} 导入失败：记录 UID 为 ${importUid}，与当前账号 ${akUid} 不一致` }
  }

  const existing = await loadExport(akUid)
  const existingList = Array.isArray(existing?.list) ? existing.list : []
  const { merged, newCount } = mergeRecords(existingList, parsed.list, { full: replace })

  const exportData = {
    info: {
      uid: akUid,
      lang: "zh-cn",
      timezone: 8,
      exportTimestamp: Math.floor(Date.now() / 1000),
      version: "v1.0",
    },
    list: merged,
  }

  const filePath = await saveExport(akUid, exportData)
  return {
    ok: true,
    akUid,
    filePath,
    oldCount: existingList.length,
    total: merged.length,
    newCount,
    exportTimestamp: exportData.info.exportTimestamp,
  }
}

function buildTextSummary({ nickname, akUid, exportTime, pools, totalPulls, totalSix }) {
  const lines = [
    `${GAME_TITLE} 抽卡记录`,
    `账号：${nickname || "博士"} UID:${akUid || "-"}`,
    `更新：${exportTime}`,
    `总寻访：${totalPulls}  6星：${totalSix}`,
  ]

  for (const p of pools) {
    const avg = p.stats.avg != null ? ` 平均:${p.stats.avg.toFixed(1)}` : ""
    lines.push(`${p.title}：寻访:${p.stats.total} 6星:${p.stats.six} 垫抽:${p.pity}${avg}`)
  }
  return lines.join("\n")
}

export async function getFzGachaLogViewForUser(userId) {
  const acc = await getFzAccountForUser(userId)
  if (!acc.ok) return { ok: false, message: acc.message }

  const akUid = String(acc.akUid)
  const exportData = await loadExport(akUid)
  if (!exportData) {
    return { ok: false, message: `${GAME_TITLE} 未找到抽卡记录，请先使用：#fz更新抽卡记录` }
  }

  if (String(exportData?.info?.uid || "") && String(exportData.info.uid) !== akUid) {
    return { ok: false, message: `${GAME_TITLE} 抽卡记录 UID 不匹配（记录已损坏或串档）` }
  }

  const list = Array.isArray(exportData?.list) ? exportData.list : []
  const exportTime = exportData?.info?.exportTimestamp
    ? formatYmdHmFromMs(Number(exportData.info.exportTimestamp) * 1000)
    : "-"

  const ruleTypeById = await getGachaRuleTypeById()

  // poolId -> groupKey (limit/norm/doub/other)
  const byGroup = new Map()
  for (const it of list) {
    const poolId = String(it?.poolId || "").trim()
    let ruleType = -1
    if (ruleTypeById && poolId && ruleTypeById.has(poolId)) ruleType = ruleTypeById.get(poolId)
    if (ruleType < 0) ruleType = inferGachaRuleType(poolId)
    const groupKey = pickGroupKeyByRuleType(ruleType)

    if (!byGroup.has(groupKey)) byGroup.set(groupKey, [])
    byGroup.get(groupKey).push(it)
  }

  const pools = []
  const poolsView = []

  for (const groupKey of GROUP_ORDER) {
    const groupItems = byGroup.get(groupKey) || []
    if (!groupItems.length) continue

    const max = 99

    const latestTs = Math.max(...groupItems.map(i => safeInt(i?.gachaTs, 0)))
    const title = GROUP_TITLE[groupKey] || "未知"
    const pity = Math.max(0, Math.min(max, safeInt(getPityFromRecent(groupItems, { topRarity: 5 }), 0)))
    const stats = buildPoolStats(groupItems)
    const sixList = groupItems.filter(i => safeInt(i?.rarity) === 5).sort(sortTsPosDesc).slice(0, 24)

    const pool = {
      key: `group:${groupKey}`,
      kind: "char",
      poolId: groupKey,
      title,
      timeRange: formatYmdRangeFromMs(groupItems),
      pity,
      stats,
      sixList,
      latestTs,
    }
    pools.push(pool)

    const cost = buildTopCostByItems(groupItems, { topRarity: 5 })

    const logs = sixList.map(item => {
      const name = String(item?.charName || "未知")
      const key = getItemKey(item)
      const count = Math.max(1, safeInt(cost.get(key), 1))
      const icon = getOperatorAvatarUrl(item?.charId)
      return {
        date: formatMdFromMs(item?.gachaTs),
        time: formatYmdHmFromMs(item?.gachaTs),
        name,
        abbr: abbrText(name, 10),
        count,
        icon,
        iconPath: "",
        cls: "up",
        rarity: 6,
        isFree: false,
        tag: "",
        tagCls: "",
      }
    })

    if (pity > 0) {
      logs.unshift({
        date: "至今",
        time: exportTime,
        name: "未出",
        abbr: "未出",
        count: pity,
        icon: "",
        mark: "?",
        cls: "pending",
        rarity: 0,
        isFree: false,
      })
    }

    poolsView.push({
      ...pool,
      max,
      stats: {
        ...stats,
        avgText: stats.avg != null ? stats.avg.toFixed(1) : "-",
        free: null,
      },
      logs,
    })
  }

  const totalPulls = list.length
  const totalSix = list.filter(i => safeInt(i?.rarity) === 5).length

  const view = {
    elem: "sr",
    uid: akUid,
    exportTime,
    face: {
      banner: "skin/common/bg/bg-sr.webp",
      face: getQqAvatarUrl(userId),
      qFace: getQqAvatarUrl(userId),
      name: String(acc.nickname || "博士"),
    },
    gacha: {
      stat: {
        totalNum: totalPulls,
        sixNum: totalSix,
        poolNum: poolsView.length,
      },
      pools: poolsView,
    },
  }

  const text = buildTextSummary({
    nickname: acc.nickname,
    akUid,
    exportTime,
    pools,
    totalPulls,
    totalSix,
  })

  return { ok: true, view, text, exportData }
}
