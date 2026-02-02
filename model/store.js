import crypto from "node:crypto"

const KEY_USER_PREFIX = "Yz:EndUID:User:"
const KEY_USER = userId => `${KEY_USER_PREFIX}${userId}`
const KEY_TOKEN = cred => `Yz:EndUID:Token:${crypto.createHash("md5").update(String(cred)).digest("hex")}`
const KEY_HG_DEVICE = userId => `Yz:EndUID:HgDevice:${userId}`
const KEY_AUTOSIGN_USERS = "Yz:EndUID:AutoSignUsers"
const KEY_USERS = "Yz:EndUID:Users"

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function tokenKeyByCred(cred) {
  return KEY_TOKEN(cred)
}

function normalizeHypergryphDevice(raw) {
  const obj = raw && typeof raw === "object" ? raw : null
  if (!obj) return null

  const deviceIdRaw = obj.deviceId ?? obj.device_id ?? obj.deviceId1 ?? obj.device_id1
  const deviceId2Raw = obj.deviceId2 ?? obj.device_id2 ?? obj.deviceId_2 ?? obj.device_id_2 ?? deviceIdRaw
  const deviceModelRaw = obj.deviceModel ?? obj.device_model ?? obj.deviceModelName ?? obj.device_model_name
  const deviceTypeRaw = obj.deviceType ?? obj.device_type ?? obj.deviceTypeValue ?? obj.device_type_value ?? 2

  const deviceId = String(deviceIdRaw ?? "").trim().toLowerCase()
  const deviceId2 = String(deviceId2Raw ?? "").trim().toLowerCase()
  const deviceModel = String(deviceModelRaw ?? "").trim()

  const validHex32 = s => /^[0-9a-f]{32}$/.test(String(s || "").trim().toLowerCase())
  if (!validHex32(deviceId) || !validHex32(deviceId2)) return null

  const deviceTypeNum = Number.parseInt(String(deviceTypeRaw ?? ""), 10)
  const deviceType = Number.isFinite(deviceTypeNum) ? String(deviceTypeNum) : "2"

  return {
    deviceId,
    deviceId2,
    deviceModel: deviceModel || `LAPTOP-${deviceId.slice(0, 8)}`,
    deviceType: deviceType || "2",
  }
}

export function buildHypergryphHeaders(device, { json = true } = {}) {
  const d = normalizeHypergryphDevice(device)
  const headers = {
    "User-Agent": "Mozilla/5.0",
  }
  if (d) {
    headers["X-DeviceId"] = d.deviceId
    headers["X-DeviceId2"] = d.deviceId2
    headers["X-DeviceModel"] = d.deviceModel
    headers["X-DeviceType"] = d.deviceType
  }
  if (json) headers["Content-Type"] = "application/json;charset=utf-8"
  return headers
}

export async function getOrCreateHypergryphDevice(userId) {
  const id = String(userId ?? "").trim()
  if (!id) throw new Error("missing userId")

  const key = KEY_HG_DEVICE(id)
  try {
    const cached = await redis.get(key)
    const parsed = safeJsonParse(cached, null)
    const normalized = normalizeHypergryphDevice(parsed)
    if (normalized) return normalized
  } catch {}

  const deviceId = crypto.randomBytes(16).toString("hex")
  const device = {
    deviceId,
    deviceId2: deviceId,
    deviceModel: `LAPTOP-${deviceId.slice(0, 8)}`,
    deviceType: "2",
  }

  try {
    await redis.set(key, JSON.stringify(device))
  } catch {}

  return device
}

