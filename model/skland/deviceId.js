import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import config from "../config.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const pluginRoot = path.resolve(__dirname, "..", "..")
const runnerPath = path.join(pluginRoot, "model", "smsdk_runner.cjs")

const cache = new Map()

function exists(p) {
  try {
    return p && fs.existsSync(p)
  } catch {
    return false
  }
}

function guessDefaultSmSdkCandidates() {
  const candidates = []

  // Prefer plugin-local copy (stable even if Desktop source is removed)
  candidates.push(path.join(pluginRoot, "sm.sdk.js"))
  candidates.push(path.join(pluginRoot, "model", "sm.sdk.js"))

  candidates.push(path.join(process.cwd(), "sm.sdk.js"))
  candidates.push(path.join(process.cwd(), "plugins", "EndUID", "utils", "api", "sm.sdk.js"))

  const userProfile = process.env.USERPROFILE
  if (userProfile) {
    candidates.push(path.join(userProfile, "Desktop", "EndUID-main", "EndUID", "utils", "api", "sm.sdk.js"))
    candidates.push(path.join(userProfile, "Desktop", "EndUID", "EndUID", "utils", "api", "sm.sdk.js"))
  }

  return candidates
}

export function resolveSmSdkPath() {
  if (config.smsdk?.smSdkPath && exists(config.smsdk.smSdkPath)) return config.smsdk.smSdkPath
  for (const p of guessDefaultSmSdkCandidates()) if (exists(p)) return p
  return ""
}

function execNodeGetDid({ smsdkPath, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, smsdkPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      reject(new Error("smsdk timeout"))
    }, timeoutMs)

    child.stdout.on("data", d => {
      stdout += d.toString()
    })
    child.stderr.on("data", d => {
      stderr += d.toString()
    })

    child.on("error", err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`smsdk failed (code=${code}): ${stderr || stdout}`))
      const lines = String(stdout || "")
        .trim()
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
      const did = lines[lines.length - 1] || ""
      if (!did) return reject(new Error("smsdk empty did"))
      resolve(did)
    })
  })
}

export async function getDeviceId({ userAgent, acceptLanguage, referer, platform } = {}) {
  const smsdkPath = resolveSmSdkPath()
  if (!smsdkPath) {
    throw new Error("sm.sdk.js not found: 请在 config/enduid-yunzai.yaml 配置 smsdk.smSdkPath")
  }
  if (!exists(runnerPath)) throw new Error(`smsdk runner missing: ${runnerPath}`)

  const cacheSec = Number(config.smsdk?.cacheSec ?? 0) || 0
  const timeoutMs = Number(config.smsdk?.timeoutMs ?? 15000) || 15000

  const cacheKey = JSON.stringify({
    smsdkPath,
    userAgent: userAgent || "",
    acceptLanguage: acceptLanguage || "",
    referer: referer || "",
    platform: platform || "",
  })

  if (cacheSec > 0) {
    const cached = cache.get(cacheKey)
    if (cached && Date.now() - cached.time < cacheSec * 1000) return cached.did
  }

  const env = {
    ...process.env,
    SMSDK_TIMEOUT: String(timeoutMs),
  }
  if (userAgent) env.SMSDK_USER_AGENT = String(userAgent)
  if (acceptLanguage) env.SMSDK_ACCEPT_LANGUAGE = String(acceptLanguage)
  if (referer) env.SMSDK_REFERER = String(referer)
  if (platform) env.SMSDK_PLATFORM = String(platform)

  const did = await execNodeGetDid({ smsdkPath, env, timeoutMs: timeoutMs + 2000 })
  if (cacheSec > 0) cache.set(cacheKey, { did, time: Date.now() })
  return did
}
