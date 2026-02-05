/**
 * 武器别名解析器。
 *
 * 使用内置 map_weapon.json 将常见别名/昵称映射为规范武器名。
 * 由于 JSON 不支持注释，说明请写在本文件中。
 */
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function normalize(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const WEAPON_MAP_PATH = path.join(__dirname, "map_weapon.json")

let weaponMapCachePromise
async function loadWeaponMap() {
  if (!weaponMapCachePromise) {
    weaponMapCachePromise = fs
      .readFile(WEAPON_MAP_PATH, "utf8")
      .then(t => safeJsonParse(t, {}))
      .catch(() => ({}))
  }
  const data = await weaponMapCachePromise
  return data && typeof data === "object" ? data : {}
}

export async function resolveWeaponAlias(value) {
  const raw = String(value || "").trim()
  if (!raw) return ""

  const data = await loadWeaponMap()
  if (!data || typeof data !== "object") return ""

  if (data[raw]) return raw

  const n = normalize(raw)

  for (const [key, entryRaw] of Object.entries(data)) {
    const entry = entryRaw && typeof entryRaw === "object" ? entryRaw : {}
    const aliases = Array.isArray(entry.alias) ? entry.alias : []
    for (const alias of [key, ...aliases]) {
      if (normalize(alias) === n) return key
    }
  }

  for (const [key, entryRaw] of Object.entries(data)) {
    const entry = entryRaw && typeof entryRaw === "object" ? entryRaw : {}
    const aliases = Array.isArray(entry.alias) ? entry.alias : []
    for (const alias of [key, ...aliases]) {
      const an = normalize(alias)
      if (!an) continue
      if (n.includes(an) || an.includes(n)) return key
    }
  }

  return ""
}
