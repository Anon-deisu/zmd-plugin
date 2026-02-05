/**
 * 抽卡记录数据模块。
 *
 * 功能：
 * - 从终末地 WebView 接口同步抽卡记录
 * - JSON 导入/导出（备份/分享）
 * - 生成渲染用的视图数据（供 apps/gachalog.js 使用）
 *
 * 说明：
 * - 依赖 Redis 存储账号/设备信息，并用于枚举已绑定用户
 * - 内置小型进程缓存（roleId -> QQ userId），支持“按角色ID查询”时显示正确头像，
 *   同时避免频繁全量扫描
 */
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import fetch from "node-fetch"

import { loadAliasMap } from "./alias.js"
import { getCardDetailForUser } from "./card.js"
import {
  buildHypergryphHeaders,
  getActiveAccount,
  getOrCreateHypergryphDevice,
  getUserData,
  upsertAccount,
} from "./store.js"
import { OAUTH_API } from "./skland/api.js"

import { PLUGIN_DATA_DIR, PLUGIN_RESOURCES_DIR } from "./pluginMeta.js"

const DATA_DIR = path.join(PLUGIN_DATA_DIR, "gachalog")
const RES_DIR = PLUGIN_RESOURCES_DIR

const BINDING_APP_CODE = "be36d44aa36bfb5b"
const BINDING_LIST_URL = "https://binding-api-account-prod.hypergryph.com/account/binding/v1/binding_list"
const U8_TOKEN_BY_UID_URL = "https://binding-api-account-prod.hypergryph.com/account/binding/v1/u8_token_by_uid"

const EF_CHAR_URL = "https://ef-webview.hypergryph.com/api/record/char"
const EF_WEAPON_URL = "https://ef-webview.hypergryph.com/api/record/weapon"

const CHARACTER_POOL_TYPES = [
  "E_CharacterGachaPoolType_Special",
  "E_CharacterGachaPoolType_Beginner",
  "E_CharacterGachaPoolType_Standard",
]

// 保留历史 key 命名空间：避免老用户数据迁移困难。
const KEY_USERS = "Yz:EndUID:Users"
const ROLE_OWNER_TTL_MS = 10 * 60 * 1000
const ROLE_OWNER_NEGATIVE_TTL_MS = 60 * 1000
// roleId -> { userId, ts }，用于减少“扫描所有绑定用户”带来的开销。
const roleOwnerCache = new Map()

// 并发保护：同一 user/role 只允许一个更新任务，避免竞态写入。
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

function safeInt(value, def = 0) {
  const n = Number.parseInt(`${value ?? ""}`, 10)
  return Number.isFinite(n) ? n : def
}

function sortTsSeqDesc(a, b) {
  const ta = safeInt(a?.gachaTs)
  const tb = safeInt(b?.gachaTs)
  if (ta !== tb) return tb - ta
  return safeInt(b?.seqId) - safeInt(a?.seqId)
}

