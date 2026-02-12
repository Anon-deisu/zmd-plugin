/**
 * Third-party Friend API client.
 *
 * This is NOT an official Skland API. It's an internal HTTP service that exposes
 * `/friend/*` endpoints (see reference samples under repo root).
 *
 * Used to补全「面板」中的数值拆解（HP/ATK/DEF/暴击等）。
 */
import fetch from "node-fetch"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import cfg from "./config.js"
import { LEGACY_PLUGIN_DATA_DIR, PLUGIN_DATA_DIR } from "./pluginMeta.js"

const FILE_DATA_DIR = path.join(PLUGIN_DATA_DIR, "friendApi")
const FILE_DATA_DIR_LEGACY = path.join(LEGACY_PLUGIN_DATA_DIR, "friendApi")
const FILE_ROLEID_DIR = path.join(FILE_DATA_DIR, "roleId")
const FILE_DETAIL_DIR = path.join(FILE_DATA_DIR, "detail")
const FILE_COMPUTED_DIR = path.join(FILE_DATA_DIR, "computed")

const FILE_ROLEID_DIR_LEGACY = path.join(FILE_DATA_DIR_LEGACY, "roleId")
const FILE_DETAIL_DIR_LEGACY = path.join(FILE_DATA_DIR_LEGACY, "detail")
const FILE_COMPUTED_DIR_LEGACY = path.join(FILE_DATA_DIR_LEGACY, "computed")

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function sanitizeFilename(name) {
  return String(name || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
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

function roleIdCacheFilePaths(uid) {
  const u = sanitizeFilename(uid)
  const name = `${u}.json`
  return {
    filePath: path.join(FILE_ROLEID_DIR, name),
    legacyPath: path.join(FILE_ROLEID_DIR_LEGACY, name),
  }
}

function detailCacheFilePaths(roleId) {
  const r = sanitizeFilename(roleId)
  const name = `${r}.json`
  return {
    filePath: path.join(FILE_DETAIL_DIR, name),
    legacyPath: path.join(FILE_DETAIL_DIR_LEGACY, name),
  }
}

function computedCacheFilePaths(roleId, templateId, { advanced } = {}) {
  const r = sanitizeFilename(roleId)
  const t = sanitizeFilename(templateId)
  const a = advanced ? 1 : 0
  const name = `${r}_${t}_${a}.json`
  return {
    filePath: path.join(FILE_COMPUTED_DIR, name),
    legacyPath: path.join(FILE_COMPUTED_DIR_LEGACY, name),
  }
}

function normalizeBaseUrl(raw) {
  const u = String(raw || "").trim()
  if (!u) return ""
  return u.replace(/\/+$/, "")
}

function normalizeSource(raw) {
  const s = String(raw || "").trim().toLowerCase()
  if (!s || s === "auto" || s === "default" || s === "自动" || s === "默认") return "auto"
  if (s === "local" || s === "native" || s.includes("本地")) return "local"
  if (s === "unified" || s === "backend" || s === "remote" || s.includes("统一") || s.includes("后端")) return "unified"
  return "auto"
}

function pickSecret(value) {
  const s = String(value || "").trim()
  return s
}

export function getFriendApiRuntimeConfig() {
  const enabled = cfg.friendApi?.enable !== false

  const localBaseUrl = normalizeBaseUrl(cfg.friendApi?.baseUrl)
  const unifiedBaseUrl = normalizeBaseUrl(cfg.friendApi?.unifiedBaseUrl || cfg.friendApi?.unified_base_url)

  const sourceSetting = normalizeSource(cfg.friendApi?.source)
  let mode = sourceSetting
  if (mode === "auto") mode = localBaseUrl ? "local" : "unified"

  const baseUrl = mode === "local" ? localBaseUrl : unifiedBaseUrl

  const localBearer = pickSecret(cfg.friendApi?.bearer || cfg.friendApi?.bearerToken || cfg.friendApi?.bearerKey)
  const unifiedBearer = pickSecret(
    cfg.friendApi?.unifiedBearer ||
      cfg.friendApi?.unified_bearer ||
      cfg.friendApi?.unifiedBearerToken ||
      cfg.friendApi?.unifiedBearerKey,
  )
  const bearer = mode === "unified" ? unifiedBearer || localBearer : localBearer

  // Optional compatibility: some unified deployments use X-API-Key.
  const localApiKey = pickSecret(cfg.friendApi?.apiKey || cfg.friendApi?.api_key)
  const unifiedApiKey = pickSecret(cfg.friendApi?.unifiedApiKey || cfg.friendApi?.unified_api_key)
  const apiKey = mode === "unified" ? unifiedApiKey || localApiKey : localApiKey

  return {
    enabled,
    sourceSetting,
    mode,
    baseUrl,
    localBaseUrl,
    unifiedBaseUrl,
    bearer,
    apiKey,
  }
}

function buildFriendApiUrl({ baseUrl, mode }, pathname) {
  const base = normalizeBaseUrl(baseUrl)
  const p = String(pathname || "").trim()
  if (!base || !p) return ""

  if (mode !== "unified") return `${base}${p}`

  const endsWithApi = /\/api$/i.test(base)
  if (p === "/health") {
    // Unified backend follows: /api/friend/health
    return endsWithApi ? `${base}/friend/health` : `${base}/api/friend/health`
  }
  if (p.startsWith("/friend/")) {
    return endsWithApi ? `${base}${p}` : `${base}/api${p}`
  }
  const tail = p.startsWith("/") ? p : `/${p}`
  return endsWithApi ? `${base}${tail}` : `${base}/api${tail}`
}

function toNumber(value, def = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : def
}

function toInt(value, def = 0) {
  const n = toNumber(value, Number.NaN)
  return Number.isFinite(n) ? Math.round(n) : def
}

function panelCacheKey(roleId, templateId, { advanced } = {}) {
  const r = String(roleId || "").trim()
  const t = String(templateId || "").trim()
  const a = advanced ? 1 : 0
  return `Yz:EndUID:FriendPanel:${r}:${t}:${a}`
}

function computedCacheKey(roleId, templateId, { advanced } = {}) {
  const r = String(roleId || "").trim()
  const t = String(templateId || "").trim()
  const a = advanced ? 1 : 0
  return `Yz:EndUID:FriendCharComputed:${r}:${t}:${a}`
}

function staleComputedCacheKey(roleId, templateId, { advanced } = {}) {
  const r = String(roleId || "").trim()
  const t = String(templateId || "").trim()
  const a = advanced ? 1 : 0
  return `Yz:EndUID:FriendCharComputedStale:${r}:${t}:${a}`
}

function buildCharMeta(data) {
  const d = data && typeof data === "object" ? data : {}
  const char = d.char && typeof d.char === "object" ? d.char : {}
  const template = char.template && typeof char.template === "object" ? char.template : {}
  const profile = char.char_profile && typeof char.char_profile === "object" ? char.char_profile : {}

  const templateId = String(char.template_id || template.id || profile.template_id || "")
    .trim()
    .toLowerCase()
  const name = String(template.name || profile.name || "").trim()
  const nameCn = String(template.name_cn || "").trim()
  return { templateId, name, nameCn }
}

function hasCjk(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ""))
}

