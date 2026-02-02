import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const KEY_ALIAS_MAP = "Yz:EndUID:AliasMap"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TEMPLATE_PATH = path.join(__dirname, "alias_template.json")

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

let templateCachePromise
async function loadTemplate() {
  if (!templateCachePromise) {
    templateCachePromise = fs
      .readFile(TEMPLATE_PATH, "utf-8")
      .then(t => safeJsonParse(t, {}))
      .catch(() => ({}))
  }
  const data = await templateCachePromise
  return data && typeof data === "object" ? data : {}
}

function normalize(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
}

function uniqStable(items) {
  const seen = new Set()
  const out = []
  for (const item of items || []) {
    const s = String(item || "").trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

export function getAliasList(entry) {
  const aliases = entry?.alias
  if (!Array.isArray(aliases)) return []
  return uniqStable(aliases)
}

export function setAliasList(entry, aliases) {
  if (!entry || typeof entry !== "object") return
  entry.alias = uniqStable(aliases)
}

function mergeAliasMaps(template, stored) {
  const map1 = template && typeof template === "object" ? template : {}
  const map2 = stored && typeof stored === "object" ? stored : {}

  const allKeys = new Set([...Object.keys(map1), ...Object.keys(map2)])
  const result = {}

  for (const key of allKeys) {
    const entry1 = map1[key]
    const entry2 = map2[key]
    let entry = {}
    if (entry2 && typeof entry2 === "object") entry = { ...entry2 }
    else if (entry1 && typeof entry1 === "object") entry = { ...entry1 }

    const mergedAlias = uniqStable([...(getAliasList(entry1) || []), ...(getAliasList(entry2) || [])])
    entry.alias = mergedAlias
    result[key] = entry
  }

  return result
}

export async function loadAliasMap() {
  const template = await loadTemplate()
  let stored = null
  try {
    const raw = await redis.get(KEY_ALIAS_MAP)
    stored = raw ? safeJsonParse(raw, null) : null
  } catch {}

  const merged = mergeAliasMaps(template, stored || {})
  if (!stored) {
    try {
      await redis.set(KEY_ALIAS_MAP, JSON.stringify(merged))
    } catch {}
  }
  return merged
}

export async function saveAliasMap(map) {
  const data = map && typeof map === "object" ? map : {}
  try {
    await redis.set(KEY_ALIAS_MAP, JSON.stringify(data))
  } catch {}
}

export async function updateAliasMapFromChars(chars) {
  const list = Array.isArray(chars) ? chars : []
  if (!list.length) return

  const data = await loadAliasMap()
  let changed = false

  for (const char of list) {
    const charData = char?.charData || {}
    const charId = String(charData.id || char?.id || "").trim()
    const charName = String(charData.name || "").trim()
    if (!charName) continue

    const avatarSqUrl = String(charData.avatarSqUrl || "").trim()
    const avatarRtUrl = String(charData.avatarRtUrl || "").trim()
    const illustrationUrl = String(charData.illustrationUrl || "").trim()

    let key = charName
    let entry = data[key]

    if (!entry || typeof entry !== "object") {
      let migratedKey = ""
      if (charId) {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && String(v.id || "").trim() === charId) {
            migratedKey = k
            entry = v
            break
          }
        }
      }

      if (migratedKey && migratedKey !== key) {
        data[key] = entry
        delete data[migratedKey]
        changed = true
      } else if (!entry || typeof entry !== "object") {
        entry = {}
        data[key] = entry
        changed = true
      }
    }

    const aliasList = getAliasList(entry)
    if (charName && !aliasList.includes(charName)) {
      aliasList.push(charName)
      setAliasList(entry, aliasList)
      changed = true
    }

    if (entry.name !== charName) {
      entry.name = charName
      changed = true
    }
    if (charId && entry.id !== charId) {
      entry.id = charId
      changed = true
    }
    if (avatarSqUrl && entry.avatarSqUrl !== avatarSqUrl) {
      entry.avatarSqUrl = avatarSqUrl
      changed = true
    }
    if (avatarRtUrl && entry.avatarRtUrl !== avatarRtUrl) {
      entry.avatarRtUrl = avatarRtUrl
      changed = true
    }
    if (illustrationUrl && entry.illustrationUrl !== illustrationUrl) {
      entry.illustrationUrl = illustrationUrl
      changed = true
    }

    const preferredUrl = avatarRtUrl || illustrationUrl || avatarSqUrl
    if (preferredUrl && entry.url !== preferredUrl) {
      entry.url = preferredUrl
      changed = true
    }
  }

  if (changed) await saveAliasMap(data)
}