function normalizeAccount(rawAccount) {
  if (!rawAccount || typeof rawAccount !== "object") return null

  const uid = rawAccount.uid != null ? String(rawAccount.uid).trim() : ""
  if (uid) rawAccount.uid = uid
  else {
    const altUid =
      rawAccount.endfieldUid ??
      rawAccount.endUid ??
      rawAccount.enduid ??
      rawAccount.roleId ??
      rawAccount.role_id ??
      rawAccount.gameUid ??
      rawAccount.game_uid
    if (altUid != null && String(altUid).trim()) rawAccount.uid = String(altUid).trim()
  }

  const nickname = rawAccount.nickname != null ? String(rawAccount.nickname).trim() : ""
  if (nickname) rawAccount.nickname = nickname
  else {
    const altNick = rawAccount.nickName ?? rawAccount.nick_name ?? rawAccount.name
    if (altNick != null && String(altNick).trim()) rawAccount.nickname = String(altNick).trim()
  }

  const serverId = rawAccount.serverId != null ? String(rawAccount.serverId).trim() : ""
  if (serverId) rawAccount.serverId = serverId
  else {
    const altServer = rawAccount.server_id ?? rawAccount.server ?? rawAccount.sid
    if (altServer != null && String(altServer).trim()) rawAccount.serverId = String(altServer).trim()
  }

  if (rawAccount.cred != null) rawAccount.cred = String(rawAccount.cred)
  if (rawAccount.token != null) rawAccount.token = String(rawAccount.token)
  if (rawAccount.recordUid != null) rawAccount.recordUid = String(rawAccount.recordUid)
  if (rawAccount.deviceToken != null) rawAccount.deviceToken = String(rawAccount.deviceToken)
  else if (rawAccount.device_token != null) rawAccount.deviceToken = String(rawAccount.device_token)
  if (rawAccount.sklandUserId != null) rawAccount.sklandUserId = String(rawAccount.sklandUserId)

  return rawAccount
}

function normalizeUserDataShape(parsed) {
  const empty = { accounts: [], active: 0, autoSign: false }
  if (!parsed) return { data: empty, needsSave: false }

  let data = null
  let needsSave = false

  if (Array.isArray(parsed)) {
    data = { accounts: parsed, active: 0, autoSign: false }
    needsSave = true
  } else if (typeof parsed === "object") {
    const obj = parsed
    const active = obj.active ?? obj.activeIndex ?? obj.activeUid ?? obj.currentUid ?? 0
    const autoSign = obj.autoSign ?? obj.auto_sign ?? obj.autoSignIn ?? false

    if (Array.isArray(obj.accounts)) {
      data = obj
      if (data.active == null && (obj.activeIndex != null || obj.activeUid != null || obj.currentUid != null)) needsSave = true
      if (data.autoSign == null && (obj.auto_sign != null || obj.autoSignIn != null)) needsSave = true
      if (data.active == null) data.active = active
      if (data.autoSign == null) data.autoSign = autoSign
    }
    else if (Array.isArray(obj.list)) {
      data = { accounts: obj.list, active, autoSign }
      needsSave = true
    } else if (obj.accounts && typeof obj.accounts === "object") {
      data = { accounts: [obj.accounts], active, autoSign }
      needsSave = true
    } else if (Array.isArray(obj.account)) {
      data = { accounts: obj.account, active, autoSign }
      needsSave = true
    } else if (obj.account && typeof obj.account === "object") {
      data = { accounts: [obj.account], active, autoSign }
      needsSave = true
    } else if (obj.cred != null || obj.uid != null || obj.token != null) {
      data = { accounts: [obj], active, autoSign }
      needsSave = true
    }
  }

  if (!data || typeof data !== "object") return { data: empty, needsSave: false }

  const accounts = Array.isArray(data.accounts) ? data.accounts : []
  const normalizedAccounts = []
  for (const raw of accounts) {
    const a = normalizeAccount(raw)
    if (a) normalizedAccounts.push(a)
  }

  data.accounts = normalizedAccounts
  if (data.active == null) data.active = 0
  if (data.autoSign == null) data.autoSign = false
  data.autoSign = !!data.autoSign

  return { data, needsSave }
}

export async function getUserData(userId) {
  let raw = null
  try {
    raw = await redis.get(KEY_USER(userId))
  } catch {}
  const parsed = raw ? safeJsonParse(raw, null) : null
  const { data, needsSave } = normalizeUserDataShape(parsed)

  if (needsSave && data && typeof data === "object") {
    try {
      await saveUserData(userId, data)
    } catch {}
  }

  return data
}

export async function saveUserData(userId, data) {
  await redis.set(KEY_USER(userId), JSON.stringify(data))

  const hasAccounts = Array.isArray(data?.accounts) && data.accounts.length > 0
  try {
    if (hasAccounts) await redis.sAdd(KEY_USERS, String(userId))
    else await redis.sRem(KEY_USERS, String(userId))
  } catch {}
}

