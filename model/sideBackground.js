import crypto from "node:crypto"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import { PLUGIN_RESOURCES_DIR } from "./pluginMeta.js"

export const SIDE_BG_DIR = path.join(PLUGIN_RESOURCES_DIR, "side")
export const SIDE_BG_BASE_FILE = "61686c1cbfcfb586f1338525dccc90cf.jpg"

const IMG_EXT_RE = /\.(?:png|jpe?g|webp|bmp)$/i

function normalizeExt(ext) {
  const raw = String(ext || "").trim().toLowerCase()
  if (raw === ".png") return ".png"
  if (raw === ".webp") return ".webp"
  if (raw === ".bmp") return ".bmp"
  if (raw === ".jpeg" || raw === ".jpg") return ".jpg"
  return ".jpg"
}

export function listSideBackgroundFiles() {
  try {
    if (!fsSync.existsSync(SIDE_BG_DIR)) return []
    return fsSync
      .readdirSync(SIDE_BG_DIR)
      .filter(name => IMG_EXT_RE.test(name))
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
  } catch {
    return []
  }
}

export function pickRandomSideBackgroundRel() {
  const files = listSideBackgroundFiles()
  if (files.length > 0) {
    const file = files[Math.floor(Math.random() * files.length)]
    if (file) return `side/${file}`
  }

  const fallback = path.join(SIDE_BG_DIR, SIDE_BG_BASE_FILE)
  if (fsSync.existsSync(fallback)) return `side/${SIDE_BG_BASE_FILE}`
  return ""
}

export async function saveSideBackgroundImage(buffer, { extHint = ".jpg" } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "")
  if (!buf.length) throw new Error("empty_image_buffer")

  const ext = normalizeExt(extHint)
  const fileName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`
  const filePath = path.join(SIDE_BG_DIR, fileName)

  await fs.mkdir(SIDE_BG_DIR, { recursive: true })
  await fs.writeFile(filePath, buf)

  return {
    fileName,
    filePath,
    relPath: `side/${fileName}`,
  }
}