function pickPreferredName({ nameCn = "", name = "", rawName = "" } = {}) {
  const cn = String(nameCn || "").trim()
  const en = String(name || "").trim()
  const raw = String(rawName || "").trim()
  if (cn && hasCjk(cn)) return cn
  return en || cn || raw
}

function buildWeaponTerms(data) {
  const d = data && typeof data === "object" ? data : {}
  const char = d.char && typeof d.char === "object" ? d.char : {}
  const weapon = char.weapon && typeof char.weapon === "object" ? char.weapon : {}
  const gems = Array.isArray(char.gems) ? char.gems : []

  const attachId = String(weapon.attach_gem_id || "").trim()
  let gem = null
  if (attachId && attachId !== "0") {
    gem = gems.find(g => String(g?.gem_id || "").trim() === attachId) || null
  }
  if (!gem && gems.length) gem = gems[0]

  const terms = Array.isArray(gem?.terms) ? gem.terms : []

  const pickName = t => {
    const term = t?.term && typeof t.term === "object" ? t.term : {}
    return pickPreferredName({ nameCn: term.name_cn, name: term.name, rawName: term.raw_name })
  }

  const out = []
  for (const t of terms) {
    const name = pickName(t)
    if (!name) continue
    const cost = toInt(t?.cost, 0)
    // Show cost when it is meaningful; keep it ASCII for rendering stability.
    out.push(cost > 1 ? `${name} x${cost}` : name)
  }
  return out
}

function buildCharView(data) {
  const d = data && typeof data === "object" ? data : {}
  const char = d.char && typeof d.char === "object" ? d.char : {}
  const profile = char.char_profile && typeof char.char_profile === "object" ? char.char_profile : {}

  const level = toInt(char.level, 0)
  const potential = toInt(char.potential_level, 0)
  const mainAttrType = String(profile.main_attr_type || "").trim()

  const weapon = char.weapon && typeof char.weapon === "object" ? char.weapon : {}
  const weaponTpl = weapon.template && typeof weapon.template === "object" ? weapon.template : {}
  const weaponRaw = String(weaponTpl.raw_name || "").trim()
  const weaponName = pickPreferredName({ nameCn: weaponTpl.name_cn, name: weaponTpl.name, rawName: weaponRaw })
  const weaponView = weaponName || weaponRaw || weapon.template_id
    ? {
        rawName: weaponRaw,
        name: weaponName || weaponRaw || "武器",
        level: toInt(weapon.weapon_lv, 0),
        breakthrough: toInt(weapon.breakthrough_lv, 0),
        refine: toInt(weapon.refine_lv, 0),
      }
    : null

  const med = char.equip_medicine && typeof char.equip_medicine === "object" ? char.equip_medicine : {}
  const medRaw = String(med.raw_name || "").trim()
  const medName = pickPreferredName({ nameCn: med.name_cn, name: med.name, rawName: medRaw })
  const tacticalItem = medName || medRaw ? { rawName: medRaw, name: medName || medRaw } : null

  const equipViews = []
  const equips = Array.isArray(char.equip) ? char.equip : []
  for (const eq of equips) {
    const slot = toInt(eq?.slot, -1)
    if (slot < 0) continue
    const tpl = eq?.template && typeof eq.template === "object" ? eq.template : {}
    const raw = String(tpl.raw_name || "").trim()
    const name = pickPreferredName({ nameCn: tpl.name_cn, name: tpl.name, rawName: raw })
    equipViews.push({ slot, rawName: raw, name: name || raw || "装备" })
  }

  const skillViews = []
  const skills = char.skills && typeof char.skills === "object" ? char.skills : {}
  const levelInfo = Array.isArray(skills.level_info) ? skills.level_info : []
  for (const li of levelInfo) {
    const skill = li?.skill && typeof li.skill === "object" ? li.skill : {}
    const id = String(li?.skill_id || skill.id || "").trim()
    const lv = toInt(li?.skill_level, 0)
    const maxLv = toInt(li?.skill_max_level, 0)
    if (!id || lv <= 0) continue
    const name = pickPreferredName({ nameCn: skill.name_cn, name: skill.name, rawName: skill.raw_name || id })
    if (!name) continue
    skillViews.push({ id, name, level: lv, maxLevel: maxLv })
  }

  // Prefer skills that can actually level up; skip empty placeholders.
  const leveled = skillViews.filter(s => s.maxLevel > 1)
  const chosen = leveled.length ? leveled : skillViews
  const uniq = []
  const seen = new Set()
  for (const s of chosen) {
    if (!s?.id || seen.has(s.id)) continue
    seen.add(s.id)
    uniq.push(s)
    if (uniq.length >= 8) break
  }

  return {
    level,
    potential,
    mainAttrType,
    weapon: weaponView,
    equips: equipViews,
    tacticalItem,
    skills: uniq,
  }
}

