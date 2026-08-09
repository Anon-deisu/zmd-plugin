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
import { getCardDetailForUser, getLocalCardDetailByRoleId } from "./card.js"
import { ensureListData } from "./wiki/fetch.js"
import {
  findBestAccountByUid,
  getActiveAccount,
  getUserData,
  upsertAccount,
} from "./store.js"
import { OAUTH_API } from "./skland/api.js"
import { getOauthHeader } from "./skland/headers.js"

import { LEGACY_PLUGIN_DATA_DIR, PLUGIN_DATA_DIR, PLUGIN_RESOURCES_DIR, pluginResourcesRelPath } from "./pluginMeta.js"

const DATA_DIR = path.join(PLUGIN_DATA_DIR, "gachalog")
const LEGACY_DATA_DIR = path.join(LEGACY_PLUGIN_DATA_DIR, "gachalog")
const RES_DIR = PLUGIN_RESOURCES_DIR
const CHAR_ICON_DIR = path.join(RES_DIR, "endfield", "charicon")
const LOCAL_IMAGE_EXTS = [".png", ".webp", ".jpg", ".jpeg"]

function gachaExportFilePaths(roleId) {
  const rid = String(roleId ?? "").trim()
  const name = `${rid}.json`
  return {
    filePath: path.join(DATA_DIR, name),
    legacyPath: path.join(LEGACY_DATA_DIR, name),
  }
}

const BINDING_APP_CODE = "be36d44aa36bfb5b"
const BINDING_LIST_URL = "https://binding-api-account-prod.hypergryph.com/account/binding/v1/binding_list"
const U8_TOKEN_BY_UID_URL = "https://binding-api-account-prod.hypergryph.com/account/binding/v1/u8_token_by_uid"

const EF_CHAR_URL = "https://ef-webview.hypergryph.com/api/record/char"
const EF_WEAPON_URL = "https://ef-webview.hypergryph.com/api/record/weapon"
const EF_CONTENT_URL = "https://ef-webview.hypergryph.com/api/content"
const CONTENT_REQUEST_TIMEOUT_MS = 8000
const RECORD_REQUEST_TIMEOUT_MS = 20000
const WIKI_REQUEST_TIMEOUT_MS = 8000
const IMAGE_REQUEST_TIMEOUT_MS = 15000
const CONTENT_METADATA_VERSION = 2

const CHARACTER_POOL_TYPES = [
  "E_CharacterGachaPoolType_Special",
  "E_CharacterGachaPoolType_Beginner",
  "E_CharacterGachaPoolType_Standard",
  "E_CharacterGachaPoolType_Joint",
]

const CHARACTER_POOL_TYPE_SPECIAL = "E_CharacterGachaPoolType_Special"
const CHARACTER_POOL_TYPE_BEGINNER = "E_CharacterGachaPoolType_Beginner"
const CHARACTER_POOL_TYPE_STANDARD = "E_CharacterGachaPoolType_Standard"
const CHARACTER_POOL_TYPE_JOINT = "E_CharacterGachaPoolType_Joint"

// 已结束卡池的 content 接口会返回 404；这份稳定 ID 表用于首次升级时补齐历史记录。
const KNOWN_CHAR_POOL_FEATURED_IDS = Object.freeze({
  special_1_0_1: ["chr_0016_laevat"],
  special_1_0_2: ["chr_0017_yvonne"],
  special_1_0_3: ["chr_0013_aglina"],
  special_1_1_1: ["chr_0027_tangtang"],
  special_1_1_2: ["chr_0028_wulfa"],
  special_1_2_1: ["chr_0030_zhuangfy"],
  joint_1_2_2: ["chr_0029_pograni", "chr_0013_aglina", "chr_0016_laevat", "chr_0025_ardelia"],
  special_1_3_1: ["chr_0031_mifu"],
  special_1_3_2: ["chr_0033_camille"],
  special_1_4_1: ["chr_0032_lizhiyan"],
})

const contentPoolTypeMap = Object.freeze({
  special: CHARACTER_POOL_TYPE_SPECIAL,
  newbie: CHARACTER_POOL_TYPE_BEGINNER,
  normal: CHARACTER_POOL_TYPE_STANDARD,
  extra: CHARACTER_POOL_TYPE_JOINT,
})
const poolMetadataRuntimeCache = new Map()

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

async function fetchWithTimeout(url, options, timeoutMs, readResponse) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal })
    return await readResponse(resp)
  } finally {
    clearTimeout(timer)
  }
}

async function withPromiseTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function safeInt(value, def = 0) {
  const n = Number.parseInt(`${value ?? ""}`, 10)
  return Number.isFinite(n) ? n : def
}

function isPullRecord(record) {
  return !!record && typeof record === "object" && String(record.kind || "") !== "gift_intel_book"
}

function filterPullRecords(records) {
  return (Array.isArray(records) ? records : []).filter(isPullRecord)
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

function detectImageBufferExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return ""
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png"
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg"
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp"
  return ""
}

function findExistingLocalImageRel(baseName) {
  const raw = String(baseName || "").trim()
  if (!raw) return ""
  for (const ext of LOCAL_IMAGE_EXTS) {
    const rel = `endfield/charicon/${raw}${ext}`
    const fp = path.join(CHAR_ICON_DIR, `${raw}${ext}`)
    if (fsSync.existsSync(fp)) return rel
  }
  return ""
}

async function downloadImageBuffer(url, { referer = "" } = {}) {
  const u = String(url || "").trim()
  if (!u) return null

  const headers = {
    "User-Agent": "Mozilla/5.0",
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  }
  if (referer) headers.Referer = referer

  return await fetchWithTimeout(u, { method: "GET", headers }, IMAGE_REQUEST_TIMEOUT_MS, async resp => {
    if (!resp.ok) return null
    const buf = Buffer.from(await resp.arrayBuffer())
    if (!buf.length) return null
    const ext = detectImageBufferExt(buf)
    if (!ext) return null
    return {
      buf,
      ext,
    }
  })
}

async function ensureLocalCharIcon(charId, url) {
  const cid = String(charId || "").trim()
  const iconUrl = String(url || "").trim()
  if (!cid || !iconUrl) return ""

  const existing = findExistingLocalImageRel(`icon_${cid}`)
  if (existing) return existing

  try {
    const downloaded = await downloadImageBuffer(iconUrl, { referer: "https://www.skland.com/" })
    if (!downloaded?.buf?.length) return ""
    await fs.mkdir(CHAR_ICON_DIR, { recursive: true })
    const fileName = `icon_${cid}${downloaded.ext || ".png"}`
    const filePath = path.join(CHAR_ICON_DIR, fileName)
    await fs.writeFile(filePath, downloaded.buf)
    return `endfield/charicon/${fileName}`
  } catch {
    return ""
  }
}

async function ensureLocalQqFace(userId) {
  const uid = String(userId || "").trim()
  if (!uid) return ""

  const existing = findExistingLocalImageRel(`qq_${uid}`)
  if (existing) return pluginResourcesRelPath(existing)

  try {
    const downloaded = await downloadImageBuffer(getQqAvatarUrl(uid))
    if (!downloaded?.buf?.length) return ""
    await fs.mkdir(CHAR_ICON_DIR, { recursive: true })
    const fileName = `qq_${uid}${downloaded.ext || ".jpg"}`
    const filePath = path.join(CHAR_ICON_DIR, fileName)
    await fs.writeFile(filePath, downloaded.buf)
    return pluginResourcesRelPath(`endfield/charicon/${fileName}`)
  } catch {
    return ""
  }
}