export async function getActiveAccount(userId) {
  const data = await getUserData(userId)
  const accounts = Array.isArray(data?.accounts) ? data.accounts : []
  if (!accounts.length) return { data, account: null, index: -1 }

  const raw = data.active
  const rawStr = String(raw ?? "").trim()
  const isIntStr = rawStr && /^-?\d+$/.test(rawStr)
  const rawNum = isIntStr ? Number(rawStr) : Number.isFinite(raw) ? Number(raw) : NaN

  let idx = -1
  if (Number.isFinite(rawNum)) {
    if (rawNum >= 0 && rawNum < accounts.length) idx = rawNum
    else if (rawNum >= 1 && rawNum <= accounts.length && accounts.length === 1) idx = rawNum - 1
  }
  if (idx < 0 && rawStr) {
    idx = accounts.findIndex(a => String(a?.uid || "") === rawStr)
  }
  if (idx < 0) idx = 0

  const account = accounts[idx] || null
  if (account && idx !== Number(data.active)) {
    try {
      data.active = idx
      await saveUserData(userId, data)
    } catch {}
  }

  return account ? { data, account, index: idx } : { data, account: null, index: -1 }
}

export async function upsertAccount(userId, account) {
  const data = await getUserData(userId)
  const cred = String(account?.cred || "")
  if (!cred) throw new Error("missing cred")

  const idx = data.accounts.findIndex(a => String(a?.cred || "") === cred)
  if (idx >= 0) data.accounts[idx] = { ...data.accounts[idx], ...account }
  else data.accounts.push({ ...account })
  data.active = idx >= 0 ? idx : data.accounts.length - 1
  await saveUserData(userId, data)
  return data
}

export async function setActiveAccount(userId, target) {
  const data = await getUserData(userId)
  if (!data.accounts.length) return { ok: false, reason: "empty" }

  let idx = -1
  const t = String(target ?? "").trim()
  if (/^\d+$/.test(t)) {
    const num = Number(t)
    if (num >= 1 && num <= data.accounts.length) idx = num - 1
    else idx = data.accounts.findIndex(a => String(a?.uid || "") === t)
  } else if (t) {
    idx = data.accounts.findIndex(a => String(a?.uid || "") === t)
  }

  if (idx < 0) return { ok: false, reason: "not_found" }
  data.active = idx
  await saveUserData(userId, data)
  return { ok: true, data, index: idx }
}

export async function deleteAccount(userId, target) {
  const data = await getUserData(userId)
  if (!data.accounts.length) return { ok: false, reason: "empty" }

  const t = String(target ?? "").trim()
  let idx = -1
  if (/^\d+$/.test(t)) {
    const num = Number(t)
    if (num >= 1 && num <= data.accounts.length) idx = num - 1
    else idx = data.accounts.findIndex(a => String(a?.uid || "") === t)
  } else if (t) {
    idx = data.accounts.findIndex(a => String(a?.uid || "") === t)
  }

  if (idx < 0) return { ok: false, reason: "not_found" }

  data.accounts.splice(idx, 1)
  if (!data.accounts.length) {
    data.active = 0
    data.autoSign = false
    await redis.sRem(KEY_AUTOSIGN_USERS, String(userId))
  } else if (Number(data.active) >= data.accounts.length) {
    data.active = 0
  }
  await saveUserData(userId, data)
  return { ok: true, data }
}

export async function setAutoSign(userId, enabled) {
  const data = await getUserData(userId)
  data.autoSign = !!enabled
  await saveUserData(userId, data)
  if (data.autoSign) await redis.sAdd(KEY_AUTOSIGN_USERS, String(userId))
  else await redis.sRem(KEY_AUTOSIGN_USERS, String(userId))
  return data
}

export async function listAutoSignUsers() {
  try {
    return (await redis.sMembers(KEY_AUTOSIGN_USERS)) || []
  } catch {
    return []
  }
}

export async function listBoundUsers() {
  const out = new Set()
  try {
    const fromSet = (await redis.sMembers(KEY_USERS)) || []
    for (const id of fromSet) out.add(String(id))
  } catch {}

  try {
    let cursor = 0
    const MATCH = `${KEY_USER_PREFIX}*`
    do {
      const reply = await redis.scan(cursor, { MATCH, COUNT: 10000 })
      cursor = reply.cursor
      for (const key of reply.keys || []) {
        if (typeof key !== "string" || !key.startsWith(KEY_USER_PREFIX)) continue
        const id = key.slice(KEY_USER_PREFIX.length)
        if (id) out.add(id)
      }
    } while (cursor != 0)
  } catch {}

  return [...out]
}

export async function countBoundUsers() {
  try {
    return Number(await redis.sCard(KEY_USERS)) || 0
  } catch {
    return 0
  }
}