function roleIdCacheKey(uid) {
  const u = String(uid || "").trim()
  return `Yz:EndUID:FriendRoleIdByUid:${u}`
}

async function readJsonSafe(resp) {
  const text = await resp.text()
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function normalizeApiOkPayload(json) {
  const root = json && typeof json === "object" ? json : null
  if (!root) return { ok: false, message: "friendApi.invalid_json" }

  // Native shape: { ok: true, data: {...} }
  if (root.ok === true) return { ok: true, data: root.data }
  if (root.ok === false) {
    const msg = String(root.message || root.msg || "").trim()
    return { ok: false, message: msg ? `friendApi.api_error:${msg}` : "friendApi.api_error" }
  }

  // Unified backend common shape: { code: 0, data: {...}, message: "..." }
  const codeNum = Number(root.code)
  if (Number.isFinite(codeNum)) {
    if (codeNum === 0) {
      let data = root.data
      // Some backends wrap friend payload again: { code:0, data:{ ok:true, data:{...} } }
      if (data && typeof data === "object" && data.ok === true && Object.prototype.hasOwnProperty.call(data, "data")) data = data.data
      return { ok: true, data }
    }
    const msg = String(root.message || root.msg || "").trim()
    return { ok: false, message: msg ? `friendApi.api_error:${codeNum}:${msg}` : `friendApi.api_error:${codeNum}` }
  }

  // Compatibility: { status: 0, data: {...} }
  const statusNum = Number(root.status)
  if (Number.isFinite(statusNum)) {
    if (statusNum === 0) return { ok: true, data: root.data }
    const msg = String(root.message || root.msg || "").trim()
    return { ok: false, message: msg ? `friendApi.api_error:${statusNum}:${msg}` : `friendApi.api_error:${statusNum}` }
  }

  // Nested payload: { data: { ok:true, data:{...} } }
  if (root.data && typeof root.data === "object") {
    const inner = root.data
    if (inner.ok === true) return { ok: true, data: inner.data }
    const innerCode = Number(inner.code)
    if (Number.isFinite(innerCode) && innerCode === 0) return { ok: true, data: inner.data }
  }

  // Last resort: treat as error.
  return { ok: false, message: "friendApi.api_error" }
}

function sleep(ms) {
  const t = Math.max(0, toInt(ms, 0))
  if (!t) return Promise.resolve()
  return new Promise(resolve => setTimeout(resolve, t))
}

function isRetryableHttpStatus(status) {
  const s = Number(status)
  return s === 429 || s === 500 || s === 502 || s === 503 || s === 504
}

async function requestCharWithFallback({ roleId, templateId, advancedWanted = false } = {}) {
  const r = String(roleId || "").trim()
  const t = String(templateId || "").trim()
  if (!advancedWanted) return await requestFriendApi("/friend/char", { role_id: r, template_id: t })

  // Some deployments only provide the single `/friend/char` endpoint.
  const resAdv = await requestFriendApi("/friend/char_advanced", { role_id: r, template_id: t })
  if (resAdv.ok) return resAdv
  if (resAdv.message === "friendApi.http_404") return await requestFriendApi("/friend/char", { role_id: r, template_id: t })
  return resAdv
}

export async function requestFriendApi(pathname, params, { timeoutMs, retries } = {}) {
  const runtime = getFriendApiRuntimeConfig()
  if (!runtime.enabled || !runtime.baseUrl) return { ok: false, message: "friendApi.baseUrl_not_configured" }

  const headers = {}
  const bearerRaw = String(runtime.bearer || "").trim()
  if (bearerRaw) {
    let v = bearerRaw
    // Accept either raw token, "bearer <token>", or full "Bearer <token>".
    if (/^bearer\s+/i.test(v)) v = `Bearer ${v.replace(/^bearer\s+/i, "").trim()}`
    else if (!/^Bearer\s+/i.test(v)) v = `Bearer ${v}`
    headers.Authorization = v
  }
  const apiKey = String(runtime.apiKey || "").trim()
  if (apiKey) headers["X-API-Key"] = apiKey

  let url
  try {
    const full = buildFriendApiUrl(runtime, pathname)
    url = new URL(full)
  } catch {
    return { ok: false, message: "friendApi.invalid_baseUrl" }
  }

  if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || `${v}` === "") continue
      url.searchParams.set(k, String(v))
    }
  }

  const ms = Math.max(0, toInt(timeoutMs ?? cfg.friendApi?.timeoutMs, 8000))
  const maxRetry = Math.max(0, toInt(retries ?? cfg.friendApi?.retries, 1))
  const baseDelay = Math.max(0, toInt(cfg.friendApi?.retryDelayMs, 200))

  let last = null
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    if (attempt > 0) await sleep(baseDelay * attempt)

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null
    const timer = controller && ms > 0 ? setTimeout(() => controller.abort(), ms) : null

    try {
      const resp = await fetch(url.toString(), {
        method: "GET",
        headers: Object.keys(headers).length ? headers : undefined,
        signal: controller?.signal,
      })
      if (!resp.ok) {
        let msg = `friendApi.http_${resp.status}`
        let raw = null
        try {
          raw = await readJsonSafe(resp)
          const detail = String(raw?.message || raw?.msg || raw?.error || "").trim()
          if (detail) msg = `${msg}:${detail}`
        } catch {}
        last = { ok: false, message: msg, url: url.toString(), raw }
        if (attempt < maxRetry && isRetryableHttpStatus(resp.status)) continue
        return last
      }

      const json = await readJsonSafe(resp)
      if (!json || typeof json !== "object") {
        last = { ok: false, message: "friendApi.invalid_json", url: url.toString() }
        if (attempt < maxRetry) continue
        return last
      }

      const normalized = normalizeApiOkPayload(json)
      if (!normalized.ok) {
        // API-level error is usually deterministic (not retryable).
        last = { ok: false, message: normalized.message || "friendApi.api_error", url: url.toString(), raw: json }
        return last
      }

      return { ok: true, data: normalized.data, url: url.toString(), raw: json }
    } catch (err) {
      const msg = err?.name === "AbortError" ? "friendApi.timeout" : `friendApi.request_failed:${err?.message || err}`
      last = { ok: false, message: msg, url: url.toString() }
      if (attempt < maxRetry) continue
      return last
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return last || { ok: false, message: "friendApi.unknown_error" }
}