function getCachedRoleOwner(roleId, { requireCred = false } = {}) {
  const rid = String(roleId ?? "").trim()
  if (!rid) return null

  const cached = roleOwnerCache.get(rid)
  if (!cached) return null
  if ((cached.expiresAt || 0) <= Date.now()) {
    roleOwnerCache.delete(rid)
    return null
  }
  if (requireCred && !cached.hasCred) return null
  return cached

}

function setCachedRoleOwner(roleId, { userId = "", nickname = "", hasCred = false } = {}) {
  const rid = String(roleId ?? "").trim()
  if (!rid) return

  const uid = String(userId ?? "").trim()
  const ttl = uid ? ROLE_OWNER_TTL_MS : ROLE_OWNER_NEGATIVE_TTL_MS
  roleOwnerCache.set(rid, {
    userId: uid,
    nickname: String(nickname ?? "").trim(),
    hasCred: !!hasCred,
    expiresAt: Date.now() + ttl,
  })
}

async function findBoundUserByRoleId(roleId, { requireCred = false } = {}) {
  const rid = String(roleId ?? "").trim()
  if (!rid) return { userId: "", nickname: "", hasCred: false }

  const cached = getCachedRoleOwner(rid, { requireCred })
  if (cached && (!requireCred || cached.hasCred)) {
    return { userId: cached.userId, nickname: cached.nickname, hasCred: !!cached.hasCred }
  }

  let userIds = []
  try {
    userIds = await redis.sMembers(KEY_USERS)
  } catch {
    setCachedRoleOwner(rid, {})
    return { userId: "", nickname: "", hasCred: false }
  }

  let fallback = { userId: "", nickname: "", hasCred: false }

  for (const uidRaw of userIds) {
    const uid = String(uidRaw ?? "").trim()
    if (!uid) continue
    try {
      const data = await getUserData(uid)
      const accounts = Array.isArray(data?.accounts) ? data.accounts : []
      const withCred = findBestAccountByUid(accounts, rid, { requireCred: true })
      if (withCred) {
        const res = { userId: uid, nickname: String(withCred?.nickname || "").trim(), hasCred: true }
        setCachedRoleOwner(rid, res)
        return res
      }

      if (!requireCred && !fallback.userId) {
        const found = findBestAccountByUid(accounts, rid)
        if (found) fallback = { userId: uid, nickname: String(found?.nickname || "").trim(), hasCred: !!found?.cred }
      }
    } catch {}
  }

  if (fallback.userId && !requireCred) {
    setCachedRoleOwner(rid, fallback)
    return fallback
  }

  setCachedRoleOwner(rid, {})
  return { userId: "", nickname: "", hasCred: false }
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

function getMaxSeqIdBySourcePoolType(items, sourcePoolType) {
  const poolType = String(sourcePoolType || "").trim()
  if (!poolType) return getMaxSeqId(items)

  const filtered = (items || []).filter(i => String(i?.sourcePoolType || "").trim() === poolType)
  if (!filtered.length) return 0
  return getMaxSeqId(filtered)
}

function markRecordsWithSourcePoolType(records, sourcePoolType) {
  const poolType = String(sourcePoolType || "").trim()
  if (!poolType) return Array.isArray(records) ? records : []
  return (Array.isArray(records) ? records : []).map(record => {
    if (!record || typeof record !== "object") return record
    if (String(record.sourcePoolType || "").trim() === poolType) return record
    return { ...record, sourcePoolType: poolType }
  })
}

function mergeRecordFields(base, incoming) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined || value === null || value === "") continue
    merged[key] = value
  }
  return merged
}

function mergeRecords(existing, newRecords) {
  const merged = []
  const indexByKey = new Map()
  for (const record of filterPullRecords(existing)) {
    const key = getStableRecordKey(record)
    if (key && indexByKey.has(key)) {
      const existingIndex = indexByKey.get(key)
      const current = merged[existingIndex]
      merged[existingIndex] = safeInt(record?.rarity) >= safeInt(current?.rarity)
        ? mergeRecordFields(current, record)
        : mergeRecordFields(record, current)
      continue
    }
    if (key) indexByKey.set(key, merged.length)
    merged.push(record)
  }
  let newCount = 0

  for (const r of filterPullRecords(newRecords)) {
    const id = getStableRecordKey(r)
    if (!id) {
      merged.push(r)
      newCount++
      continue
    }

    const existingIndex = indexByKey.get(id)
    if (existingIndex != null) {
      const current = merged[existingIndex]
      merged[existingIndex] = safeInt(r?.rarity) >= safeInt(current?.rarity)
        ? mergeRecordFields(current, r)
        : mergeRecordFields(r, current)
      continue
    }

    indexByKey.set(id, merged.length)
    merged.push(r)
    newCount++
  }

  merged.sort(sortTsSeqDesc)
  return { merged, newCount }
}

function getPityFromRecent(items, { excludeFree = true } = {}) {
  const sorted = (items || []).slice().sort(sortTsSeqDesc)
  let pity = 0
  for (const item of sorted) {
    if (excludeFree && item?.isFree) continue
    if (safeInt(item?.rarity) === 6) break
    pity++
  }
  return pity
}

function normalizeNameKey(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fff]+/gi, "")
}

function isLimitedPoolId(poolId) {
  const id = String(poolId || "").trim().toLowerCase()
  return id.startsWith("special") || id.startsWith("limited") || id.startsWith("joint")
}

function isLimitedCharPool({ poolId, title } = {}) {
  if (isLimitedPoolId(poolId)) return true
  const t = String(title || "")
  // Heuristic: limited banners are usually labelled as "特许寻访".
  return /特许寻访/.test(t) || /限定/.test(t)
}

function matchFeaturedItem(item, { featuredIds = [], featuredNames = [], featuredNamesComplete = null } = {}) {
  const itemId = String(item?.charId || item?.weaponId || "").trim()
  const idSet = new Set((featuredIds || []).map(value => String(value || "").trim()).filter(Boolean))
  if (itemId && idSet.size) return idSet.has(itemId)

  const itemName = normalizeNameKey(item?.charName || item?.weaponName)
  const nameSet = new Set((featuredNames || []).map(normalizeNameKey).filter(Boolean))
  if (itemName && nameSet.size) {
    if (nameSet.has(itemName)) return true
    const namesAreComplete = featuredNamesComplete == null
      ? (!idSet.size || nameSet.size >= idSet.size)
      : !!featuredNamesComplete
    if (namesAreComplete) return false
  }
  return null
}