function sortTsSeqAsc(a, b) {
  const ta = safeInt(a?.gachaTs)
  const tb = safeInt(b?.gachaTs)
  if (ta !== tb) return ta - tb
  return safeInt(a?.seqId) - safeInt(b?.seqId)
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

function getCachedRoleOwner(roleId) {
  const rid = String(roleId ?? "").trim()
  if (!rid) return null

  const cached = roleOwnerCache.get(rid)
  if (!cached) return null
  if ((cached.expiresAt || 0) > Date.now()) return cached

  roleOwnerCache.delete(rid)
  return null
}

function setCachedRoleOwner(roleId, { userId = "", nickname = "" } = {}) {
  const rid = String(roleId ?? "").trim()
  if (!rid) return

  const uid = String(userId ?? "").trim()
  const ttl = uid ? ROLE_OWNER_TTL_MS : ROLE_OWNER_NEGATIVE_TTL_MS
  roleOwnerCache.set(rid, {
    userId: uid,
    nickname: String(nickname ?? "").trim(),
    expiresAt: Date.now() + ttl,
  })
}

async function findBoundUserByRoleId(roleId) {
  const rid = String(roleId ?? "").trim()
  if (!rid) return { userId: "", nickname: "" }

  const cached = getCachedRoleOwner(rid)
  if (cached) return { userId: cached.userId, nickname: cached.nickname }

  let userIds = []
  try {
    userIds = await redis.sMembers(KEY_USERS)
  } catch {
    setCachedRoleOwner(rid, {})
    return { userId: "", nickname: "" }
  }

  for (const uidRaw of userIds) {
    const uid = String(uidRaw ?? "").trim()
    if (!uid) continue
    try {
      const data = await getUserData(uid)
      const accounts = Array.isArray(data?.accounts) ? data.accounts : []
      const found = accounts.find(a => String(a?.uid || "").trim() === rid)
      if (!found) continue

      const nickname = String(found?.nickname || "").trim()
      const res = { userId: uid, nickname }
      setCachedRoleOwner(rid, res)
      return res
    } catch {}
  }

  setCachedRoleOwner(rid, {})
  return { userId: "", nickname: "" }
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

function getMaxSeqId(items) {
  if (!Array.isArray(items) || !items.length) return 0
  return Math.max(...items.map(i => safeInt(i?.seqId, 0)))
}

function mergeRecords(existing, newRecords) {
  const existingSeq = new Set((existing || []).map(r => String(r?.seqId ?? "")))
  const merged = Array.isArray(existing) ? existing.slice() : []
  let newCount = 0

  for (const r of newRecords || []) {
    const id = String(r?.seqId ?? "")
    if (!id) continue
    if (existingSeq.has(id)) continue
    existingSeq.add(id)
    merged.push(r)
    newCount++
  }

  merged.sort((a, b) => safeInt(b?.seqId) - safeInt(a?.seqId))
  return { merged, newCount }
}

function getPityFromRecent(items, { excludeFree = true } = {}) {
  const sorted = (items || []).slice().sort(sortTsSeqDesc)
  let pity = 0
  for (const item of sorted) {
    if (safeInt(item?.rarity) === 6) break
    if (excludeFree && item?.isFree) continue
    pity++
  }
  return pity
}

function getPityByPoolId(items, { excludeFree = true } = {}) {
  const by = new Map()
  for (const item of items || []) {
    const poolId = String(item?.poolId || "")
    if (!poolId) continue
    if (!by.has(poolId)) by.set(poolId, [])
    by.get(poolId).push(item)
  }

  const out = {}
  for (const [poolId, poolItems] of by.entries()) {
    out[poolId] = getPityFromRecent(poolItems, { excludeFree })
  }
  return out
}

function buildPoolStats(items, { hasFree = false } = {}) {
  const total = Array.isArray(items) ? items.length : 0
  const six = (items || []).filter(i => safeInt(i?.rarity) === 6).length
  const free = hasFree ? (items || []).filter(i => !!i?.isFree).length : null
  const nonFree = hasFree ? total - (free || 0) : total
  const avg = six > 0 && total > 0 ? total / six : null
  return { total, six, free, nonFree, avg }
}

function getItemKey(item) {
  const poolId = String(item?.poolId || "")
  const gachaTs = String(item?.gachaTs ?? "")
  const seqId = String(item?.seqId ?? "")
  return `${poolId}|${gachaTs}|${seqId}`
}

function buildSixCostByPoolId(items, { excludeFree = true } = {}) {
  const byPool = new Map()
  for (const item of items || []) {
    const poolId = String(item?.poolId || "")
    if (!poolId) continue
    if (!byPool.has(poolId)) byPool.set(poolId, [])
    byPool.get(poolId).push(item)
  }

  const cost = new Map()
  for (const poolItems of byPool.values()) {
    const filtered = excludeFree ? poolItems.filter(i => !i?.isFree) : poolItems.slice()
    const sorted = filtered.slice().sort(sortTsSeqAsc)

    let sinceLastSix = 0
    for (const item of sorted) {
      sinceLastSix += 1
      if (safeInt(item?.rarity) !== 6) continue
      cost.set(getItemKey(item), sinceLastSix)
      sinceLastSix = 0
    }
  }

  return cost
}

function getLocalIconPath({ charId, weaponId } = {}) {
  const wid = String(weaponId || "").trim()
  if (wid) {
    const rel = `endfield/itemiconbig/${wid}.png`
    const fp = path.join(RES_DIR, "endfield", "itemiconbig", `${wid}.png`)
    if (fsSync.existsSync(fp)) return rel
  }

  const cid = String(charId || "").trim()
  if (cid) {
    const rel = `endfield/charicon/icon_${cid}.png`
    const fp = path.join(RES_DIR, "endfield", "charicon", `icon_${cid}.png`)
    if (fsSync.existsSync(fp)) return rel
  }

  return ""
}

async function getBindingGrantToken(hgToken, { deviceToken, userId } = {}) {
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

async function getBindingList(grantToken, { userId, roleId } = {}) {
  const token = String(grantToken || "").trim()
  if (!token) return { uid: "", roles: [] }

  const query = new URLSearchParams({ appCode: "endfield", token }).toString()
  const resp = await fetch(`${BINDING_LIST_URL}?${query}`, {
    method: "GET",
    headers: await getHypergryphHeadersForUser(userId, { json: false }),
  })

  if (!resp.ok) throw new Error(`获取绑定列表失败：HTTP ${resp.status}`)
  const json = await readJsonSafe(resp)
  if (!json || json.status !== 0 || !json.data) throw new Error(`获取绑定列表失败：${json?.msg || "未知错误"}`)

  const list = Array.isArray(json.data?.list) ? json.data.list : []
  const bindingList = Array.isArray(list?.[0]?.bindingList) ? list[0].bindingList : []
  const rid = String(roleId || "").trim()
  const picked =
    (rid &&
      bindingList.find(b => {
        const roles = Array.isArray(b?.roles) ? b.roles : []
        return roles.some(r => String(r?.roleId || "") === rid)
      })) ||
    bindingList[0] ||
    null

  const uid = picked?.uid != null ? String(picked.uid) : ""
  const roles = Array.isArray(picked?.roles) ? picked.roles : []
  return { uid, roles }
}

async function getU8TokenByUid(uid, grantToken, { userId } = {}) {
  const resp = await fetch(U8_TOKEN_BY_UID_URL, {
    method: "POST",
    headers: await getHypergryphHeadersForUser(userId),
    body: JSON.stringify({ uid: String(uid), token: String(grantToken) }),
  })

  if (!resp.ok) throw new Error(`获取 u8 token 失败：HTTP ${resp.status}`)
  const json = await readJsonSafe(resp)
  if (!json || json.status !== 0 || !json.data?.token) throw new Error(`获取 u8 token 失败：${json?.msg || "未知错误"}`)
  return String(json.data.token)
}

async function getU8Token({ recordUid, roleId, hgToken, deviceToken, userId }) {
  // 抽卡记录接口需要 u8 token；它的获取链路比较绕：
  // hgToken(登录态) -> grantToken(oauth) -> bindingList(uid) -> u8Token
  const grantToken = await getBindingGrantToken(hgToken, { deviceToken, userId })
  const binding = await getBindingList(grantToken, { userId, roleId })
  const uid = binding?.uid || String(recordUid || "").trim()
  if (!uid) throw new Error("缺少 recordUid（未获取到绑定列表 uid），请先私聊 #zmd登录 重新绑定")
  const u8Token = await getU8TokenByUid(uid, grantToken, { userId })
  return { u8Token, recordUid: uid }
}

async function fetchEfRecords(url, { u8Token, serverId = "1", extraParams = {}, existingMaxSeqId = 0 } = {}) {
  // 终末地抽卡记录为分页接口：使用 seq_id 向后翻页，直到 hasMore=false。
  // 若传入 existingMaxSeqId，则遇到 <= max 的记录即提前停止（增量更新）。
  let hasMore = true
  let seqId = 0
  const records = []

  while (hasMore) {
    const params = {
      lang: "zh-cn",
      token: String(u8Token),
      server_id: String(serverId || "1"),
      ...extraParams,
    }
    if (seqId > 0) params.seq_id = String(seqId)

    const query = new URLSearchParams(params).toString()
    const fullUrl = `${url}?${query}`
    const resp = await fetch(fullUrl, { method: "GET" })
    if (!resp.ok) throw new Error(`抽卡记录请求失败：HTTP ${resp.status}`)

    const json = await readJsonSafe(resp)
    if (!json || json.code !== 0 || !json.data) throw new Error(`抽卡记录请求失败：${json?.msg || "未知错误"}`)

    const list = Array.isArray(json.data?.list) ? json.data.list : []

    let shouldStop = false
    for (const r of list) {
      const currentSeq = safeInt(r?.seqId)
      if (existingMaxSeqId > 0 && currentSeq > 0 && currentSeq <= existingMaxSeqId) {
        shouldStop = true
        break
      }
      records.push(r)
    }

    if (shouldStop) break

    hasMore = !!json.data?.hasMore
    if (list.length) seqId = safeInt(list[list.length - 1]?.seqId)
    else break

    // 小延迟：避免短时间内高频请求触发风控。
    await sleep(100)
  }

  return records
}

async function loadGachaExport(roleId) {
  const fp = path.join(DATA_DIR, `${roleId}.json`)
  try {
    const text = await fs.readFile(fp, "utf8")
    const data = safeJsonParse(text, null)
    if (!data || typeof data !== "object") return null
    if (!Array.isArray(data.charList)) data.charList = []
    if (!Array.isArray(data.weaponList)) data.weaponList = []
    if (!data.info || typeof data.info !== "object") data.info = {}
    return data
  } catch {
    return null
  }
}

async function saveGachaExport(roleId, exportData) {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const fp = path.join(DATA_DIR, `${roleId}.json`)
  await fs.writeFile(fp, JSON.stringify(exportData, null, 2), "utf8")
  return fp
}

export async function updateGachaLogsForUser(userId) {
  const { account } = await getActiveAccount(userId)
  if (!account?.cred || !account?.uid) {
    return { ok: false, message: "[终末地] 未绑定账号，请先私聊 #zmd登录 / #zmd绑定" }
  }

  return await updateGachaLogsForAccount(userId, account)
}

export async function updateGachaLogsForRoleId(userId, roleId) {
  const rid = String(roleId ?? "").trim()
  if (!rid) return { ok: false, message: "[终末地] 请提供 UID，例如：#zmd更新抽卡记录1234567890" }

  const data = await getUserData(userId)
  const accounts = Array.isArray(data?.accounts) ? data.accounts : []
  const account = accounts.find(a => String(a?.uid || "").trim() === rid)
  if (!account?.cred) {
    return { ok: false, message: `[终末地] 未在你的绑定账号中找到 UID:${rid}，请先私聊 #zmd登录 绑定该账号` }
  }

  return await updateGachaLogsForAccount(userId, account)
}

async function updateGachaLogsForAccount(userId, account) {
  if (!account?.cred || !account?.uid) {
    return { ok: false, message: "[终末地] 未绑定账号，请先私聊 #zmd登录 / #zmd绑定" }
  }

  const roleId = String(account.uid)
  const recordUid = String(account.recordUid || "").trim()
  const hgToken = String(account.token || "").trim()
  const deviceToken = String(account.deviceToken || "").trim()
  const serverId = String(account.serverId || "1").trim() || "1"

  if (!hgToken) {
    return { ok: false, message: "[终末地] 抽卡记录需要 Hypergryph token，请先私聊 #zmd登录 重新绑定" }
  }

  // 并发保护：同一个 roleId 的刷新流程会读写同一份本地 JSON。
  if (running.has(roleId)) return { ok: false, message: "[终末地] 抽卡记录正在刷新中，请稍后再试（请勿重复触发）" }
  running.add(roleId)

  try {
    const existing = await loadGachaExport(roleId)
    const existingChar = Array.isArray(existing?.charList) ? existing.charList : []
    const existingWeapon = Array.isArray(existing?.weaponList) ? existing.weaponList : []

    const charMaxSeqId = getMaxSeqId(existingChar)
    const weaponMaxSeqId = getMaxSeqId(existingWeapon)

    const { u8Token, recordUid: finalRecordUid } = await getU8Token({
      recordUid,
      roleId,
      hgToken,
      deviceToken,
      userId,
    })
    if (finalRecordUid && finalRecordUid !== recordUid) {
      try {
        await upsertAccount(userId, { cred: account.cred, recordUid: finalRecordUid, updatedAt: Date.now() })
      } catch {}
    }

    const fetchedChar = []
    for (const poolType of CHARACTER_POOL_TYPES) {
      const list = await fetchEfRecords(EF_CHAR_URL, {
        u8Token,
        serverId,
        extraParams: { pool_type: poolType },
        existingMaxSeqId: charMaxSeqId,
      })
      fetchedChar.push(...list)
    }

    const fetchedWeapon = await fetchEfRecords(EF_WEAPON_URL, {
      u8Token,
      serverId,
      existingMaxSeqId: weaponMaxSeqId,
    })

    const { merged: mergedChar, newCount: newCharCount } = mergeRecords(existingChar, fetchedChar)
    const { merged: mergedWeapon, newCount: newWeaponCount } = mergeRecords(existingWeapon, fetchedWeapon)

    const exportData = {
      info: {
        uid: roleId,
        lang: "zh-cn",
        timezone: 8,
        exportTimestamp: Math.floor(Date.now() / 1000),
        version: "v1.0",
      },
      charList: mergedChar,
      weaponList: mergedWeapon,
    }

    const filePath = await saveGachaExport(roleId, exportData)

    return {
      ok: true,
      roleId,
      filePath,
      newCharCount,
      newWeaponCount,
      totalChar: mergedChar.length,
      totalWeapon: mergedWeapon.length,
      exportTimestamp: exportData.info.exportTimestamp,
    }
  } catch (err) {
    return { ok: false, message: `[终末地] 刷新抽卡记录失败：${err?.message || err}` }
  } finally {
    running.delete(roleId)
  }
}

function buildTextSummary({ account, exportData, pools }) {
  const total = (exportData?.charList?.length || 0) + (exportData?.weaponList?.length || 0)
  const time = exportData?.info?.exportTimestamp ? formatYmdHmFromMs(exportData.info.exportTimestamp * 1000) : "-"

  const lines = [
    `[终末地] 抽卡记录`,
    `账号：${account?.nickname || "未命名"} UID:${account?.uid || "-"}`,
    `更新：${time}`,
    `总抽卡：${total}`,
  ]

  for (const p of pools) {
    const stats = p.stats
    const free = stats.free != null ? ` 免费:${stats.free}` : ""
    const avg = stats.avg != null ? ` 平均:${stats.avg.toFixed(1)}` : ""
    lines.push(`${p.title}：抽卡:${stats.total}${free} 6星:${stats.six} 垫抽:${p.pity}${avg}`)
  }

  return lines.join("\n")
}

export async function getGachaLogViewForUser(userId) {
  const { account } = await getActiveAccount(userId)
  if (!account?.cred || !account?.uid) {
    return { ok: false, message: "[终末地] 未绑定账号，请先私聊 #zmd登录 / #zmd绑定" }
  }

  const roleId = String(account.uid)
  const exportData = await loadGachaExport(roleId)
  if (!exportData) {
    return { ok: false, message: "[终末地] 未找到抽卡记录，请先使用：#zmd更新抽卡记录" }
  }

  if (String(exportData?.info?.uid || "") && String(exportData?.info?.uid || "") !== roleId) {
    return {
      ok: false,
      message: `[终末地] 抽卡记录 UID 与当前账号不符。\n当前 UID：${roleId}\n记录 UID：${exportData?.info?.uid || "-"}`,
    }
  }

  return await buildGachaLogView({ userId, roleId, account, exportData })
}

export async function getGachaLogViewForRoleId(roleId, { userId, account, allowUnbound = false } = {}) {
  const rid = String(roleId ?? "").trim()
  if (!rid) return { ok: false, message: "[终末地] 请提供 UID，例如：#zmd抽卡记录1234567890" }

  let accountHint = null
  let callerHasRole = false
  let ownerNickname = ""
  const callerId = String(userId ?? "").trim()

  if (callerId) {
    try {
      const data = await getUserData(callerId)
      const accounts = Array.isArray(data?.accounts) ? data.accounts : []
      const found = accounts.find(a => String(a?.uid || "").trim() === rid)
      if (found && typeof found === "object") {
        accountHint = { ...found }
        callerHasRole = true
      }
      else if (!allowUnbound) {
        return {
          ok: false,
          message: `[终末地] 未在你的绑定账号中找到 UID:${rid}，请先私聊 #zmd登录 绑定该账号`,
        }
      }
    } catch {
      if (!allowUnbound) {
        return {
          ok: false,
          message: `[终末地] 未在你的绑定账号中找到 UID:${rid}，请先私聊 #zmd登录 绑定该账号`,
        }
      }
    }
  } else if (!allowUnbound) {
    return { ok: false, message: "[终末地] 无法确认 UID 归属，请改用：#zmd抽卡记录 或 #zmd抽卡记录 @用户" }
  }

  let faceUserId = callerHasRole ? callerId : ""
  if (!callerHasRole && allowUnbound) {
    try {
      const { userId: boundUserId, nickname } = await findBoundUserByRoleId(rid)
      if (boundUserId) {
        faceUserId = boundUserId
        ownerNickname = String(nickname || "").trim()
        if (!accountHint && ownerNickname) accountHint = { uid: rid, nickname: ownerNickname }
      }
    } catch {}
  }

  const exportData = await loadGachaExport(rid)
  if (!exportData) {
    const hintUid = /^[0-9]{5,}$/.test(rid) ? rid : ""
    return { ok: false, message: `[终末地] 未找到抽卡记录，请先使用：#zmd更新抽卡记录${hintUid}`.trim() }
  }

  if (String(exportData?.info?.uid || "") && String(exportData?.info?.uid || "") !== rid) {
    return {
      ok: false,
      message: `[终末地] 抽卡记录 UID 不匹配。\n查询 UID：${rid}\n记录 UID：${exportData?.info?.uid || "-"}`,
    }
  }

  const override = account && typeof account === "object" ? account : null
  const merged = { ...(accountHint || {}), ...(override || {}) }
  const finalAccount = {
    ...merged,
    uid: String(merged?.uid || rid),
    nickname: String(merged?.nickname || ownerNickname || `UID:${rid}`),
  }

  return await buildGachaLogView({ userId, roleId: rid, account: finalAccount, exportData, faceUserId })
}

async function buildGachaLogView({ userId, roleId, account, exportData, faceUserId }) {
  const charList = Array.isArray(exportData?.charList) ? exportData.charList : []
  const weaponList = Array.isArray(exportData?.weaponList) ? exportData.weaponList : []
  const totalPulls = charList.length + weaponList.length

  const avatarUserId = faceUserId != null ? faceUserId : userId

  // 6 星“实际花费抽数”：从上一次 6 星（不含）到本次 6 星（含）的抽数（含免费抽）
  const charSixCost = buildSixCostByPoolId(charList, { excludeFree: false })
  const weaponSixCost = buildSixCostByPoolId(weaponList, { excludeFree: false })

  let aliasMap = null
  try {
    aliasMap = await loadAliasMap()
  } catch {}

  const charIconById = new Map()
  const charIconByName = new Map()
  if (aliasMap && typeof aliasMap === "object") {
    for (const [key, entryRaw] of Object.entries(aliasMap)) {
      const entry = entryRaw && typeof entryRaw === "object" ? entryRaw : {}
      const url = String(entry.url || entry.avatarRtUrl || entry.illustrationUrl || entry.avatarSqUrl || "").trim()
      if (!url) continue

      const id = String(entry.id || "").trim()
      if (id) charIconById.set(id, url)

      const name = String(entry.name || key || "").trim()
      if (name) charIconByName.set(name, url)
    }
  }

  const weaponIconById = new Map()
  const weaponIconByName = new Map()

  if (userId && weaponList.some(i => safeInt(i?.rarity) === 6)) {
    try {
      const cardRes = await getCardDetailForUser(userId)
      const chars = Array.isArray(cardRes?.res?.data?.detail?.chars) ? cardRes.res.data.detail.chars : []
      for (const char of chars) {
        const weaponData = char?.weapon?.weaponData || {}
        const iconUrl = String(weaponData?.iconUrl || "").trim()
        if (!iconUrl) continue

        const weaponId = String(weaponData?.id || weaponData?.weaponId || weaponData?.itemId || "").trim()
        if (weaponId) weaponIconById.set(weaponId, iconUrl)

        const weaponName = String(weaponData?.name || "").trim()
        if (weaponName) weaponIconByName.set(weaponName, iconUrl)
      }
    } catch {}
  }

  const limitedItems = charList.filter(c => String(c?.poolId || "").startsWith("special_"))
  const standardItems = charList.filter(c => String(c?.poolId || "") === "standard")
  const beginnerItems = charList.filter(c => String(c?.poolId || "") === "beginner")

  const pityByPool = getPityByPoolId(charList, { excludeFree: false })
  const pityLimited = getPityFromRecent(limitedItems, { excludeFree: false })
  const pityWeaponByPool = getPityByPoolId(weaponList, { excludeFree: false })
  const pityWeaponDisplay = Math.max(0, ...Object.values(pityWeaponByPool).map(v => safeInt(v)))

  const pools = [
    {
      key: "limited",
      title: "限定寻访",
      timeRange: formatYmdRangeFromMs(limitedItems),
      pity: pityLimited,
      stats: buildPoolStats(limitedItems, { hasFree: true }),
      sixList: limitedItems.filter(i => safeInt(i?.rarity) === 6).sort(sortTsSeqDesc).slice(0, 24),
    },
    {
      key: "weapon",
      title: "武器寻访",
      timeRange: formatYmdRangeFromMs(weaponList),
      pity: pityWeaponDisplay,
      stats: buildPoolStats(weaponList, { hasFree: false }),
      sixList: weaponList.filter(i => safeInt(i?.rarity) === 6).sort(sortTsSeqDesc).slice(0, 24),
    },
    {
      key: "standard",
      title: "常驻寻访",
      timeRange: formatYmdRangeFromMs(standardItems),
      pity: safeInt(pityByPool.standard, 0),
      stats: buildPoolStats(standardItems, { hasFree: true }),
      sixList: standardItems.filter(i => safeInt(i?.rarity) === 6).sort(sortTsSeqDesc).slice(0, 24),
    },
    {
      key: "beginner",
      title: "新手寻访",
      timeRange: formatYmdRangeFromMs(beginnerItems),
      pity: safeInt(pityByPool.beginner, 0),
      stats: buildPoolStats(beginnerItems, { hasFree: true }),
      sixList: beginnerItems.filter(i => safeInt(i?.rarity) === 6).sort(sortTsSeqDesc).slice(0, 24),
    },
  ]

  const totalSix = charList.filter(i => safeInt(i?.rarity) === 6).length + weaponList.filter(i => safeInt(i?.rarity) === 6).length
  const exportTime = exportData?.info?.exportTimestamp ? formatYmdHmFromMs(exportData.info.exportTimestamp * 1000) : "-"

  const poolsView = pools.map(p => {
    const max = p.key === "weapon" ? 80 : 90
    const cost = p.key === "weapon" ? weaponSixCost : charSixCost
 
    const logs = (p.sixList || []).map(item => {
      const name = String(item?.charName || item?.weaponName || "未知")
      const count = safeInt(cost.get(getItemKey(item)), 1)
      const charId = String(item?.charId || "").trim()
      const charName = String(item?.charName || "").trim()
      let icon = ""
      if (charId) icon = charIconById.get(charId) || ""
      if (!icon && charName) icon = charIconByName.get(charName) || ""
      const weaponId = String(item?.weaponId || "").trim()
      const weaponName = String(item?.weaponName || "").trim()
      if (!icon && weaponId) icon = weaponIconById.get(weaponId) || ""
      if (!icon && weaponName) icon = weaponIconByName.get(weaponName) || ""
      const iconPath = getLocalIconPath({ charId, weaponId })
      return {
        date: formatMdFromMs(item?.gachaTs),
        time: formatYmdHmFromMs(item?.gachaTs),
        name,
        abbr: abbrText(name, 10),
        count,
        icon,
        iconPath,
        cls: item?.isFree ? "wai" : "up",
        rarity: safeInt(item?.rarity),
        isFree: !!item?.isFree,
      }
    })

    const pityCount = safeInt(p.pity, 0)
    if (pityCount > 0) {
      logs.unshift({
        date: "至今",
        time: exportTime,
        name: "未出",
        abbr: "未出",
        count: pityCount,
        icon: "",
        mark: "?",
        cls: "pending",
        rarity: 0,
        isFree: false,
      })
    }

    return {
      ...p,
      max,
      stats: {
        ...p.stats,
        avgText: p.stats.avg != null ? p.stats.avg.toFixed(1) : "-",
      },
      logs,
    }
  })

  const view = {
    elem: "sr",
    uid: roleId,
    exportTime,
    face: {
      banner: "skin/common/bg/bg-sr.webp",
      face: getQqAvatarUrl(avatarUserId),
      qFace: getQqAvatarUrl(avatarUserId),
      name: String(account.nickname || "未命名"),
    },
    gacha: {
      stat: {
        totalNum: totalPulls,
        sixNum: totalSix,
        charNum: charList.length,
        weaponNum: weaponList.length,
      },
      pools: poolsView,
    },
  }

  const text = buildTextSummary({ account, exportData, pools })

  return { ok: true, account, exportData, view, text }

}

function normalizeText(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, "")
}

function extractU8Token(input) {
  const s = normalizeText(input)
  if (!s) return ""

  const decode = value => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  const m1 = s.match(/u8_token=([^&#]+)/i)
  if (m1?.[1]) return decode(m1[1])

  const m2 = s.match(/u8Token=([^&#]+)/i)
  if (m2?.[1]) return decode(m2[1])

  if (/^[A-Za-z0-9._-]{12,}$/.test(s)) return s
  return ""
}

function guessRecordType(record) {
  if (!record || typeof record !== "object") return ""
  if (record.weaponId != null || record.weaponName != null) return "weapon"
  if (record.charId != null || record.charName != null) return "char"
  return ""
}

function normalizeImportedData(incoming) {
  const obj = incoming && typeof incoming === "object" ? incoming : null
  if (!obj) return { charList: [], weaponList: [] }

  const charListDirect = Array.isArray(obj.charList) ? obj.charList : null
  const weaponListDirect = Array.isArray(obj.weaponList) ? obj.weaponList : null
  if (charListDirect || weaponListDirect) {
    return {
      charList: Array.isArray(charListDirect) ? charListDirect : [],
      weaponList: Array.isArray(weaponListDirect) ? weaponListDirect : [],
    }
  }

  const poolData =
    obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
      ? obj.data
      : Object.values(obj).every(v => Array.isArray(v))
        ? obj
        : null

  if (!poolData || typeof poolData !== "object") return { charList: [], weaponList: [] }

  const outChar = []
  const outWeapon = []

  for (const records of Object.values(poolData)) {
    if (!Array.isArray(records)) continue
    for (const r of records) {
      const kind = guessRecordType(r)
      if (kind === "weapon") outWeapon.push(r)
      else outChar.push(r)
    }
  }

  return { charList: outChar, weaponList: outWeapon }
}

async function requireActiveRoleId(userId) {
  const { account } = await getActiveAccount(userId)
  if (!account?.cred || !account?.uid) return { ok: false, message: "[终末地] 未绑定账号，请先私聊 #zmd登录 / #zmd绑定" }
  return { ok: true, account, roleId: String(account.uid) }
}

export async function exportGachaLogsForUser(userId) {
  const { ok, message, roleId } = await requireActiveRoleId(userId)
  if (!ok) return { ok: false, message }

  const filePath = path.join(DATA_DIR, `${roleId}.json`)
  if (!fsSync.existsSync(filePath)) {
    return { ok: false, message: "[终末地] 未找到抽卡记录，请先使用：#zmd更新抽卡记录" }
  }

  return {
    ok: true,
    roleId,
    filePath,
    fileName: `zmd_gacha_${roleId}.json`,
  }
}

export async function deleteGachaLogsForUser(userId) {
  const { ok, message, roleId } = await requireActiveRoleId(userId)
  if (!ok) return { ok: false, message }

  const filePath = path.join(DATA_DIR, `${roleId}.json`)
  if (!fsSync.existsSync(filePath)) {
    return { ok: false, message: "[终末地] 未找到抽卡记录，无需删除" }
  }

  await fs.mkdir(DATA_DIR, { recursive: true })
  const backupPath = `${filePath}.bak`
  await fs.copyFile(filePath, backupPath)
  await fs.unlink(filePath)

  return { ok: true, roleId, backupPath }
}

export async function importGachaLogsFromJsonForUser(userId, rawJson) {
  const { ok, message, roleId } = await requireActiveRoleId(userId)
  if (!ok) return { ok: false, message }

  const incoming = safeJsonParse(String(rawJson || ""), null)
  if (!incoming) return { ok: false, message: "[终末地] JSON 解析失败：内容不是合法 JSON" }

  const normalized = normalizeImportedData(incoming)
  const importChar = Array.isArray(normalized.charList) ? normalized.charList : []
  const importWeapon = Array.isArray(normalized.weaponList) ? normalized.weaponList : []
  if (!importChar.length && !importWeapon.length) return { ok: false, message: "[终末地] JSON 中没有可导入的抽卡记录" }

  const existing = await loadGachaExport(roleId)
  const existingChar = Array.isArray(existing?.charList) ? existing.charList : []
  const existingWeapon = Array.isArray(existing?.weaponList) ? existing.weaponList : []

  const { merged: mergedChar, newCount: newCharCount } = mergeRecords(existingChar, importChar)
  const { merged: mergedWeapon, newCount: newWeaponCount } = mergeRecords(existingWeapon, importWeapon)

  const exportData = {
    info: {
      uid: roleId,
      lang: "zh-cn",
      timezone: 8,
      exportTimestamp: Math.floor(Date.now() / 1000),
      version: "v1.0",
    },
    charList: mergedChar,
    weaponList: mergedWeapon,
  }

  const filePath = await saveGachaExport(roleId, exportData)

  return {
    ok: true,
    roleId,
    filePath,
    newCharCount,
    newWeaponCount,
    totalChar: mergedChar.length,
    totalWeapon: mergedWeapon.length,
  }
}

export async function importGachaLogsFromU8TokenForUser(userId, u8TokenInput) {
  const { account, ok, message, roleId } = await requireActiveRoleId(userId)
  if (!ok) return { ok: false, message }

  const u8Token = extractU8Token(u8TokenInput)
  if (!u8Token) {
    return { ok: false, message: "[终末地] 未识别到 u8_token（可直接贴 token 或包含 u8_token= 的链接）" }
  }

  if (running.has(roleId)) return { ok: false, message: "[终末地] 抽卡记录正在刷新/导入中，请稍后再试（请勿重复触发）" }
  running.add(roleId)

  try {
    const serverId = String(account?.serverId || "1").trim() || "1"
    const existing = await loadGachaExport(roleId)
    const existingChar = Array.isArray(existing?.charList) ? existing.charList : []
    const existingWeapon = Array.isArray(existing?.weaponList) ? existing.weaponList : []

    const charMaxSeqId = getMaxSeqId(existingChar)
    const weaponMaxSeqId = getMaxSeqId(existingWeapon)

    const fetchedChar = []
    for (const poolType of CHARACTER_POOL_TYPES) {
      const list = await fetchEfRecords(EF_CHAR_URL, {
        u8Token,
        serverId,
        extraParams: { pool_type: poolType },
        existingMaxSeqId: charMaxSeqId,
      })
      fetchedChar.push(...list)
    }

    const fetchedWeapon = await fetchEfRecords(EF_WEAPON_URL, {
      u8Token,
      serverId,
      existingMaxSeqId: weaponMaxSeqId,
    })

    const { merged: mergedChar, newCount: newCharCount } = mergeRecords(existingChar, fetchedChar)
    const { merged: mergedWeapon, newCount: newWeaponCount } = mergeRecords(existingWeapon, fetchedWeapon)

    const exportData = {
      info: {
        uid: roleId,
        lang: "zh-cn",
        timezone: 8,
        exportTimestamp: Math.floor(Date.now() / 1000),
        version: "v1.0",
      },
      charList: mergedChar,
      weaponList: mergedWeapon,
    }

    const filePath = await saveGachaExport(roleId, exportData)

    return {
      ok: true,
      account,
      roleId,
      filePath,
      newCharCount,
      newWeaponCount,
      totalChar: mergedChar.length,
      totalWeapon: mergedWeapon.length,
      exportTimestamp: exportData.info.exportTimestamp,
    }
  } catch (err) {
    return { ok: false, message: `[终末地] 导入抽卡记录失败：${err?.message || err}` }
  } finally {
    running.delete(roleId)
  }
}