/**
 * Resolve the actual Friend API `role_id` from a plugin-side uid/roleId.
 *
 * Some deployments accept uid directly as role_id; some require an extra lookup
 * via `/friend/search?uid=...`.
 */
export async function resolveFriendRoleId(uidOrRoleId, { force = false } = {}) {
  const id = String(uidOrRoleId || "").trim()
  if (!id) return { ok: false, message: "friendApi.missing_uid" }

  const { filePath: roleIdFilePath, legacyPath: roleIdLegacyPath } = roleIdCacheFilePaths(id)

  const runtime = getFriendApiRuntimeConfig()
  if (!runtime.enabled || !runtime.baseUrl) return { ok: false, message: "friendApi.disabled" }

  const cacheSec = Math.max(0, toInt(cfg.friendApi?.roleIdCacheSec, 86400))
  const cacheKey = roleIdCacheKey(id)

  if (!force && cacheSec > 0) {
    try {
      const cached = await redis.get(cacheKey)
      const v = String(cached || "").trim()
      if (v) {
        // Best-effort: persist to local disk so it survives Redis flush.
        saveJson(roleIdFilePath, { updatedAt: Date.now(), uid: id, roleId: v }).catch(() => {})
        return { ok: true, roleId: v, fromCache: true }
      }
    } catch {}
  }

  if (!force) {
    try {
      let local = await loadJson(roleIdFilePath)
      let fromLegacy = false
      if (!local) {
        local = await loadJson(roleIdLegacyPath)
        fromLegacy = !!local
      }
      const v = String(local?.roleId || local?.role_id || "").trim()
      if (v) {
        if (fromLegacy) saveJson(roleIdFilePath, { updatedAt: Number(local?.updatedAt) || Date.now(), uid: id, roleId: v }).catch(() => {})
        return { ok: true, roleId: v, fromCache: true, fromFile: true }
      }
    } catch {}
  }

  // Flow (preferred): uid -> role_id via search, then (fallback) treat as role_id.
  // This matches the typical usage:
  // - /friend/search?uid=xxx -> role_id
  // - /friend/detail?role_id=xxx -> char list
  let lastErr = ""

  try {
    const search = await requestFriendApi("/friend/search", { uid: id })
    if (search.ok) {
      const items = Array.isArray(search.data?.items) ? search.data.items : []
      const rid = items?.[0]?.role_id
      const v = rid != null ? String(rid).trim() : ""
      if (v) {
        if (cacheSec > 0) {
          try {
            await redis.setEx(cacheKey, cacheSec, v)
          } catch {
            try {
              await redis.set(cacheKey, v, { EX: cacheSec })
            } catch {}
          }
        }
        saveJson(roleIdFilePath, { updatedAt: Date.now(), uid: id, roleId: v }).catch(() => {})
        return { ok: true, roleId: v, fromCache: false }
      }
    } else {
      lastErr = search.message || lastErr
    }
  } catch (err) {
    lastErr = `friendApi.request_failed:${err?.message || err}`
  }

  try {
    const detail = await requestFriendApi("/friend/detail", { role_id: id })
    if (detail.ok) {
      const rid = detail.data?.role_profile?.role_id
      const v = rid != null ? String(rid).trim() : ""
      if (v) {
        if (cacheSec > 0) {
          try {
            await redis.setEx(cacheKey, cacheSec, v)
          } catch {
            try {
              await redis.set(cacheKey, v, { EX: cacheSec })
            } catch {}
          }
        }
        saveJson(roleIdFilePath, { updatedAt: Date.now(), uid: id, roleId: v }).catch(() => {})
        return { ok: true, roleId: v, fromCache: false }
      }
    } else {
      lastErr = lastErr ? `${lastErr};${detail.message || ""}`.replace(/;$/, "") : detail.message || lastErr
    }
  } catch (err) {
    const msg = `friendApi.request_failed:${err?.message || err}`
    lastErr = lastErr ? `${lastErr};${msg}` : msg
  }

  // Fallback: use cached mapping when Friend API is down.
  try {
    const cached = await redis.get(cacheKey)
    const v = String(cached || "").trim()
    if (v) return { ok: true, roleId: v, fromCache: true, stale: true }
  } catch {}

  try {
    let local = await loadJson(roleIdFilePath)
    let fromLegacy = false
    if (!local) {
      local = await loadJson(roleIdLegacyPath)
      fromLegacy = !!local
    }
    const v = String(local?.roleId || local?.role_id || "").trim()
    if (v) {
      if (fromLegacy) saveJson(roleIdFilePath, { updatedAt: Number(local?.updatedAt) || Date.now(), uid: id, roleId: v }).catch(() => {})
      return { ok: true, roleId: v, fromCache: true, fromFile: true, stale: true }
    }
  } catch {}

  return { ok: false, message: lastErr || "friendApi.role_not_found" }
}

