import crypto from "node:crypto"

export function generateSign({
  token,
  path,
  queryOrBody = "",
  timestamp = Math.floor(Date.now() / 1000),
  platform = "3",
  vName = "1.0.0",
  dId = "",
}) {
  const ts = String(timestamp)
  const headerForSign = {
    platform: String(platform),
    timestamp: ts,
    dId: dId || "",
    vName: String(vName),
  }
  const headerJson = JSON.stringify(headerForSign)
  const signString = `${path}${queryOrBody}${ts}${headerJson}`

  const hmacHex = crypto.createHmac("sha256", String(token)).update(signString).digest("hex")
  const md5Hex = crypto.createHash("md5").update(hmacHex).digest("hex")
  return { sign: md5Hex, timestamp: ts, headerForSign }
}

