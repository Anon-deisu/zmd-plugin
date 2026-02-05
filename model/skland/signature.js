/**
 * 请求签名生成。
 *
 * Skland 的签名大致为 HMAC-SHA256 + MD5 链：
 *   signString = path + query/body + timestamp + json(headerForSign)
 * 其中 headerForSign 包含 platform/timestamp/dId/vName。
 */
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
  // 保持 header JSON 稳定：键顺序参与签名字符串，乱序会导致签名不一致。
  const ts = String(timestamp)
  const headerForSign = {
    platform: String(platform),
    timestamp: ts,
    dId: dId || "",
    vName: String(vName),
  }
  const headerJson = JSON.stringify(headerForSign)
  const signString = `${path}${queryOrBody}${ts}${headerJson}`

  // HMAC(token, signString) -> hex -> md5(hex) 得到最终 sign。
  const hmacHex = crypto.createHmac("sha256", String(token)).update(signString).digest("hex")
  const md5Hex = crypto.createHash("md5").update(hmacHex).digest("hex")
  return { sign: md5Hex, timestamp: ts, headerForSign }
}