function detailCacheKey(roleId) {
  const r = String(roleId || "").trim()
  return `Yz:EndUID:FriendDetail:${r}`
}

export async function getFriendDetail({ uidOrRoleId, force = false } = {}) {
  const runtime = getFriendApiRuntimeConfig()
  if (!runtime.enabled || !runtime.baseUrl) return { ok: false, message: "friendApi.disabled" }

  const resolved = await resolveFriendRoleId(uidOrRoleId, { force })
  if (!resolved.ok || !resolved.roleId) return { ok: false, message: resolved.message || "friendApi.role_not_found" }
  const roleId = String(resolved.roleId).trim()

  const { filePath, legacyPath } = detailCacheFilePaths(roleId)

  const cacheSec = Math.max(0, toInt(cfg.friendApi?.detailCacheSec, 300))
  const cacheKey = detailCacheKey(roleId)
  if (!force && cacheSec > 0) {
    try {
      const cached = await redis.get(cacheKey)
      if (cached) {
        const parsed = safeJsonParse(cached, null)
        const profile = parsed?.role_profile
        if (profile && typeof profile === "object") {
          const chars = Array.isArray(profile.char_data) ? profile.char_data : []
          saveJson(filePath, { updatedAt: Number(parsed?.updatedAt) || Date.now(), url: parsed?.url || "", role_profile: profile }).catch(
            () => {},
          )
          return { ok: true, roleId, profile, chars, fromCache: true, url: parsed.url || "" }
        }
      }
    } catch {}
  }

  const res = await requestFriendApi("/friend/detail", { role_id: roleId })
  if (!res.ok) {
    try {
      let local = await loadJson(filePath)
      let fromLegacy = false
      if (!local) {
        local = await loadJson(legacyPath)
        fromLegacy = !!local
      }
      const profile = local?.role_profile
      if (profile && typeof profile === "object") {
        const chars = Array.isArray(profile.char_data) ? profile.char_data : []

        // Best-effort: migrate legacy cache to the new bot-level data dir.
        if (fromLegacy) saveJson(filePath, local).catch(() => {})

        return {
          ok: true,
          roleId,
          profile,
          chars,
          fromCache: true,
          stale: true,
          error: String(res.message || "friendApi.request_failed"),
          url: String(local?.url || ""),
        }
      }
    } catch {}
    return { ok: false, message: res.message, url: res.url }
  }

  const profile = res.data?.role_profile
  if (!profile || typeof profile !== "object") return { ok: false, message: "friendApi.missing_role_profile", url: res.url }
  const chars = Array.isArray(profile.char_data) ? profile.char_data : []

  if (cacheSec > 0) {
    const payload = { updatedAt: Date.now(), url: res.url, role_profile: profile }
    try {
      await redis.setEx(cacheKey, cacheSec, JSON.stringify(payload))
    } catch {
      try {
        await redis.set(cacheKey, JSON.stringify(payload), { EX: cacheSec })
      } catch {}
    }
  }

  saveJson(filePath, { updatedAt: Date.now(), url: res.url, role_profile: profile }).catch(() => {})

  return { ok: true, roleId, profile, chars, fromCache: false, url: res.url }
}

