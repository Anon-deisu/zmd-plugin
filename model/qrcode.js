import fs from "node:fs/promises"
import path from "node:path"

import { PLUGIN_ID } from "./pluginMeta.js"

function uniqueName(prefix, ext) {
  const rand = Math.random().toString(16).slice(2)
  return `${prefix}_${Date.now()}_${rand}.${ext}`
}

let qrLib = null
async function getQrLib() {
  if (qrLib) return qrLib
  try {
    const mod = await import("qrcode")
    qrLib = mod?.default || mod
    return qrLib
  } catch (err) {
    const reason = err?.message || String(err)
    throw new Error(`缺少依赖：qrcode（请在 TRSS-Yunzai 根目录执行 pnpm add qrcode 后重启）\n${reason}`)
  }
}

export async function makeQrPng(text) {
  const tmpDir = path.join(process.cwd(), "temp", PLUGIN_ID)
  await fs.mkdir(tmpDir, { recursive: true })

  const outPath = path.join(tmpDir, uniqueName("zmd_qr", "png"))
  const value = String(text || "").trim()
  if (!value) throw new Error("二维码内容为空")

  const QRCode = await getQrLib()
  await new Promise((resolve, reject) => {
    try {
      QRCode.toFile(
        outPath,
        value,
        { type: "png", errorCorrectionLevel: "M", margin: 1, width: 420 },
        err => (err ? reject(err) : resolve(true)),
      )
    } catch (err) {
      reject(err)
    }
  })
  return outPath
}
