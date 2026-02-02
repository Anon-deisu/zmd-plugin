import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import fetch from "node-fetch"

import { getActiveAccount } from "./store.js"

const PLUGIN_NAME = "enduid-yunzai"
const DATA_DIR = path.join(process.cwd(), "plugins", PLUGIN_NAME, "data")
const GACHA_EXPORT_DIR = path.join(DATA_DIR, "gachalog")

const RES_DIR = path.join(process.cwd(), "plugins", PLUGIN_NAME, "resources")
const ENDFIELD_RES_DIR = path.join(RES_DIR, "endfield")

const WEAPON_ICON_REL_DIR = "endfield/itemiconbig"
const CHAR_ICON_REL_DIR = "endfield/charicon"

function safeInt(value, def = 0) {
  const n = Number.parseInt(`${value ?? ""}`, 10)
  return Number.isFinite(n) ? n : def
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function normalizeBaseUrl(baseUrl) {
  const s = String(baseUrl || "").trim()
  if (!s) return ""
  return s.replace(/\/+$/, "")
}

function buildBaseVariants(baseUrl) {
  const b = normalizeBaseUrl(baseUrl)
  if (!b) return []

  const candidates = [
    b,
    b.replace(/\/resource$/i, ""),
    b.replace(/\/BeyondUID\/resource$/i, ""),
    b.replace(/\/BeyondUID$/i, ""),
  ]

  const out = []
  const seen = new Set()
  for (const c of candidates) {
    const v = String(c || "").trim()
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

function buildIconUrlCandidates(baseUrl, { type, id }) {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) return []

  const isResourceRoot = /\/resource$/i.test(base) || /\/BeyondUID\/resource$/i.test(base)
  const safeId = encodeURIComponent(String(id || "").trim())
  if (!safeId) return []

  const baseVariants = buildBaseVariants(base)

  let relPaths = []
  if (type === "weapon") {
    const direct = `itemiconbig/${safeId}.png`
    const resource = `resource/itemiconbig/${safeId}.png`
    const beyond = `BeyondUID/resource/itemiconbig/${safeId}.png`
    relPaths = isResourceRoot ? [direct, resource, beyond] : [resource, beyond, direct]
  } else {
    const direct = `charicon/icon_${safeId}.png`
    const resource = `resource/charicon/icon_${safeId}.png`
    const beyond = `BeyondUID/resource/charicon/icon_${safeId}.png`
    relPaths = isResourceRoot ? [direct, resource, beyond] : [resource, beyond, direct]
  }

  function shouldSkipJoin(b, rel) {
    const bb = String(b).toLowerCase()
    const rr = String(rel).toLowerCase()
    if (bb.endsWith("/resource") && rr.startsWith("resource/")) return true
    if (bb.endsWith("/beyonduid") && rr.startsWith("beyonduid/")) return true
    if (bb.endsWith("/beyonduid/resource") && rr.startsWith("beyonduid/resource/")) return true
    if (bb.endsWith("/beyonduid/resource") && rr.startsWith("resource/")) return true
    return false
  }

  const urls = []
  const seen = new Set()
  for (const b of baseVariants) {
    for (const rel of relPaths) {
      if (shouldSkipJoin(b, rel)) continue
      const u = `${b}/${rel}`
      if (seen.has(u)) continue
      seen.add(u)
      urls.push(u)
    }
  }
  return urls
}

function isSubPath(parent, child) {
  const rel = path.relative(parent, child)
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
}

async function readGachaExportForUser(userId) {
  const { account } = await getActiveAccount(userId)
  if (!account?.cred || !account?.uid) return { ok: false, message: "[终末地] 未绑定账号，请先私聊 #zmd登录 / #zmd绑定" }

  const roleId = String(account.uid)
  const fp = path.join(GACHA_EXPORT_DIR, `${roleId}.json`)
  if (!fs.existsSync(fp)) return { ok: false, message: "[终末地] 未找到抽卡记录，请先使用：#zmd更新抽卡记录" }

  let exportData = null
  try {
    exportData = safeJsonParse(await fsp.readFile(fp, "utf8"), null)
  } catch {}
  if (!exportData || typeof exportData !== "object") return { ok: false, message: "[终末地] 抽卡记录文件解析失败，请先重新 #zmd更新抽卡记录" }

  if (!Array.isArray(exportData.charList)) exportData.charList = []
  if (!Array.isArray(exportData.weaponList)) exportData.weaponList = []
  return { ok: true, account, roleId, exportData }
}

async function downloadToFile(url, filePath, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
  try {
    const headers = { "User-Agent": "Mozilla/5.0" }
    if (url.startsWith("https://raw.githubusercontent.com/")) headers.Referer = "https://github.com/"

    const resp = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers,
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`)
    const buf = Buffer.from(await resp.arrayBuffer())
    await fsp.writeFile(filePath, buf)
  } finally {
    clearTimeout(timer)
  }
}

async function downloadToFileWithFallback(urls, filePath, { timeoutMs = 20000 } = {}) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : []
  if (!list.length) throw new Error("缺少下载地址")

  let lastErr = null
  for (const url of list) {
    try {
      await downloadToFile(url, filePath, { timeoutMs })
      return url
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || new Error("下载失败")
}

function collectWeaponIds(exportData, { minRarity = 5 } = {}) {
  const ids = new Set()
  for (const w of exportData?.weaponList || []) {
    if (safeInt(w?.rarity) < minRarity) continue
    const id = String(w?.weaponId || "").trim()
    if (id) ids.add(id)
  }
  return Array.from(ids)
}

function collectCharIds(exportData, { minRarity = 6 } = {}) {
  const ids = new Set()
  for (const c of exportData?.charList || []) {
    if (safeInt(c?.rarity) < minRarity) continue
    const id = String(c?.charId || "").trim()
    if (id) ids.add(id)
  }
  return Array.from(ids)
}

async function runPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : []
  const n = Math.max(1, Math.min(20, Number(concurrency) || 1))
  let cursor = 0
  let ok = 0
  let fail = 0
  const fails = []

  const workers = Array.from({ length: n }, async () => {
    while (cursor < list.length) {
      const idx = cursor++
      const item = list[idx]
      try {
        const did = await worker(item)
        if (did) ok++
      } catch (err) {
        fail++
        fails.push({ item, err: err?.message || String(err) })
      }
    }
  })

  await Promise.all(workers)
  return { ok, fail, fails }
}

export async function downloadEndfieldIconsForUser(
  userId,
  {
    baseUrl,
    force = false,
    timeoutMs = 20000,
    concurrency = 6,
    minWeaponRarity = 5,
    downloadChar = true,
    minCharRarity = 6,
  } = {},
) {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) return { ok: false, message: "缺少资源镜像地址，请先设置 resource.baseUrl 或在命令中提供 URL" }

  const exportRes = await readGachaExportForUser(userId)
  if (!exportRes.ok) return exportRes

  const weaponIds = collectWeaponIds(exportRes.exportData, { minRarity: minWeaponRarity })
  const charIds = downloadChar ? collectCharIds(exportRes.exportData, { minRarity: minCharRarity }) : []

  const weaponDir = path.join(RES_DIR, WEAPON_ICON_REL_DIR)
  const charDir = path.join(RES_DIR, CHAR_ICON_REL_DIR)
  if (!fs.existsSync(ENDFIELD_RES_DIR)) await fsp.mkdir(ENDFIELD_RES_DIR, { recursive: true })
  if (weaponIds.length && !fs.existsSync(weaponDir)) await fsp.mkdir(weaponDir, { recursive: true })
  if (charIds.length && !fs.existsSync(charDir)) await fsp.mkdir(charDir, { recursive: true })

  const weaponTasks = weaponIds.map(id => ({ type: "weapon", id }))
  const charTasks = charIds.map(id => ({ type: "char", id }))
  const tasks = [...weaponTasks, ...charTasks]

  const poolRes = await runPool(tasks, concurrency, async task => {
    const id = String(task?.id || "").trim()
    if (!id) return false

    let rel = ""
    if (task.type === "weapon") {
      rel = `${WEAPON_ICON_REL_DIR}/${id}.png`
    } else {
      rel = `${CHAR_ICON_REL_DIR}/icon_${id}.png`
    }

    const dest = path.normalize(path.join(RES_DIR, rel))
    if (!isSubPath(RES_DIR, dest)) return false

    if (!force && fs.existsSync(dest)) return false

    const dir = path.dirname(dest)
    if (!isSubPath(RES_DIR, dir)) return false
    if (!fs.existsSync(dir)) await fsp.mkdir(dir, { recursive: true })

    const urls = buildIconUrlCandidates(base, { type: task.type, id })
    await downloadToFileWithFallback(urls, dest, { timeoutMs })
    return true
  })

  return {
    ok: true,
    baseUrl: base,
    roleId: exportRes.roleId,
    total: tasks.length,
    downloaded: poolRes.ok,
    failed: poolRes.fail,
    fails: poolRes.fails.slice(0, 8),
  }
}