export async function getFriendCharPanel({ roleId, templateId, advanced = false, force = false } = {}) {
  const runtime = getFriendApiRuntimeConfig()
  const r0 = String(roleId || "").trim()
  const t = String(templateId || "").trim()
  if (!runtime.enabled || !runtime.baseUrl) return { ok: false, message: "friendApi.disabled" }
  if (!r0 || !t) return { ok: false, message: "friendApi.missing_role_or_template" }

  const resolved = await resolveFriendRoleId(r0)
  if (!resolved.ok || !resolved.roleId) return { ok: false, message: resolved.message || "friendApi.role_not_found" }
  const r = String(resolved.roleId).trim()

  const cacheSec = Math.max(0, toInt(cfg.friendApi?.cacheSec, 120))
  const cacheKey = panelCacheKey(r, t, { advanced })

  if (!force && cacheSec > 0) {
    try {
      const cached = await redis.get(cacheKey)
      if (cached) {
        const parsed = JSON.parse(cached)
        if (parsed?.panel && typeof parsed.panel === "object") {
          return {
            ok: true,
            panel: parsed.panel,
            charMeta: parsed.charMeta && typeof parsed.charMeta === "object" ? parsed.charMeta : null,
            fromCache: true,
            url: parsed.url || "",
            roleId: r,
          }
        }
      }
    } catch {}
  }

  const advancedWanted = advanced || cfg.friendApi?.useAdvancedEndpoint
  const res = await requestCharWithFallback({ roleId: r, templateId: t, advancedWanted })
  if (!res.ok) return { ok: false, message: res.message, url: res.url }

  if (res.data?.found === false) {
    return {
      ok: false,
      message: "friendApi.char_not_found",
      url: res.url,
      availableTemplateIds: Array.isArray(res.data?.available_template_ids) ? res.data.available_template_ids : [],
    }
  }

  const panel = res.data?.panel
  if (!panel || typeof panel !== "object") return { ok: false, message: "friendApi.missing_panel", url: res.url }

  const charMeta = buildCharMeta(res.data)

  if (cacheSec > 0) {
    try {
      await redis.setEx(cacheKey, cacheSec, JSON.stringify({ updatedAt: Date.now(), url: res.url, panel, charMeta }))
    } catch {
      try {
        await redis.set(cacheKey, JSON.stringify({ updatedAt: Date.now(), url: res.url, panel, charMeta }), { EX: cacheSec })
      } catch {}
    }
  }

  return { ok: true, panel, charMeta, fromCache: false, url: res.url, roleId: r }
}

export async function getFriendCharComputed({ roleId, templateId, advanced = false, force = false } = {}) {
  const runtime = getFriendApiRuntimeConfig()
  const r0 = String(roleId || "").trim()
  const t = String(templateId || "").trim()
  if (!runtime.enabled || !runtime.baseUrl) return { ok: false, message: "friendApi.disabled" }
  if (!r0 || !t) return { ok: false, message: "friendApi.missing_role_or_template" }

  const resolved = await resolveFriendRoleId(r0)
  if (!resolved.ok || !resolved.roleId) return { ok: false, message: resolved.message || "friendApi.role_not_found" }
  const r = String(resolved.roleId).trim()

  return await getFriendCharComputedByRoleId({ roleId: r, templateId: t, advanced, force })
}

/**
 * Like getFriendCharComputed, but `roleId` is already the Friend API role_id.
 * This avoids an extra `/friend/search?uid=...` lookup and reduces intermittent failures.
 */