export async function resolveAliasEntry(value) {
  const raw = String(value || "").trim()
  if (!raw) return null

  const data = await loadAliasMap()
  if (data[raw] && typeof data[raw] === "object") return { key: raw, entry: data[raw] }

  const n = normalize(raw)

  for (const [key, entry] of Object.entries(data)) {
    const e = entry && typeof entry === "object" ? entry : {}
    const aliases = [key, ...getAliasList(e)]
    const name = String(e.name || "").trim()
    if (name) aliases.push(name)
    const id = String(e.id || "").trim()
    if (id) aliases.push(id)
    if (aliases.some(a => normalize(a) === n)) return { key, entry: e }
  }

  for (const [key, entry] of Object.entries(data)) {
    const e = entry && typeof entry === "object" ? entry : {}
    const aliases = [key, ...getAliasList(e)]
    const name = String(e.name || "").trim()
    if (name) aliases.push(name)
    const id = String(e.id || "").trim()
    if (id) aliases.push(id)
    for (const alias of aliases) {
      const an = normalize(alias)
      if (!an) continue
      if (n.includes(an) || an.includes(n)) return { key, entry: e }
    }
  }

  return null
}

export async function addAlias(charQuery, newAlias) {
  const alias = String(newAlias || "").trim()
  if (!alias) return { ok: false, message: "别名不能为空" }

  const resolved = await resolveAliasEntry(charQuery)
  if (!resolved) return { ok: false, message: "未找到对应角色，请先 #zmd刷新 更新数据" }

  const { key, entry } = resolved
  const data = await loadAliasMap()
  const target = data[key]
  if (!target || typeof target !== "object") return { ok: false, message: "角色数据异常，请先 #zmd刷新" }

  const displayName = String(target.name || key).trim() || key
  const entryId = String(target.id || "").trim()

  const existing = await resolveAliasEntry(alias)
  if (existing && existing.key !== key) return { ok: false, message: `别名「${alias}」已被「${existing.key}」占用` }

  const aliases = getAliasList(target)
  if (aliases.includes(alias) || alias === displayName || alias === key || (entryId && alias === entryId)) {
    return { ok: false, message: `别名「${alias}」已存在` }
  }

  aliases.push(alias)
  setAliasList(target, aliases)
  await saveAliasMap(data)
  return { ok: true, message: `已为「${displayName}」添加别名「${alias}」` }
}

export async function deleteAlias(charQuery, aliasToDelete) {
  const alias = String(aliasToDelete || "").trim()
  if (!alias) return { ok: false, message: "别名不能为空" }

  const resolved = await resolveAliasEntry(charQuery)
  if (!resolved) return { ok: false, message: "未找到对应角色" }

  const { key, entry } = resolved
  const data = await loadAliasMap()
  const target = data[key]
  if (!target || typeof target !== "object") return { ok: false, message: "角色数据异常" }

  const displayName = String(target.name || key).trim() || key
  const entryId = String(target.id || "").trim()

  if (alias === displayName || alias === key || (entryId && alias === entryId)) {
    return { ok: false, message: `别名「${alias}」不可删除` }
  }

  const aliases = getAliasList(target)
  if (!aliases.includes(alias)) return { ok: false, message: `别名「${alias}」不存在` }

  setAliasList(target, aliases.filter(a => a !== alias))
  await saveAliasMap(data)
  return { ok: true, message: `已为「${displayName}」删除别名「${alias}」` }
}