function analyzeFeaturedGuarantee(
  poolItems,
  { featuredIds = [], featuredNames = [], featuredNamesComplete = null, firstLimit = 120 } = {},
) {
  const sorted = filterPullRecords(poolItems).slice().sort(sortTsSeqAsc)
  const out = new Map()

  let paidCount = 0
  let hasObtainedFeatured = false
  let hasUnknownFeaturedHistory = false
  let countIsReliable = true
  for (const item of sorted) {
    const isSix = safeInt(item?.rarity) === 6
    const featuredMatch = isSix
      ? matchFeaturedItem(item, { featuredIds, featuredNames, featuredNamesComplete })
      : null
    const isFeatured = featuredMatch === true
    const isFeaturedKnown = featuredMatch !== null

    if (item?.isFree) {
      if (isSix) {
        out.set(item, {
          paidCount,
          isFeatured,
          isFeaturedKnown,
          isBigGuarantee: false,
        })
      }
      continue
    }

    if (!getStableRecordKey(item)) countIsReliable = false
    paidCount += 1
    if (!isSix) continue

    const isBigGuarantee = !!(
      isFeatured &&
      !hasObtainedFeatured &&
      !hasUnknownFeaturedHistory &&
      countIsReliable &&
      paidCount === firstLimit
    )
    out.set(item, { paidCount, isFeatured, isFeaturedKnown, isBigGuarantee })
    if (isFeatured) hasObtainedFeatured = true
    else if (!isFeaturedKnown) hasUnknownFeaturedHistory = true
  }

  return out
}

function inferCharacterSourcePoolType(record) {
  const source = String(record?.sourcePoolType || "").trim()
  if (CHARACTER_POOL_TYPES.includes(source)) return source

  const poolId = String(record?.poolId || "").trim().toLowerCase()
  if (!poolId) return ""
  if (poolId === "standard" || poolId.startsWith("standard_")) return CHARACTER_POOL_TYPE_STANDARD
  if (poolId === "beginner" || poolId.startsWith("beginner_")) return CHARACTER_POOL_TYPE_BEGINNER
  if (poolId.startsWith("joint_")) return CHARACTER_POOL_TYPE_JOINT
  return CHARACTER_POOL_TYPE_SPECIAL
}

function mergeFullCharacterRecords(existing, fetchedByPoolType) {
  const fetchedMap = fetchedByPoolType instanceof Map ? fetchedByPoolType : new Map()
  const fetchedRecords = [...fetchedMap.values()].flatMap(filterPullRecords)
  return mergeRecords(existing, fetchedRecords).merged
}

function mapContentPoolMetadata(candidate, responseData) {
  const pool = responseData?.code === 0 ? responseData?.data?.pool : null
  if (!pool || typeof pool !== "object") return null

  const allItems = Array.isArray(pool.all) ? pool.all : []
  const sixItems = allItems.filter(item => safeInt(item?.rarity) === 6)
  const rawUpNames = String(pool.up6_name || "")
    .split(/[、,，/]/)
    .map(name => name.trim())
    .filter(Boolean)
  const upNameKeys = new Set(rawUpNames.map(normalizeNameKey))
  const featuredItems = pool.pool_type === "extra"
    ? sixItems
    : sixItems.filter(item => upNameKeys.has(normalizeNameKey(item?.name)))
  const allItemsByName = new Map(allItems.map(item => [normalizeNameKey(item?.name), item]))
  const charImagesById = {}
  for (const rotate of Array.isArray(pool.rotate_list) ? pool.rotate_list : []) {
    const image = pickCharAvatarUrl(rotate)
    const item = allItemsByName.get(normalizeNameKey(rotate?.name))
    const charId = String(item?.id || "").trim()
    if (charId && image) charImagesById[charId] = image
  }

  return {
    poolId: String(candidate?.poolId || "").trim(),
    poolName: String(pool.pool_name || candidate?.poolName || "").trim(),
    sourcePoolType: contentPoolTypeMap[String(pool.pool_type || "")] || String(candidate?.sourcePoolType || "").trim(),
    featuredIds: featuredItems.map(item => String(item?.id || "").trim()).filter(Boolean),
    featuredNames: featuredItems.length
      ? featuredItems.map(item => String(item?.name || "").trim()).filter(Boolean)
      : rawUpNames,
    charImagesById,
    source: "content",
    metadataVersion: CONTENT_METADATA_VERSION,
  }
}

function hasFeaturedMetadata(metadata) {
  return !!(
    (Array.isArray(metadata?.featuredIds) && metadata.featuredIds.length) ||
    (Array.isArray(metadata?.featuredNames) && metadata.featuredNames.length)
  )
}

function hasTrustedPoolMetadata(metadata, poolId) {
  const source = String(metadata?.source || "")
  return (
    hasFeaturedMetadata(metadata) &&
    String(metadata?.poolId || "").trim() === String(poolId || "").trim() &&
    (source === "content" || source === "known")
  )
}

function hasCurrentContentMetadata(metadata) {
  return metadata?.source === "content" && safeInt(metadata?.metadataVersion) >= CONTENT_METADATA_VERSION
}

function getKnownPoolMetadata(candidate) {
  const poolId = String(candidate?.poolId || "").trim()
  const featuredIds = KNOWN_CHAR_POOL_FEATURED_IDS[poolId]
  if (!Array.isArray(featuredIds) || !featuredIds.length) return null
  return {
    poolId,
    poolName: String(candidate?.poolName || "").trim(),
    sourcePoolType: String(candidate?.sourcePoolType || inferCharacterSourcePoolType(candidate)).trim(),
    featuredIds: featuredIds.slice(),
    featuredNames: [],
    source: "known",
  }
}

async function fetchContentPoolMetadata(candidate, { serverId = "1" } = {}) {
  const poolId = String(candidate?.poolId || "").trim()
  if (!poolId) return null

  const query = new URLSearchParams({
    lang: "zh-cn",
    pool_id: poolId,
    server_id: String(serverId || "1"),
  }).toString()
  return await fetchWithTimeout(
    `${EF_CONTENT_URL}?${query}`,
    { method: "GET" },
    CONTENT_REQUEST_TIMEOUT_MS,
    async resp => {
      if (!resp.ok) return null
      return mapContentPoolMetadata(candidate, await readJsonSafe(resp))
    },
  )
}

async function resolveCharacterPoolMetadata(records, { existingMetadata = {}, serverId = "1" } = {}) {
  const stored = existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
    ? existingMetadata
    : {}
  const result = {}
  const candidates = new Map()

  for (const record of filterPullRecords(records)) {
    const poolId = String(record?.poolId || "").trim()
    if (!poolId || candidates.has(poolId)) continue
    const sourcePoolType = inferCharacterSourcePoolType(record)
    if (sourcePoolType !== CHARACTER_POOL_TYPE_SPECIAL && sourcePoolType !== CHARACTER_POOL_TYPE_JOINT) continue
    candidates.set(poolId, {
      poolId,
      poolName: String(record?.poolName || "").trim(),
      sourcePoolType,
    })
  }

  const unresolved = []
  for (const candidate of candidates.values()) {
    const persisted = stored[candidate.poolId]
    if (hasTrustedPoolMetadata(persisted, candidate.poolId)) {
      result[candidate.poolId] = persisted
      poolMetadataRuntimeCache.set(candidate.poolId, persisted)
      if (hasCurrentContentMetadata(persisted)) continue
    }

    const runtime = poolMetadataRuntimeCache.get(candidate.poolId)
    if (hasTrustedPoolMetadata(runtime, candidate.poolId)) {
      result[candidate.poolId] = runtime
      if (hasCurrentContentMetadata(runtime)) continue
    }

    unresolved.push(candidate)
  }

  const resolved = await Promise.all(unresolved.map(async candidate => {
    let metadata = null
    try {
      metadata = await fetchContentPoolMetadata(candidate, { serverId })
    } catch {}
    if (!hasFeaturedMetadata(metadata)) metadata = result[candidate.poolId] || getKnownPoolMetadata(candidate)
    return [candidate.poolId, metadata]
  }))

  for (const [poolId, metadata] of resolved) {
    if (!hasTrustedPoolMetadata(metadata, poolId)) continue
    result[poolId] = metadata
    poolMetadataRuntimeCache.set(poolId, metadata)
  }

  return result
}