export async function getFriendCharComputedByRoleId({ roleId, templateId, advanced = false, force = false } = {}) {
  const runtime = getFriendApiRuntimeConfig()
  const r = String(roleId || "").trim()
  const t = String(templateId || "").trim()
  if (!runtime.enabled || !runtime.baseUrl) return { ok: false, message: "friendApi.disabled" }
  if (!r || !t) return { ok: false, message: "friendApi.missing_role_or_template" }

  const cacheSec = Math.max(0, toInt(cfg.friendApi?.cacheSec, 120))
  const cacheKey = computedCacheKey(r, t, { advanced })

  const staleCacheSec = Math.max(0, toInt(cfg.friendApi?.staleCacheSec, 86400))
  const staleKey = staleComputedCacheKey(r, t, { advanced })

  const { filePath, legacyPath } = computedCacheFilePaths(r, t, { advanced })

  async function readFileFallback(fallbackError) {
    try {
      let local = await loadJson(filePath)
      let fromLegacy = false
      if (!local) {
        local = await loadJson(legacyPath)
        fromLegacy = !!local
      }
      if (!local?.panel || typeof local.panel !== "object") return null

      // Best-effort: migrate legacy cache to the new bot-level data dir.
      if (fromLegacy) saveJson(filePath, local).catch(() => {})

      return {
        ok: true,
        panel: local.panel,
        equipMods: Array.isArray(local.equipMods) ? local.equipMods : [],
        attrNameMap: local.attrNameMap && typeof local.attrNameMap === "object" ? local.attrNameMap : {},
        charMeta: local.charMeta && typeof local.charMeta === "object" ? local.charMeta : null,
        weaponTerms: Array.isArray(local.weaponTerms) ? local.weaponTerms : [],
        charView: local.charView && typeof local.charView === "object" ? local.charView : null,
        fromCache: true,
        fromFile: true,
        stale: true,
        error: String(fallbackError || local.error || ""),
        url: String(local.url || ""),
        roleId: r,
      }
    } catch {
      return null
    }
  }

  async function readStale(fallbackError) {
    if (staleCacheSec <= 0) return await readFileFallback(fallbackError)
    try {
      const cached = await redis.get(staleKey)
      if (!cached) return await readFileFallback(fallbackError)
      const parsed = safeJsonParse(cached, null)
      if (!parsed?.panel || typeof parsed.panel !== "object") return await readFileFallback(fallbackError)
      saveJson(filePath, parsed).catch(() => {})
      return {
        ok: true,
        panel: parsed.panel,
        equipMods: Array.isArray(parsed.equipMods) ? parsed.equipMods : [],
        attrNameMap: parsed.attrNameMap && typeof parsed.attrNameMap === "object" ? parsed.attrNameMap : {},
        charMeta: parsed.charMeta && typeof parsed.charMeta === "object" ? parsed.charMeta : null,
        weaponTerms: Array.isArray(parsed.weaponTerms) ? parsed.weaponTerms : [],
        charView: parsed.charView && typeof parsed.charView === "object" ? parsed.charView : null,
        fromCache: true,
        stale: true,
        error: String(fallbackError || parsed.error || ""),
        url: parsed.url || "",
        roleId: r,
      }
    } catch {
      return await readFileFallback(fallbackError)
    }
  }

  if (!force && cacheSec > 0) {
    try {
      const cached = await redis.get(cacheKey)
      if (cached) {
        const parsed = safeJsonParse(cached, null)
        if (parsed?.panel && typeof parsed.panel === "object") {
          saveJson(filePath, parsed).catch(() => {})
          return {
            ok: true,
            panel: parsed.panel,
            equipMods: Array.isArray(parsed.equipMods) ? parsed.equipMods : [],
            attrNameMap: parsed.attrNameMap && typeof parsed.attrNameMap === "object" ? parsed.attrNameMap : {},
            charMeta: parsed.charMeta && typeof parsed.charMeta === "object" ? parsed.charMeta : null,
            weaponTerms: Array.isArray(parsed.weaponTerms) ? parsed.weaponTerms : [],
            charView: parsed.charView && typeof parsed.charView === "object" ? parsed.charView : null,
            fromCache: true,
            url: parsed.url || "",
            roleId: r,
          }
        }
      }
    } catch {}
  }

  const advancedWanted = advanced || cfg.friendApi?.useAdvancedEndpoint
  const res = await requestCharWithFallback({ roleId: r, templateId: t, advancedWanted })
  if (!res.ok) {
    const stale = await readStale(res.message)
    if (stale) return stale
    const fromFile = await readFileFallback(res.message)
    if (fromFile) return fromFile
    return { ok: false, message: res.message, url: res.url }
  }

  if (res.data?.found === false) {
    // Treat as "cannot fetch" as well: allow stale/local fallback.
    const stale = await readStale("friendApi.char_not_found")
    if (stale) return stale
    const fromFile = await readFileFallback("friendApi.char_not_found")
    if (fromFile) return fromFile
    return {
      ok: false,
      message: "friendApi.char_not_found",
      url: res.url,
      availableTemplateIds: Array.isArray(res.data?.available_template_ids) ? res.data.available_template_ids : [],
    }
  }

  const panel = res.data?.panel
  if (!panel || typeof panel !== "object") {
    const stale = await readStale("friendApi.missing_panel")
    if (stale) return stale
    const fromFile = await readFileFallback("friendApi.missing_panel")
    if (fromFile) return fromFile
    return { ok: false, message: "friendApi.missing_panel", url: res.url }
  }

  const charMeta = buildCharMeta(res.data)
  const weaponTerms = buildWeaponTerms(res.data)
  const charView = buildCharView(res.data)

  const processed = res.data?.processed && typeof res.data.processed === "object" ? res.data.processed : {}
  const runtimeMods = Array.isArray(processed.runtime_modifiers) ? processed.runtime_modifiers : []
  const equipMods = runtimeMods
    .filter(m => m && (m.source === "equip_base" || m.source === "equip_display") && m.slot !== undefined)
    .map(m => ({
      source: String(m.source || ""),
      item_id: String(m.item_id || ""),
      slot: toInt(m.slot, -1),
      attr_index: toInt(m.attr_index, -1),
      attr_type: toInt(m.attr_type, 0),
      attr_name: String(m.attr_name || ""),
      value: toNumber(m.value, 0),
      mode: String(m.mode || ""),
    }))
    .filter(m => m.slot >= 0)

  const attrNameMap = {}
  const aggregated = Array.isArray(processed.aggregated_attributes) ? processed.aggregated_attributes : []
  for (const a of aggregated) {
    const at = a?.attr_type
    const id = toInt(at?.id, -1)
    if (id < 0) continue
    const cn = String(at?.name_cn || "").trim()
    const en = String(at?.name || at?.raw_name || "").trim()
    if (cn && /[\u4e00-\u9fff]/.test(cn)) attrNameMap[id] = cn
    else if (en) attrNameMap[id] = en
  }

  const payload = {
    updatedAt: Date.now(),
    url: res.url,
    panel,
    equipMods,
    attrNameMap,
    charMeta,
    weaponTerms,
    charView,
  }

  if (cacheSec > 0) {
    try {
      await redis.setEx(cacheKey, cacheSec, JSON.stringify(payload))
    } catch {
      try {
        await redis.set(cacheKey, JSON.stringify(payload), { EX: cacheSec })
      } catch {}
    }
  }

  if (staleCacheSec > 0) {
    try {
      await redis.setEx(staleKey, staleCacheSec, JSON.stringify(payload))
    } catch {
      try {
        await redis.set(staleKey, JSON.stringify(payload), { EX: staleCacheSec })
      } catch {}
    }
  }

  // Persist to disk (no TTL). Best-effort.
  saveJson(filePath, payload).catch(() => {})

  return { ok: true, panel, equipMods, attrNameMap, charMeta, weaponTerms, charView, fromCache: false, url: res.url, roleId: r }
}

