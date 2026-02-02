import config from "../config.js"

export const SIGN_VNAME = "1.0.0"

export const SKLAND_APP_VNAME = "1.52.1"
export const SKLAND_APP_VCODE = "105201003"
export const SKLAND_APP_PLATFORM = 1

export function getRefreshHeader(cred) {
  return {
    cred,
    "User-Agent": config.skland.ua.ios,
    "Content-Type": "application/json",
  }
}

export function getOauthHeader() {
  return {
    "User-Agent": config.skland.ua.ios,
    "Content-Type": "application/json;charset=utf-8",
  }
}

function guessManufacturer(userAgent) {
  const ua = String(userAgent || "").toLowerCase()
  if (!ua) return "Samsung"
  if (ua.includes("samsung") || ua.includes("sm-")) return "Samsung"
  if (ua.includes("xiaomi") || ua.includes("mi ") || ua.includes("redmi") || ua.includes("poco")) return "Xiaomi"
  if (ua.includes("huawei") || ua.includes("honor")) return "Huawei"
  if (ua.includes("oneplus")) return "OnePlus"
  if (ua.includes("oppo")) return "Oppo"
  if (ua.includes("vivo")) return "Vivo"
  return "Samsung"
}

export function getSklandAppHeaders(userAgent) {
  return {
    language: "zh-cn",
    os: "32",
    nId: "1",
    vCode: SKLAND_APP_VCODE,
    channel: "OF",
    manufacturer: guessManufacturer(userAgent),
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  }
}

export function getEndfieldWebHeaders() {
  return {
    Accept: "*/*",
    Origin: "https://game.skland.com",
    "X-Requested-With": "com.hypergryph.skland",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Referer: "https://game.skland.com/",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    Host: "zonai.skland.com",
    Connection: "keep-alive",
  }
}

export function buildBaseHeader({
  cred,
  timestamp,
  sign,
  platform = 3,
  uid,
  gameId,
  vName = SIGN_VNAME,
  dId = "",
  userAgent,
  acceptEncoding = "gzip",
}) {
  const headers = {
    "User-Agent": userAgent || config.skland.ua.android,
    "Accept-Encoding": acceptEncoding,
    "Content-Type": "application/json",
    cred: String(cred),
    timestamp: String(timestamp),
    sign: String(sign),
    vName: String(vName),
    dId: String(dId || ""),
    platform: String(platform),
  }

  if (uid && gameId) headers["sk-game-role"] = `${platform}_${uid}_${gameId}`
  return headers
}