function scoreBannerMatch(poolTitle, bannerName) {
  const a = String(poolTitle || "").trim()
  const b = String(bannerName || "").trim()
  if (!a || !b) return 0
  if (a === b) return 120
  if (a.includes(b)) return 110
  if (b.includes(a)) return 105
  const ak = normalizeNameKey(a)
  const bk = normalizeNameKey(b)
  if (!ak || !bk) return 0
  if (ak === bk) return 100
  if (ak.includes(bk) || bk.includes(ak)) return 90
  return 0
}

function pickUpTargetKeyFromWiki(listData, { poolTitle = "", latestTs = 0 } = {}) {
  const gacha = Array.isArray(listData?.gacha) ? listData.gacha : []
  if (!gacha.length) return ""

  const latestSec = Math.floor((Number(latestTs) || 0) / 1000)
  let best = { score: 0, key: "" }

  for (const b of gacha) {
    if (String(b?.banner_type || "") !== "character") continue
    const targetName = String(b?.target_name || "").trim()
    if (!targetName) continue

    const nameScore = scoreBannerMatch(poolTitle, b?.banner_name)
    if (!nameScore) continue

    let timeScore = 0
    const start = Number(b?.start_timestamp) || 0
    const end = Number(b?.end_timestamp) || 0
    if (latestSec > 0 && start > 0 && end > 0 && latestSec >= start && latestSec <= end) timeScore = 30

    const score = nameScore + timeScore
    if (score > best.score) {
      best = { score, key: normalizeNameKey(targetName) }
    }
  }

  return best.key
}

function buildPoolStats(items, { hasFree = false } = {}) {
  const total = Array.isArray(items) ? items.length : 0
  const six = (items || []).filter(i => safeInt(i?.rarity) === 6).length
  const free = hasFree ? (items || []).filter(i => !!i?.isFree).length : null
  const nonFree = hasFree ? total - (free || 0) : total
  // Average cost should follow pity rules: free pulls do not count.
  const paidSix = hasFree ? (items || []).filter(i => safeInt(i?.rarity) === 6 && !i?.isFree).length : six
  const avg = paidSix > 0 && nonFree > 0 ? nonFree / paidSix : null
  return { total, six, free, nonFree, avg }
}

function buildFreeTenPullLogs(poolItems, { minCount = 10, maxGroups = 2 } = {}) {
  const min = Math.max(1, safeInt(minCount, 10))
  const max = Math.max(0, safeInt(maxGroups, 2))
  if (max <= 0) return []

  // Group free pulls by timestamp. In practice, a "free ten-pull" shows up as 10 records sharing the same gachaTs.
  const groups = new Map()
  for (const it of poolItems || []) {
    if (!it?.isFree) continue
    const ts = safeInt(it?.gachaTs, 0)
    if (!ts) continue
    groups.set(ts, (groups.get(ts) || 0) + 1)
  }

  const out = []
  for (const [ts, count] of groups.entries()) {
    if (safeInt(count, 0) < min) continue
    const c = safeInt(count, 0)
    out.push({
      logType: "free",
      ts,
      date: formatMdFromMs(ts),
      time: formatYmdHmFromMs(ts),
      name: `免费${c}抽`,
      abbr: `免费${c}抽`,
      count: c,
      freeCount: c,
      icon: "",
      iconPath: "",
      mark: "免",
      cls: "free",
      rarity: 0,
      isFree: true,
      tag: "",
      tagCls: "",
    })
  }

  out.sort((a, b) => safeInt(b?.ts) - safeInt(a?.ts))
  return out.slice(0, max)
}

function combineGachaLogs(sixLogs, freeLogs) {
  return [...(sixLogs || []), ...(freeLogs || [])].sort((a, b) => {
    const tsDiff = safeInt(b?.ts) - safeInt(a?.ts)
    if (tsDiff !== 0) return tsDiff
    return String(a?.logType || "").localeCompare(String(b?.logType || ""))
  })
}

function getItemKey(item) {
  const poolId = String(item?.poolId || "")
  const gachaTs = String(item?.gachaTs ?? "")
  const seqId = String(item?.seqId ?? "")
  if (!poolId && !gachaTs && !seqId) return ""
  return `${poolId}|${gachaTs}|${seqId}`
}

function getStableRecordKey(item) {
  const poolId = String(item?.poolId || "").trim()
  const gachaTs = String(item?.gachaTs ?? "").trim()
  const seqId = String(item?.seqId ?? "").trim()
  if (!poolId || !gachaTs || !seqId) return ""
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
      cost.set(item, sinceLastSix)
      sinceLastSix = 0
    }
  }

  return cost
}

function pickPoolName(poolItems, fallback = "") {
  const sorted = (poolItems || []).slice().sort(sortTsSeqDesc)
  for (const item of sorted) {
    const name = String(item?.poolName || "").trim()
    if (name) return name
  }
  return String(fallback || "").trim()
}

function buildPoolsByPoolId(items, { kind = "char", hasFree = true } = {}) {
  const byPool = new Map()
  for (const item of items || []) {
    const poolId = String(item?.poolId || "").trim() || `${kind}_unknown`
    if (!byPool.has(poolId)) byPool.set(poolId, [])
    byPool.get(poolId).push(item)
  }

  const pools = []
  for (const [poolId, poolItems] of byPool.entries()) {
    const latestTs = Math.max(...poolItems.map(i => safeInt(i?.gachaTs, 0)))
    const baseTitle = pickPoolName(poolItems, kind === "weapon" ? "武器寻访" : "角色寻访")
    pools.push({
      key: `${kind}:${poolId}`,
      kind,
      poolId,
      title: baseTitle,
      timeRange: formatYmdRangeFromMs(poolItems),
      pity: getPityFromRecent(poolItems, { excludeFree: true }),
      stats: buildPoolStats(poolItems, { hasFree }),
      sixList: poolItems.filter(i => safeInt(i?.rarity) === 6).sort(sortTsSeqDesc),
      latestTs,
    })
  }

  return pools.sort((a, b) => {
    if (b.latestTs !== a.latestTs) return b.latestTs - a.latestTs
    return String(a.poolId || "").localeCompare(String(b.poolId || ""), "zh-Hans-CN")
  })
}

function setIconMapByName(map, name, url) {
  const rawName = String(name || "").trim()
  const rawUrl = String(url || "").trim()
  if (!rawName || !rawUrl) return

  if (!map.has(rawName)) map.set(rawName, rawUrl)

  const nk = normalizeNameKey(rawName)
  if (nk && !map.has(nk)) map.set(nk, rawUrl)
}

function getIconFromNameMap(map, name) {
  const rawName = String(name || "").trim()
  if (!rawName || !(map instanceof Map)) return ""
  return map.get(rawName) || map.get(normalizeNameKey(rawName)) || ""
}

function pickCharAvatarUrl(raw = {}) {
  const obj = raw && typeof raw === "object" ? raw : {}
  const candidates = [
    obj.image,
    obj.url,
    obj.avatarRtUrl,
    obj.avatar_rt_url,
    obj.illustrationUrl,
    obj.illustration_url,
    obj.avatarSqUrl,
    obj.avatar_sq_url,
    obj.avatarUrl,
    obj.avatar_url,
    obj.iconUrl,
    obj.icon_url,
  ]

  for (const v of candidates) {
    const s = String(v || "").trim()
    if (s) return s
  }
  return ""
}

