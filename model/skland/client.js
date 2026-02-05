/**
 * Skland HTTP 客户端。
 *
 * 负责：
 * - token 刷新与短期缓存
 * - 请求签名生成（HMAC + MD5）
 * - 对需要 dId 的接口，通过 smsdk 生成 dId
 * - 不同场景（app / webview / oauth）的通用 headers 组装
 */
import fetch from "node-fetch"

import config from "../config.js"
import { buildHypergryphHeaders, getOrCreateHypergryphDevice, tokenKeyByCred } from "../store.js"
import {
  APP_CODE,
  BINDING_URL,
  CARD_DETAIL_URL,
  CRED_API,
  ENDFIELD_APP_CODE,
  ENDFIELD_ATTENDANCE_URL,
  GAME_ID_ENDFIELD,
  OAUTH_API,
  REFRESH_TOKEN_URL,
  SCAN_LOGIN_API,
  SCAN_STATUS_API,
  TOKEN_BY_SCAN_CODE_API,
  USER_INFO_URL,
} from "./api.js"
import { generateSign } from "./signature.js"
import {
  SIGN_VNAME,
  SKLAND_APP_PLATFORM,
  SKLAND_APP_VNAME,
  buildBaseHeader,
  getEndfieldWebHeaders,
  getOauthHeader,
  getRefreshHeader,
  getSklandAppHeaders,
} from "./headers.js"
import { getDeviceId } from "./deviceId.js"

function buildQueryString(params) {
  if (!params) return ""
  // 参数按 key 排序：保证签名用的 query string 稳定。
  const entries = Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null && `${v}` !== "")
    .sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
  if (!entries.length) return ""
  return entries.map(([k, v]) => `${k}=${v}`).join("&")
}

