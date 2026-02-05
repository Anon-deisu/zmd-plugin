import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import fetch from "node-fetch"

import { PLUGIN_DATA_DIR, PLUGIN_RESOURCES_DIR } from "./pluginMeta.js"
import { ensureListData } from "./wiki/fetch.js"

const GACHA_DATA_DIR = path.join(PLUGIN_DATA_DIR, "gachalog")
const WEAPON_ICON_DIR = path.join(PLUGIN_RESOURCES_DIR, "endfield", "itemiconbig")

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function isPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return false
  // 89 50 4E 47 0D 0A 1A 0A
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
}

function sanitizeFileBase(name) {
  // Keep it predictable for filesystem + avoid path traversal.
  return String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function buildWeaponNameToIconUrlMap(listData) {
  const out = new Map()
  const groups = listData?.weapons && typeof listData.weapons === "object" ? listData.weapons : {}
  for (const entries of Object.values(groups)) {
    for (const item of Array.isArray(entries) ? entries : []) {
      const name = String(item?.name || "").trim()
      const url = String(item?.icon_url || "").trim()
      if (!name || !url) continue
      if (!out.has(name)) out.set(name, url)
    }
  }
  return out
}

async function loadGachaExport(roleId) {
  const rid = String(roleId || "").trim()
  if (!rid) return null
  const fp = path.join(GACHA_DATA_DIR, `${rid}.json`)
  try {
    const text = await fs.readFile(fp, "utf8")
    const data = safeJsonParse(text, null)
    return data && typeof data === "object" ? data : null
  } catch {
    return null
  }
}

function collectWeaponsFromExport(exportData) {
  const weaponList = Array.isArray(exportData?.weaponList) ? exportData.weaponList : []
  const wanted = new Map()
  for (const item of weaponList) {
    const weaponId = String(item?.weaponId || "").trim()
    const weaponName = String(item?.weaponName || "").trim()
    if (!weaponId || !weaponName) continue
    if (!wanted.has(weaponId)) wanted.set(weaponId, weaponName)
  }
  return wanted
}

export function listLocalGachaRoleIds() {
  try {
    if (!fsSync.existsSync(GACHA_DATA_DIR)) return []
    const files = fsSync.readdirSync(GACHA_DATA_DIR)
    return files
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(/\.json$/i, "").trim())
      .filter(id => /^\d{5,}$/.test(id))
  } catch {
    return []
  }
}

async function downloadPng(url) {
  const u = String(url || "").trim()
  if (!u) return null

  const resp = await fetch(u, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://wiki.biligame.com/zmd/",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  })
  if (!resp.ok) return null
  const buf = Buffer.from(await resp.arrayBuffer())
  if (!isPng(buf)) return null
  return buf
}

async function runPool(items, worker, { concurrency = 3 } = {}) {
  const list = Array.isArray(items) ? items : []
  const n = Math.max(1, Math.min(8, Number(concurrency) || 3))
  let idx = 0

  const runners = Array.from({ length: n }).map(async () => {
    while (idx < list.length) {
      const cur = list[idx]
      idx += 1
      await worker(cur)
    }
  })
  await Promise.all(runners)
}

/**
 * Download missing weapon icons from biligame wiki list cache.
 *
 * Output:
 * - resources/endfield/itemiconbig/<weaponId>.png
 */
export async function updateWeaponIconCacheFromWiki({ roleIds = [], force = false, maxDownloads = 200 } = {}) {
  const ids = Array.isArray(roleIds) ? roleIds.map(x => String(x || "").trim()).filter(Boolean) : []
  if (!ids.length) return { ok: false, message: "missing_role_ids" }

  const listData = await ensureListData()
  if (!listData) return { ok: false, message: "wiki_list_unavailable" }

  const iconUrlByName = buildWeaponNameToIconUrlMap(listData)
  if (!iconUrlByName.size) return { ok: false, message: "wiki_weapon_list_empty" }

  await fs.mkdir(WEAPON_ICON_DIR, { recursive: true })

  const wanted = new Map()
  let missingExport = 0
  for (const roleId of ids) {
    const exportData = await loadGachaExport(roleId)
    if (!exportData) {
      missingExport += 1
      continue
    }
    for (const [weaponId, weaponName] of collectWeaponsFromExport(exportData).entries()) {
      if (!wanted.has(weaponId)) wanted.set(weaponId, weaponName)
    }
  }

  const jobs = []
  const notFound = new Set()
  let existed = 0

  for (const [weaponIdRaw, weaponName] of wanted.entries()) {
    const weaponId = sanitizeFileBase(weaponIdRaw)
    if (!weaponId) continue

    const fp = path.join(WEAPON_ICON_DIR, `${weaponId}.png`)
    if (!force && fsSync.existsSync(fp)) {
      existed += 1
      continue
    }

    const url = iconUrlByName.get(weaponName) || ""
    if (!url) {
      notFound.add(weaponName)
      continue
    }

    jobs.push({ fp, url, weaponId, weaponName })
  }

  const limitedJobs = jobs.slice(0, Math.max(0, Number(maxDownloads) || 0))

  let downloaded = 0
  const failed = []

  await runPool(
    limitedJobs,
    async job => {
      try {
        const buf = await downloadPng(job.url)
        if (!buf) throw new Error("download_failed")
        await fs.writeFile(job.fp, buf)
        downloaded += 1
        // polite delay to reduce rate limit risk
        await sleep(50)
      } catch {
        failed.push(job.weaponName)
      }
    },
    { concurrency: 3 },
  )

  return {
    ok: true,
    roleIds: ids,
    missingExport,
    wanted: wanted.size,
    existed,
    planned: jobs.length,
    downloaded,
    skippedByLimit: Math.max(0, jobs.length - limitedJobs.length),
    notFound: Array.from(notFound).slice(0, 50),
    failed: failed.slice(0, 50),
    dir: WEAPON_ICON_DIR,
  }
}