export function buildPanelStatsFromFriendPanel(panel) {
  // Keep this function pure: input panel -> stats fragments
  const p = panel && typeof panel === "object" ? panel : {}
  const summary = p.summary && typeof p.summary === "object" ? p.summary : {}
  const ability = p.ability && typeof p.ability === "object" ? p.ability : {}
  const contrib = ability.contributions && typeof ability.contributions === "object" ? ability.contributions : {}
  const attack = p.attack_breakdown && typeof p.attack_breakdown === "object" ? p.attack_breakdown : {}
  const health = p.health_breakdown && typeof p.health_breakdown === "object" ? p.health_breakdown : {}
  const defense = p.defense_breakdown && typeof p.defense_breakdown === "object" ? p.defense_breakdown : {}

  const toFloorInt = (value, def = 0) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.floor(n) : def
  }

  const fmtPct = (value, digits = 0) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return ""
    const abs = Math.abs(n)
    const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(Math.max(0, toInt(digits, 0)))
    return (n < 0 ? "-" : "") + s + "%"
  }

  const fmtBonusPct = (value, digits = 0) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return ""
    const s = fmtPct(n, digits)
    if (!s) return ""
    return n > 0 && s[0] !== "-" ? `+${s}` : s
  }

  const hpValue = toInt(summary.hp, toInt(health.hp_runtime, 0))
  const hpBase = toInt(health.char_hp, hpValue)
  const hpPlus = Math.max(0, hpValue - hpBase)

  const atkFinal = toNumber(attack.final_attack_runtime, toNumber(summary.atk, 0))
  const atkValue = Math.round(atkFinal)
  const atkBase = Math.round(toNumber(attack.total_before_ability, atkValue))
  const atkPlus = atkValue - atkBase

  const defValue = toInt(summary.def, toInt(defense.defense, 0))

  // The UI uses the `speed` slot; Friend API exposes `agility` in panel.summary.
  // Use ability contributions when available for a base/plus split.
  const agiFinal = toInt(summary.agility, toFloorInt(contrib?.agility?.final, 0))
  const agiBase = toFloorInt(contrib?.agility?.base, agiFinal)
  const agiPlus = agiFinal - agiBase

  const strFinal = toInt(summary.strength, toFloorInt(contrib?.strength?.final, 0))
  const strBase = toFloorInt(contrib?.strength?.base, strFinal)
  const strPlus = strFinal - strBase

  const wisFinal = toInt(summary.wisdom, toFloorInt(contrib?.wisdom?.final, 0))
  const wisBase = toFloorInt(contrib?.wisdom?.base, wisFinal)
  const wisPlus = wisFinal - wisBase

  const willFinal = toInt(summary.will, toFloorInt(contrib?.will?.final, 0))
  const willBase = toFloorInt(contrib?.will?.base, willFinal)
  const willPlus = willFinal - willBase

  const pres = toNumber(summary.physical_resist, Number.NaN)
  const sres = toNumber(summary.spell_resist, Number.NaN)
  const healTaken = toNumber(summary.heal_taken_bonus_pct, Number.NaN)

  const critRate = toNumber(summary.critical_rate_pct, Number.NaN)
  const critDmg = toNumber(summary.critical_damage_pct, Number.NaN)

  return {
    hp: {
      value: hpValue ? String(hpValue) : "",
      base: hpBase ? String(hpBase) : "",
      plus: String(hpPlus),
    },
    atk: {
      value: atkValue ? String(atkValue) : "",
      base: atkBase ? String(atkBase) : "",
      plus: String(atkPlus),
    },
    def: {
      value: defValue ? String(defValue) : "",
      base: defValue ? String(defValue) : "",
      plus: "0",
    },
    speed: {
      value: agiFinal ? String(agiFinal) : "",
      base: agiFinal ? String(agiBase) : "",
      plus: String(agiPlus),
    },
    str: {
      value: strFinal ? String(strFinal) : "",
      base: strFinal ? String(strBase) : "",
      plus: String(strPlus),
    },
    wis: {
      value: wisFinal ? String(wisFinal) : "",
      base: wisFinal ? String(wisBase) : "",
      plus: String(wisPlus),
    },
    will: {
      value: willFinal ? String(willFinal) : "",
      base: willFinal ? String(willBase) : "",
      plus: String(willPlus),
    },
    cpct: {
      value: Number.isFinite(critRate) ? `${critRate.toFixed(1)}%` : "",
      base: Number.isFinite(critRate) ? `${critRate.toFixed(1)}%` : "",
      plus: "0",
    },
    cdmg: {
      value: Number.isFinite(critDmg) ? `${critDmg.toFixed(1)}%` : "",
      base: Number.isFinite(critDmg) ? `${critDmg.toFixed(1)}%` : "",
      plus: "0",
    },
    pres: {
      value: Number.isFinite(pres) ? fmtPct(pres, 0) : "",
      base: Number.isFinite(pres) ? fmtPct(pres, 0) : "",
      plus: "0",
    },
    sres: {
      value: Number.isFinite(sres) ? fmtPct(sres, 0) : "",
      base: Number.isFinite(sres) ? fmtPct(sres, 0) : "",
      plus: "0",
    },
    heal: {
      value: Number.isFinite(healTaken) ? fmtBonusPct(healTaken, 1) : "",
      base: Number.isFinite(healTaken) ? fmtBonusPct(healTaken, 1) : "",
      plus: "0",
    },
  }
}

export async function getFriendApiHealth({ timeoutMs = 1500 } = {}) {
  const runtime = getFriendApiRuntimeConfig()
  if (!runtime.enabled || !runtime.baseUrl) return { ok: false, message: "friendApi.disabled" }

  const res = await requestFriendApi("/health", null, { timeoutMs })
  if (!res.ok) return { ok: false, message: res.message, url: res.url }
  return { ok: true, data: res.data, url: res.url }
}