async function readJsonSafe(resp) {
  // Skland 可能返回非 JSON 的错误体；解析失败则当作 null。
  const text = await resp.text()
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function getHypergryphHeaders(userId, { json = true } = {}) {
  const uid = String(userId ?? "").trim()
  if (!uid) return getOauthHeader()
  try {
    const device = await getOrCreateHypergryphDevice(uid)
    return buildHypergryphHeaders(device, { json })
  } catch {
    return getOauthHeader()
  }
}

export async function refreshToken(cred, { force = false } = {}) {
  const c = String(cred || "").trim()
  if (!c) return ""

  // token 缓存 key = md5(cred)，避免把敏感信息直接写入 key。
  const key = tokenKeyByCred(c)
  if (!force) {
    const cached = await redis.get(key)
    if (cached) return cached
  }

  const resp = await fetch(REFRESH_TOKEN_URL, {
    method: "GET",
    headers: getRefreshHeader(c),
  })

  const data = await readJsonSafe(resp)
  if (!data) return ""
  if (data.code === 0 && data.message === "OK" && data.data?.token) {
    const token = String(data.data.token)
    try {
      await redis.setEx(key, 180, token)
    } catch {
      await redis.set(key, token, { EX: 180 })
    }
    return token
  }
  return ""
}

export async function request({
  url,
  method = "POST",
  cred,
  uid,
  gameId,
  params,
  body,
  useDeviceId = false,
  extraHeaders,
  userAgent,
  acceptEncoding,
  platform = 3,
  vName = SIGN_VNAME,
}) {
  const c = String(cred || "").trim()
  if (!c) throw new Error("missing cred")

  // 绝大多数接口都需要短期 token。
  const token = await refreshToken(c)
  if (!token) return null

  const parsed = new URL(url)
  const apiPath = parsed.pathname

  const queryString = buildQueryString(params)
  const bodyString = body ? JSON.stringify(body) : ""

  let finalUrl = url
  if (method === "GET" && queryString) finalUrl = `${url}?${queryString}`

  // 签名输入：GET 用 query；POST 用 query + body。
  const payloadString = method === "GET" ? queryString : `${queryString}${bodyString}`

  const effectiveUserAgent =
    userAgent ||
    extraHeaders?.["User-Agent"] ||
    extraHeaders?.["user-agent"] ||
    config.skland.ua.android

  // dId 为可选字段：只有部分接口/场景需要。
  let did = ""
  if (useDeviceId) {
    const acceptLanguage =
      extraHeaders?.["Accept-Language"] ||
      extraHeaders?.["accept-language"] ||
      extraHeaders?.language ||
      ""
    const referer =
      extraHeaders?.Referer ||
      extraHeaders?.referer ||
      extraHeaders?.Origin ||
      extraHeaders?.origin ||
      ""
    did = await getDeviceId({ userAgent: effectiveUserAgent, acceptLanguage, referer })
  }

  // 签名必须与 path/query/body/timestamp/headerJson 完全一致。
  const signData = generateSign({
    token,
    path: apiPath,
    queryOrBody: payloadString,
    platform: String(platform),
    vName,
    dId: did,
  })

  const headers = buildBaseHeader({
    cred: c,
    timestamp: signData.timestamp,
    sign: signData.sign,
    platform,
    uid,
    gameId,
    vName,
    dId: did,
    userAgent: effectiveUserAgent,
    acceptEncoding: acceptEncoding || "gzip",
  })

  if (extraHeaders && typeof extraHeaders === "object") Object.assign(headers, extraHeaders)

  const resp = await fetch(finalUrl, {
    method,
    headers,
    body: method === "GET" ? undefined : bodyString || undefined,
  })

  const json = await readJsonSafe(resp)
  // 400/403 常见于签名/鉴权失败：尽量把服务端的 JSON 错误体透传出去，便于提示与排查。
  if (resp.status === 400 || resp.status === 403) return json || null
  if (resp.status !== 200) return null
  return json || null
}

export async function getBinding(cred) {
  return request({ url: BINDING_URL, method: "GET", cred })
}

export async function getUserInfo(cred, { extraHeaders } = {}) {
  const ua = extraHeaders?.["User-Agent"] || extraHeaders?.["user-agent"] || config.skland.ua.sklandApp
  const headers = { ...getSklandAppHeaders(ua), ...(extraHeaders || {}) }
  return request({
    url: USER_INFO_URL,
    method: "GET",
    cred,
    useDeviceId: true,
    userAgent: ua,
    acceptEncoding: "gzip",
    extraHeaders: headers,
    platform: SKLAND_APP_PLATFORM,
    vName: SKLAND_APP_VNAME,
  })
}

export async function attendance(cred, uid) {
  return request({
    url: ENDFIELD_ATTENDANCE_URL,
    method: "POST",
    cred,
    uid,
    gameId: GAME_ID_ENDFIELD,
    body: { uid, gameId: String(GAME_ID_ENDFIELD) },
    useDeviceId: false,
    acceptEncoding: "gzip, deflate",
  })
}

export async function getCardDetail(cred, { uid, serverId = "1", userId }) {
  return request({
    url: CARD_DETAIL_URL,
    method: "GET",
    cred,
    params: { roleId: uid, serverId: String(serverId || "1"), userId: String(userId) },
    useDeviceId: true,
    extraHeaders: getEndfieldWebHeaders(),
    acceptEncoding: "gzip, deflate",
  })
}

export async function getScanId(userId) {
  // 扫码登录流程（Hypergryph）：
  // 1) 获取 scanId + scanUrl（用于生成二维码）；
  // 2) 轮询 scanId 状态拿到 scanCode；
  // 3) scanCode 换取 token/deviceToken；
  // 4) token 走 oauth -> cred，得到最终 cred。
  const resp = await fetch(SCAN_LOGIN_API, {
    method: "POST",
    headers: await getHypergryphHeaders(userId, { json: false }),
  })
  const data = await readJsonSafe(resp)
  if (!data || data.status !== 0) return { scanId: "", scanUrl: "", enableScanAppList: [] }

  const scanId = String(data.data?.scanId || "")
  const scanUrl = String(data.data?.scanUrl || "")
  const enableScanAppList = Array.isArray(data.data?.enableScanAppList) ? data.data.enableScanAppList : []
  return { scanId, scanUrl, enableScanAppList }
}

export async function getScanStatus(scanId, userId) {
  // 轮询扫码状态：用户在 App 内确认后才会下发 scanCode。
  const url = `${SCAN_STATUS_API}?scanId=${encodeURIComponent(scanId)}`
  const resp = await fetch(url, { method: "GET", headers: await getHypergryphHeaders(userId, { json: false }) })
  const data = await readJsonSafe(resp)
  if (!data || data.status !== 0) return ""
  return String(data.data?.scanCode || "")
}

export async function getTokenByScanCode(scanCode, userId) {
  // scanCode -> token/deviceToken，用于后续换取 Skland cred。
  const resp = await fetch(TOKEN_BY_SCAN_CODE_API, {
    method: "POST",
    headers: await getHypergryphHeaders(userId),
    body: JSON.stringify({ appCode: ENDFIELD_APP_CODE, from: 0, scanCode }),
  })
  const data = await readJsonSafe(resp)
  if (!data || data.status !== 0) return { token: "", deviceToken: "" }

  const token = String(data.data?.token || "")
  const deviceToken = String(data.data?.deviceToken ?? data.data?.device_token ?? "")
  return { token, deviceToken }
}

export async function getCredInfoByToken(token, { userId } = {}) {
  // token -> oauth code -> cred
  // 说明：这一步使用的是 Web 环境的 dId/headers（与 Skland App headers 不同）。
  const resp = await fetch(OAUTH_API, {
    method: "POST",
    headers: await getHypergryphHeaders(userId),
    body: JSON.stringify({ appCode: APP_CODE, token, type: 0 }),
  })

  // 405 一般表示接口拒绝当前请求方法/来源（可能与风控、接口变更有关）。
  if (resp.status === 405) return { error: "405" }

  const oauth = await readJsonSafe(resp)
  if (!oauth || oauth.status !== 0) return { error: "oauth_failed" }
  const code = oauth.data?.code
  if (!code) return { error: "missing_oauth_code" }

  const acceptLanguage = "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7"
  const did = await getDeviceId({
    userAgent: config.skland.ua.web,
    acceptLanguage,
    referer: "https://www.skland.com/",
  })

  const credHeader = {
    "content-type": "application/json",
    "user-agent": config.skland.ua.web,
    referer: "https://www.skland.com/",
    origin: "https://www.skland.com",
    dId: did,
    platform: "3",
    timestamp: String(Math.floor(Date.now() / 1000)),
    vName: "1.0.0",
  }

  const resp2 = await fetch(CRED_API, {
    method: "POST",
    headers: credHeader,
    body: JSON.stringify({ kind: 1, code }),
  })
  const data2 = await readJsonSafe(resp2)
  if (!data2 || data2.code !== 0 || !data2.data?.cred) return { error: "cred_failed" }

  const sklandUserId =
    data2.data.userId ??
    data2.data.user_id ??
    data2.data.uid ??
    data2.data.sklandUserId ??
    data2.data.skland_user_id

  return { cred: String(data2.data.cred), sklandUserId: sklandUserId != null ? String(sklandUserId) : "" }
}