function appendCharIconMapsFromChars(chars, { byId, byName } = {}) {
  const list = Array.isArray(chars) ? chars : []
  for (const char of list) {
    const charData = char?.charData && typeof char.charData === "object" ? char.charData : char
    const iconUrl = pickCharAvatarUrl(charData)
    if (!iconUrl) continue

    const charId = String(charData?.id || char?.id || "").trim()
    if (charId && byId instanceof Map && !byId.has(charId)) byId.set(charId, iconUrl)

    const charName = String(charData?.name || char?.name || "").trim()
    if (byName instanceof Map) setIconMapByName(byName, charName, iconUrl)
  }
}

function appendCharIconMapFromWikiList(listData, byName) {
  if (!(byName instanceof Map)) return
  const groups = listData?.characters && typeof listData.characters === "object" ? listData.characters : {}
  for (const entries of Object.values(groups)) {
    for (const item of Array.isArray(entries) ? entries : []) {
      const name = String(item?.name || "").trim()
      const url = pickCharAvatarUrl(item)
      setIconMapByName(byName, name, url)
    }
  }
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
    const rel = findExistingLocalImageRel(`icon_${cid}`)
    if (rel) return rel
  }

  return ""
}

async function getBindingGrantToken(hgToken, { deviceToken, userId } = {}) {
  const payload = { token: String(hgToken), appCode: BINDING_APP_CODE, type: 1 }
  const dt = String(deviceToken || "").trim()
  if (dt) payload.deviceToken = dt

  const resp = await fetch(OAUTH_API, {
    method: "POST",
    headers: getOauthHeader(),
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
    headers: { "Content-Type": "application/json" },
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

function assertRecordPageProgress(list, hasMore, currentSeqId = 0) {
  if (hasMore && !list.length) {
    throw new Error("抽卡记录分页返回空列表，已取消本次更新以保护本地记录")
  }
  if (!hasMore) return 0

  const nextSeqId = safeInt(list[list.length - 1]?.seqId)
  if (nextSeqId <= 0 || (safeInt(currentSeqId) > 0 && nextSeqId >= safeInt(currentSeqId))) {
    throw new Error("抽卡记录分页游标未推进，已取消本次更新以保护本地记录")
  }
  return nextSeqId
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
    const response = await fetchWithTimeout(fullUrl, { method: "GET" }, RECORD_REQUEST_TIMEOUT_MS, async resp => ({
      ok: resp.ok,
      status: resp.status,
      json: await readJsonSafe(resp),
    }))
    if (!response.ok) throw new Error(`抽卡记录请求失败：HTTP ${response.status}`)

    const json = response.json
    if (!json || json.code !== 0 || !json.data) throw new Error(`抽卡记录请求失败：${json?.msg || "未知错误"}`)

    const list = Array.isArray(json.data?.list) ? json.data.list : []
    const nextSeqId = assertRecordPageProgress(list, !!json.data?.hasMore, seqId)

    let shouldStop = false
    for (const r of list) {
      const currentSeq = safeInt(r?.seqId)
      if (existingMaxSeqId > 0 && currentSeq > 0 && currentSeq <= existingMaxSeqId) {
        shouldStop = true
        break
      }
      if (isPullRecord(r)) records.push(r)
    }

    if (shouldStop) break

    hasMore = !!json.data?.hasMore
    if (hasMore) seqId = nextSeqId

    // 小延迟：避免短时间内高频请求触发风控。
    if (hasMore) await sleep(100)
  }

  return records
}

async function loadGachaExport(roleId) {
  const rid = String(roleId ?? "").trim()
  if (!rid) return null
  const { filePath, legacyPath } = gachaExportFilePaths(rid)
  try {
    let text = ""
    let fromLegacy = false
    try {
      text = await fs.readFile(filePath, "utf8")
    } catch {
      text = await fs.readFile(legacyPath, "utf8")
      fromLegacy = true
    }
    const data = safeJsonParse(text, null)
    if (!data || typeof data !== "object") return null
    data.charList = filterPullRecords(data.charList)
    data.weaponList = filterPullRecords(data.weaponList)
    if (!data.info || typeof data.info !== "object") data.info = {}
    if (!data.poolMetadata || typeof data.poolMetadata !== "object" || Array.isArray(data.poolMetadata)) data.poolMetadata = {}

    // Best-effort: migrate legacy cache to the new bot-level data dir.
    if (fromLegacy) saveGachaExport(rid, data).catch(() => {})

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

export async function updateGachaLogsForUser(userId, { full = false } = {}) {
  const { account } = await getActiveAccount(userId)
  if (!account?.cred || !account?.uid) {
    return { ok: false, message: "[终末地] 未绑定账号，请先私聊 #zmd登录 / #zmd绑定" }
  }

  return await updateGachaLogsForAccount(userId, account, { full })
}

export async function updateGachaLogsForRoleId(userId, roleId, { full = false } = {}) {
  const rid = String(roleId ?? "").trim()
  if (!rid) return { ok: false, message: "[终末地] 请提供 UID，例如：#zmd更新抽卡记录1234567890" }

  // 优先使用调用者自己的绑定（若存在），避免跨用户读取/更新。
  try {
    const data = await getUserData(userId)
    const accounts = Array.isArray(data?.accounts) ? data.accounts : []
    const account = findBestAccountByUid(accounts, rid, { requireCred: true })
    if (account?.cred) return await updateGachaLogsForAccount(userId, account, { full })
  } catch {}

  // 公共刷新：调用者未绑定该 UID 时，尝试使用“已绑定该 UID 的用户”来刷新。
  // 注意：这不会把账号绑定到调用者，只是复用持有者的登录态来更新本地缓存文件。
  try {
    const owner = await findBoundUserByRoleId(rid, { requireCred: true })
    const ownerId = String(owner?.userId || "").trim()
    if (!ownerId) {
      return {
        ok: false,
        message: `[终末地] 未找到 UID:${rid} 的绑定账号，无法自动更新。\n请让账号持有者私聊 #zmd登录 绑定后再试，或用 #zmd导入抽卡记录 手动导入。`,
      }
    }

    const ownerData = await getUserData(ownerId)
    const ownerAccounts = Array.isArray(ownerData?.accounts) ? ownerData.accounts : []
    const ownerAccount = findBestAccountByUid(ownerAccounts, rid, { requireCred: true })
    if (!ownerAccount?.cred) {
      return {
        ok: false,
        message: `[终末地] UID:${rid} 已登记但缺少有效凭据，无法自动更新。\n请让账号持有者私聊 #zmd登录 重新绑定后再试。`,
      }
    }

    return await updateGachaLogsForAccount(ownerId, ownerAccount, { full })
  } catch (err) {
    return { ok: false, message: `[终末地] 刷新抽卡记录失败：${err?.message || err}` }
  }
}

async function updateGachaLogsForAccount(userId, account, { full = false } = {}) {
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

    const charMaxSeqIdByPoolType = new Map(
      CHARACTER_POOL_TYPES.map(poolType => [poolType, full ? 0 : getMaxSeqIdBySourcePoolType(existingChar, poolType)]),
    )
    const weaponMaxSeqId = full ? 0 : getMaxSeqId(existingWeapon)

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
    const fetchedCharByPoolType = new Map()
    for (const poolType of CHARACTER_POOL_TYPES) {
      const list = await fetchEfRecords(EF_CHAR_URL, {
        u8Token,
        serverId,
        extraParams: { pool_type: poolType },
        existingMaxSeqId: charMaxSeqIdByPoolType.get(poolType) || 0,
      })
      const marked = markRecordsWithSourcePoolType(list, poolType)
      fetchedCharByPoolType.set(poolType, marked)
      fetchedChar.push(...marked)
    }

    const fetchedWeapon = await fetchEfRecords(EF_WEAPON_URL, {
      u8Token,
      serverId,
      existingMaxSeqId: weaponMaxSeqId,
    })

    // 抽卡历史是追加型数据：全量重拉用于补缺和修正同键字段，不删除接口未返回的旧记录。
    const mergedCharResult = full
      ? { merged: mergeFullCharacterRecords(existingChar, fetchedCharByPoolType), newCount: 0 }
      : mergeRecords(existingChar, fetchedChar)
    const mergedWeaponResult = mergeRecords(existingWeapon, fetchedWeapon)
    const { merged: mergedChar, newCount: mergedCharCount } = mergedCharResult
    const { merged: mergedWeapon, newCount: mergedWeaponCount } = mergedWeaponResult

    if (full && (existingChar.length > 0 || existingWeapon.length > 0) && !mergedChar.length && !mergedWeapon.length) {
      return { ok: false, message: "[终末地] 全量重拉返回空数据，已取消覆盖本地记录（请稍后重试）" }
    }

    const newCharCount = full ? Math.max(0, mergedChar.length - existingChar.length) : mergedCharCount
    const newWeaponCount = full ? Math.max(0, mergedWeapon.length - existingWeapon.length) : mergedWeaponCount
    const deltaChar = mergedChar.length - existingChar.length
    const deltaWeapon = mergedWeapon.length - existingWeapon.length

    const poolMetadata = await resolveCharacterPoolMetadata(mergedChar, {
      existingMetadata: existing?.poolMetadata,
      serverId,
    })

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
      poolMetadata,
    }

    const filePath = await saveGachaExport(roleId, exportData)

    return {
      ok: true,
      mode: full ? "full" : "incremental",
      roleId,
      filePath,
      newCharCount,
      newWeaponCount,
      deltaChar,
      deltaWeapon,
      oldChar: existingChar.length,
      oldWeapon: existingWeapon.length,
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

function normalizePoolKind(poolKind) {
  const kind = String(poolKind || "").trim().toLowerCase()
  if (kind === "char" || kind === "role" || kind === "character") return "char"
  if (kind === "weapon") return "weapon"
  return "all"
}

function getSummaryTitle(poolKind) {
  if (poolKind === "char") return "角色抽卡记录"
  if (poolKind === "weapon") return "武器抽卡记录"
  return "抽卡记录"
}

function buildTextSummary({ account, pools, exportTime = "-", totalPulls = 0, poolKind = "all" }) {
  const title = getSummaryTitle(poolKind)

  const lines = [
    `[终末地] ${title}`,
    `账号：${account?.nickname || "未命名"} UID:${account?.uid || "-"}`,
    `更新：${exportTime}`,
    `总抽卡：${totalPulls}`,
  ]

  for (const p of pools) {
    const stats = p.stats
    const free = stats.free != null ? ` 免费:${stats.free}` : ""
    const avg = stats.avg != null ? ` 平均:${stats.avg.toFixed(1)}` : ""
    lines.push(`${p.title}：抽卡:${stats.total}${free} 6星:${stats.six} 垫抽:${p.pity}${avg}`)
  }

  return lines.join("\n")
}

export async function getGachaLogViewForUser(userId, { poolKind } = {}) {
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

  return await buildGachaLogView({ userId, roleId, account, exportData, poolKind })
}

export async function getGachaLogViewForRoleId(roleId, { userId, account, allowUnbound = false, poolKind } = {}) {
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
      const found = findBestAccountByUid(accounts, rid)
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

  return await buildGachaLogView({ userId, roleId: rid, account: finalAccount, exportData, faceUserId, poolKind })
}

async function buildGachaLogView({ userId, roleId, account, exportData, faceUserId, poolKind } = {}) {
  const charList = Array.isArray(exportData?.charList) ? exportData.charList : []
  const weaponList = Array.isArray(exportData?.weaponList) ? exportData.weaponList : []

  const avatarUserId = String(faceUserId || userId || "").trim()
  const iconUserId = String(faceUserId || userId || "").trim()

  // 6 星“花费抽数”：按保底规则，不计入免费抽。
  const charSixCost = buildSixCostByPoolId(charList, { excludeFree: true })
  const weaponSixCost = buildSixCostByPoolId(weaponList, { excludeFree: true })

  // poolId -> items (for limited big pity computations)
  const charItemsByPoolId = new Map()
  for (const it of charList) {
    const pid = String(it?.poolId || "").trim() || "char_unknown"
    if (!charItemsByPoolId.has(pid)) charItemsByPoolId.set(pid, [])
    charItemsByPoolId.get(pid).push(it)
  }
  const weaponItemsByPoolId = new Map()
  for (const it of weaponList) {
    const pid = String(it?.poolId || "").trim() || "weapon_unknown"
    if (!weaponItemsByPoolId.has(pid)) weaponItemsByPoolId.set(pid, [])
    weaponItemsByPoolId.get(pid).push(it)
  }

  let aliasMap = null
  try {
    aliasMap = await loadAliasMap()
  } catch {}

  const charIconById = new Map()
  const charIconByName = new Map()
  if (aliasMap && typeof aliasMap === "object") {
    for (const [key, entryRaw] of Object.entries(aliasMap)) {
      const entry = entryRaw && typeof entryRaw === "object" ? entryRaw : {}
      const url = pickCharAvatarUrl(entry)
      if (!url) continue

      const id = String(entry.id || "").trim()
      if (id) charIconById.set(id, url)

      const name = String(entry.name || key || "").trim()
      setIconMapByName(charIconByName, name, url)
      setIconMapByName(charIconByName, key, url)
      for (const alias of Array.isArray(entry.alias) ? entry.alias : []) {
        setIconMapByName(charIconByName, alias, url)
      }
    }
  }

  const weaponIconById = new Map()
  const weaponIconByName = new Map()

  try {
    const localCard = await getLocalCardDetailByRoleId(roleId)
    const chars = Array.isArray(localCard?.detail?.chars) ? localCard.detail.chars : []
    if (chars.length) {
      appendCharIconMapsFromChars(chars, { byId: charIconById, byName: charIconByName })
      for (const char of chars) {
        const weaponData = char?.weapon?.weaponData || {}
        const iconUrl = String(weaponData?.iconUrl || "").trim()
        if (!iconUrl) continue

        const weaponId = String(weaponData?.id || weaponData?.weaponId || weaponData?.itemId || "").trim()
        if (weaponId && !weaponIconById.has(weaponId)) weaponIconById.set(weaponId, iconUrl)

        const weaponName = String(weaponData?.name || "").trim()
        if (weaponName && !weaponIconByName.has(weaponName)) weaponIconByName.set(weaponName, iconUrl)
      }
    }
  } catch {}

  if (iconUserId && (charList.some(i => safeInt(i?.rarity) === 6) || weaponList.some(i => safeInt(i?.rarity) === 6))) {
    try {
      const cardRes = await getCardDetailForUser(iconUserId)
      const activeRoleId = String(cardRes?.account?.uid || "").trim()
      if (!activeRoleId || activeRoleId !== String(roleId || "").trim()) throw new Error("active_card_uid_mismatch")
      const chars = Array.isArray(cardRes?.res?.data?.detail?.chars) ? cardRes.res.data.detail.chars : []
      appendCharIconMapsFromChars(chars, { byId: charIconById, byName: charIconByName })
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

  // 按 poolId 拆分卡池（而不是“限定/常驻”大类聚合），避免新旧限定池互相混算。
  const charPools = buildPoolsByPoolId(charList, { kind: "char", hasFree: true })
  const weaponPools = buildPoolsByPoolId(weaponList, { kind: "weapon", hasFree: false })
  const allPools = [...charPools, ...weaponPools].sort((a, b) => {
    if ((b.latestTs || 0) !== (a.latestTs || 0)) return (b.latestTs || 0) - (a.latestTs || 0)
    return String(a.title || "").localeCompare(String(b.title || ""), "zh-Hans-CN")
  })

  const kind = normalizePoolKind(poolKind)
  const showChar = kind === "all" || kind === "char"
  const showWeapon = kind === "all" || kind === "weapon"

  const pools = allPools.filter(p => (p.kind === "char" && showChar) || (p.kind === "weapon" && showWeapon))

  const totalChar = showChar ? charList.length : 0
  const totalWeapon = showWeapon ? weaponList.length : 0
  const totalPulls = totalChar + totalWeapon

  const totalCharSix = showChar ? charList.filter(i => safeInt(i?.rarity) === 6).length : 0
  const totalWeaponSix = showWeapon ? weaponList.filter(i => safeInt(i?.rarity) === 6).length : 0
  const totalSix = totalCharSix + totalWeaponSix

  const exportTime = exportData?.info?.exportTimestamp ? formatYmdHmFromMs(exportData.info.exportTimestamp * 1000) : "-"
  const poolMetadata = await resolveCharacterPoolMetadata(showChar ? charList : [], {
    existingMetadata: exportData?.poolMetadata,
    serverId: String(account?.serverId || "1").trim() || "1",
  })
  for (const metadata of Object.values(poolMetadata)) {
    for (const [charId, image] of Object.entries(metadata?.charImagesById || {})) {
      const id = String(charId || "").trim()
      const url = String(image || "").trim()
      if (id && url) charIconById.set(id, url)
    }
  }

  // 官方卡池元数据优先；Wiki 仅补充未能从 content 接口或历史 ID 表解析的卡池。
  let wikiListData = null
  try {
    const needUpDetect = pools.some(p => {
      if (p.kind !== "char" || !isLimitedCharPool({ poolId: p.poolId, title: p.title })) return false
      const metadata = poolMetadata[String(p.poolId || "").trim()]
      return !Array.isArray(metadata?.featuredNames) || !metadata.featuredNames.length
    })
    const needCharIconFallback = pools.some(p => p.kind === "char" && Array.isArray(p?.sixList) && p.sixList.length > 0)
    if (needUpDetect || needCharIconFallback) {
      wikiListData = await withPromiseTimeout(ensureListData(), WIKI_REQUEST_TIMEOUT_MS, "Wiki 卡池数据请求超时")
    }
  } catch {}

  if (wikiListData) appendCharIconMapFromWikiList(wikiListData, charIconByName)

  let poolsView = pools.map(p => {
    const poolItems =
      p.kind === "weapon"
        ? (weaponItemsByPoolId.get(String(p.poolId || "").trim()) || [])
        : (charItemsByPoolId.get(String(p.poolId || "").trim()) || [])

    const isLimited = p.kind === "char" && isLimitedCharPool({ poolId: p.poolId, title: p.title })

    const metadata = poolMetadata[String(p.poolId || "").trim()]
    let featuredIds = Array.isArray(metadata?.featuredIds) ? metadata.featuredIds : []
    let featuredNames = Array.isArray(metadata?.featuredNames) ? metadata.featuredNames : []
    if (featuredIds.length && aliasMap && typeof aliasMap === "object") {
      const featuredIdSet = new Set(featuredIds.map(id => String(id || "").trim()).filter(Boolean))
      const namesFromAlias = []
      for (const [aliasKey, entryRaw] of Object.entries(aliasMap)) {
        const entry = entryRaw && typeof entryRaw === "object" ? entryRaw : {}
        if (!featuredIdSet.has(String(entry.id || "").trim())) continue
        const name = String(entry.name || aliasKey || "").trim()
        if (name) namesFromAlias.push(name)
      }
      featuredNames = [...new Set([...featuredNames, ...namesFromAlias])]
    }
    if (isLimited && !featuredNames.length) {
      try {
        if (wikiListData) {
          const wikiTarget = pickUpTargetKeyFromWiki(wikiListData, { poolTitle: p.title, latestTs: p.latestTs })
          if (wikiTarget) featuredNames = [wikiTarget]
        }
      } catch {}
    }

    const hasLimitedUp = !!(isLimited && (featuredIds.length || featuredNames.length))
    const featuredNamesComplete = featuredNames.length > 0 && (
      !featuredIds.length ||
      featuredIds.length === 1 ||
      (metadata?.source === "content" && featuredNames.length >= featuredIds.length)
    )
    const max = 80

    const cost = p.kind === "weapon" ? weaponSixCost : charSixCost

    const guaranteeByItem = hasLimitedUp
      ? analyzeFeaturedGuarantee(poolItems, { featuredIds, featuredNames, featuredNamesComplete, firstLimit: 120 })
      : null

    const sixLogs = (p.sixList || []).map(item => {
      const name = String(item?.charName || item?.weaponName || "未知")
      const isFree = !!item?.isFree
      const smallCount = Math.max(1, safeInt(cost.get(item), 1))

      const count = smallCount
      const guarantee = guaranteeByItem?.get(item)
      const isUp = !!guarantee?.isFeatured
      const isUpKnown = !!guarantee?.isFeaturedKnown

      const tags = []
      // Tags are shown outside the bar to avoid clipping.
      if (hasLimitedUp && isUpKnown && safeInt(item?.rarity) === 6 && !isFree && !isUp) tags.push("歪")
      if (!isFree && safeInt(item?.rarity) === 6 && smallCount >= 80) tags.push("保底")
      if (hasLimitedUp && guarantee?.isBigGuarantee) tags.push("大保底")
      const tag = tags.length ? tags.join("+") : ""

      let tagCls = ""
      if (tag.includes("大保底")) tagCls = "tag-dabao"
      else if (tag.includes("歪")) tagCls = "tag-wai"
      else if (tag.includes("保底")) tagCls = "tag-baodi"
      const charId = String(item?.charId || "").trim()
      const charName = String(item?.charName || "").trim()
      let icon = ""
      if (charId) icon = charIconById.get(charId) || ""
      if (!icon && charName) icon = getIconFromNameMap(charIconByName, charName)
      const weaponId = String(item?.weaponId || "").trim()
      const weaponName = String(item?.weaponName || "").trim()
      if (!icon && weaponId) icon = weaponIconById.get(weaponId) || ""
      if (!icon && weaponName) icon = getIconFromNameMap(weaponIconByName, weaponName)
      const iconPath = getLocalIconPath({ charId, weaponId })
      return {
        logType: "six",
        ts: safeInt(item?.gachaTs, 0),
        date: formatMdFromMs(item?.gachaTs),
        time: formatYmdHmFromMs(item?.gachaTs),
        name,
        abbr: abbrText(name, 10),
        count,
        icon,
        iconPath,
        charId,
        weaponId,
        cls: isFree ? "free" : isLimited ? (hasLimitedUp && isUpKnown ? (isUp ? "up" : "wai") : "unknown") : "up",
        rarity: safeInt(item?.rarity),
        isFree,
        tag,
        tagCls,
      }
    })

    const freeTenLogs = p.kind === "char" ? buildFreeTenPullLogs(poolItems, { minCount: 10, maxGroups: 2 }) : []
    const logs = combineGachaLogs(sixLogs, freeTenLogs)

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

  const remoteIconLogsByCharId = new Map()
  for (const pool of poolsView) {
    for (const log of Array.isArray(pool?.logs) ? pool.logs : []) {
      if (log?.iconPath || !log?.icon || !log?.charId) continue
      if (!remoteIconLogsByCharId.has(log.charId)) remoteIconLogsByCharId.set(log.charId, [])
      remoteIconLogsByCharId.get(log.charId).push(log)
    }
  }

  await Promise.all([...remoteIconLogsByCharId.values()].map(async logs => {
    try {
      const localIconPath = await ensureLocalCharIcon(logs[0].charId, logs[0].icon)
      if (localIconPath) {
        for (const log of logs) log.iconPath = localIconPath
        return
      }
    } catch {}
    for (const log of logs) log.icon = ""
  }))

  const localFace = avatarUserId ? await ensureLocalQqFace(avatarUserId) : ""

  const view = {
    elem: "sr",
    uid: roleId,
    exportTime,
    face: {
      banner: "skin/common/bg/bg-sr.webp",
      face: localFace || getQqAvatarUrl(avatarUserId),
      qFace: localFace || getQqAvatarUrl(avatarUserId),
      name: String(account.nickname || "未命名"),
    },
    gacha: {
      stat: {
        totalNum: totalPulls,
        sixNum: totalSix,
        charNum: showChar ? charList.length : null,
        weaponNum: showWeapon ? weaponList.length : null,
      },
      pools: poolsView,
    },
  }

  const text = buildTextSummary({ account, pools, exportTime, totalPulls, poolKind: kind })

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

  const { filePath, legacyPath } = gachaExportFilePaths(roleId)
  let actualPath = filePath
  if (!fsSync.existsSync(actualPath)) actualPath = legacyPath
  if (!fsSync.existsSync(actualPath)) {
    return { ok: false, message: "[终末地] 未找到抽卡记录，请先使用：#zmd更新抽卡记录" }
  }

  // Best-effort: migrate legacy cache so exports live under bot data dir.
  if (actualPath === legacyPath && !fsSync.existsSync(filePath)) {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true })
      await fs.copyFile(legacyPath, filePath)
      actualPath = filePath
    } catch {}
  }

  return {
    ok: true,
    roleId,
    filePath: actualPath,
    fileName: `zmd_gacha_${roleId}.json`,
  }
}

export async function deleteGachaLogsForUser(userId) {
  const { ok, message, roleId } = await requireActiveRoleId(userId)
  if (!ok) return { ok: false, message }

  const { filePath, legacyPath } = gachaExportFilePaths(roleId)
  let actualPath = filePath
  if (!fsSync.existsSync(actualPath) && fsSync.existsSync(legacyPath)) actualPath = legacyPath
  if (!fsSync.existsSync(actualPath)) {
    return { ok: false, message: "[终末地] 未找到抽卡记录，无需删除" }
  }

  await fs.mkdir(path.dirname(actualPath), { recursive: true })
  const backupPath = `${actualPath}.bak`
  await fs.copyFile(actualPath, backupPath)
  await fs.unlink(actualPath)

  return { ok: true, roleId, backupPath }
}

export async function importGachaLogsFromJsonForUser(userId, rawJson) {
  const { account, ok, message, roleId } = await requireActiveRoleId(userId)
  if (!ok) return { ok: false, message }

  const incoming = safeJsonParse(String(rawJson || ""), null)
  if (!incoming) return { ok: false, message: "[终末地] JSON 解析失败：内容不是合法 JSON" }

  const normalized = normalizeImportedData(incoming)
  const importChar = filterPullRecords(normalized.charList)
  const importWeapon = filterPullRecords(normalized.weaponList)
  if (!importChar.length && !importWeapon.length) return { ok: false, message: "[终末地] JSON 中没有可导入的抽卡记录" }

  if (running.has(roleId)) return { ok: false, message: "[终末地] 抽卡记录正在刷新/导入中，请稍后再试（请勿重复触发）" }
  running.add(roleId)

  try {
    const existing = await loadGachaExport(roleId)
    const existingChar = Array.isArray(existing?.charList) ? existing.charList : []
    const existingWeapon = Array.isArray(existing?.weaponList) ? existing.weaponList : []

    const { merged: mergedChar, newCount: newCharCount } = mergeRecords(existingChar, importChar)
    const { merged: mergedWeapon, newCount: newWeaponCount } = mergeRecords(existingWeapon, importWeapon)
    const poolMetadata = await resolveCharacterPoolMetadata(mergedChar, {
      existingMetadata: existing?.poolMetadata,
      serverId: String(account?.serverId || "1").trim() || "1",
    })

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
      poolMetadata,
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
  } catch (err) {
    return { ok: false, message: `[终末地] 导入抽卡记录失败：${err?.message || err}` }
  } finally {
    running.delete(roleId)
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

    const charMaxSeqIdByPoolType = new Map(CHARACTER_POOL_TYPES.map(poolType => [poolType, getMaxSeqIdBySourcePoolType(existingChar, poolType)]))
    const weaponMaxSeqId = getMaxSeqId(existingWeapon)

    const fetchedChar = []
    for (const poolType of CHARACTER_POOL_TYPES) {
      const list = await fetchEfRecords(EF_CHAR_URL, {
        u8Token,
        serverId,
        extraParams: { pool_type: poolType },
        existingMaxSeqId: charMaxSeqIdByPoolType.get(poolType) || 0,
      })
      fetchedChar.push(...markRecordsWithSourcePoolType(list, poolType))
    }

    const fetchedWeapon = await fetchEfRecords(EF_WEAPON_URL, {
      u8Token,
      serverId,
      existingMaxSeqId: weaponMaxSeqId,
    })

    const { merged: mergedChar, newCount: newCharCount } = mergeRecords(existingChar, fetchedChar)
    const { merged: mergedWeapon, newCount: newWeaponCount } = mergeRecords(existingWeapon, fetchedWeapon)
    const poolMetadata = await resolveCharacterPoolMetadata(mergedChar, {
      existingMetadata: existing?.poolMetadata,
      serverId,
    })

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
      poolMetadata,
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

export const __gachalogTest = Object.freeze({
  analyzeFeaturedGuarantee,
  assertRecordPageProgress,
  buildPoolsByPoolId,
  combineGachaLogs,
  filterPullRecords,
  getItemKey,
  mapContentPoolMetadata,
  mergeFullCharacterRecords,
  mergeRecords,
  pickCharAvatarUrl,
})
