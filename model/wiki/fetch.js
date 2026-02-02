import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import fetch from "node-fetch"

import { parseCharWiki, parseHomepage, parseWeaponWiki } from "./parser.js"
import {
  CHAR_CACHE_DIR,
  DETAIL_EXPIRE_SECONDS,
  LIST_CACHE_FILE,
  WEAPON_CACHE_DIR,
  WIKI_BASE_URL,
  WIKI_HOME_URL,
} from "./types.js"

const PLUGIN_NAME = "enduid-yunzai"
const DATA_DIR = path.join(process.cwd(), "plugins", PLUGIN_NAME, "data", "wiki")

const LIST_JSON_PATH = path.join(DATA_DIR, LIST_CACHE_FILE)
const CHAR_DIR = path.join(DATA_DIR, CHAR_CACHE_DIR)
const WEAPON_DIR = path.join(DATA_DIR, WEAPON_CACHE_DIR)

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Upgrade-Insecure-Requests": "1",
  Referer: WIKI_BASE_URL,
}

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

function isDetailExpired(cachePath) {
  if (!fsSync.existsSync(cachePath)) return true
  try {
    const raw = fsSync.readFileSync(cachePath, "utf8")
    const data = safeJsonParse(raw, null)
    const fetchTime = Number(data?.fetch_time || 0)
    if (!fetchTime) return true
    return Math.floor(Date.now() / 1000) - fetchTime > DETAIL_EXPIRE_SECONDS
  } catch {
    return true
  }
}

function isListStale(data) {
  const fetchTime = Number(data?.fetch_time || 0)
  if (!fetchTime) return true

  const ft = new Date(fetchTime * 1000)
  const now = new Date()

  const boundary = new Date(ft)
  boundary.setHours(12, 0, 0, 0)
  if (boundary.getTime() <= ft.getTime()) boundary.setTime(boundary.getTime() + 12 * 3600 * 1000)

  return now.getTime() >= boundary.getTime()
}

let _lock = Promise.resolve()
function withFetchLock(fn) {
  const run = _lock.then(() => fn())
  _lock = run.catch(() => {})
  return run
}

async function fetchPage(url) {
  return withFetchLock(async () => {
    try {
      const resp = await fetch(url, { method: "GET", headers: HEADERS })
      if (!resp.ok) return null
      const html = await resp.text()
      const head = html.slice(0, 500)
      if (head.includes("AccessDeny") || head.includes("Restricted Access")) return null
      return html
    } catch {
      return null
    }
  })
}

async function saveJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
}

async function loadListData() {
  if (!fsSync.existsSync(LIST_JSON_PATH)) return null
  try {
    const raw = await fs.readFile(LIST_JSON_PATH, "utf8")
    const data = safeJsonParse(raw, null)
    return data && typeof data === "object" ? data : null
  } catch {
    return null
  }
}

async function refreshList() {
  const html = await fetchPage(WIKI_HOME_URL)
  if (!html) return null

  const data = parseHomepage(html)
  if (!data) return null

  data.fetch_time = Math.floor(Date.now() / 1000)
  await saveJson(LIST_JSON_PATH, data)
  return data
}

export async function ensureListData() {
  const cached = await loadListData()
  if (!cached || isListStale(cached)) {
    const refreshed = await refreshList()
    return refreshed || cached
  }
  return cached
}

function findInList(data, name, kind) {
  const groups = data && typeof data === "object" ? data[kind] : null
  if (!groups || typeof groups !== "object") return false
  for (const entries of Object.values(groups)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (String(entry?.name || "") === String(name)) return true
    }
  }
  return false
}

export async function getCharWiki(name, { forceRefresh = false } = {}) {
  const list = await ensureListData()
  if (list && !findInList(list, name, "characters")) return null

  const safeName = sanitizeFilename(name)
  if (!safeName) return null
  const cachePath = path.join(CHAR_DIR, `${safeName}.json`)

  if (!forceRefresh && !isDetailExpired(cachePath)) {
    try {
      const raw = await fs.readFile(cachePath, "utf8")
      const data = safeJsonParse(raw, null)
      return data && typeof data === "object" ? data : null
    } catch {}
  }

  const html = await fetchPage(`${WIKI_BASE_URL}${encodeURIComponent(name)}`)
  if (!html) return null

  const wiki = parseCharWiki(html, name)
  if (!wiki) return null

  wiki.fetch_time = Math.floor(Date.now() / 1000)
  await saveJson(cachePath, wiki)
  return wiki
}

export async function getWeaponWiki(name, { forceRefresh = false } = {}) {
  const list = await ensureListData()
  if (list && !findInList(list, name, "weapons")) return null

  const safeName = sanitizeFilename(name)
  if (!safeName) return null
  const cachePath = path.join(WEAPON_DIR, `${safeName}.json`)

  if (!forceRefresh && !isDetailExpired(cachePath)) {
    try {
      const raw = await fs.readFile(cachePath, "utf8")
      const data = safeJsonParse(raw, null)
      return data && typeof data === "object" ? data : null
    } catch {}
  }

  const html = await fetchPage(`${WIKI_BASE_URL}${encodeURIComponent(name)}`)
  if (!html) return null

  const wiki = parseWeaponWiki(html, name)
  if (!wiki) return null

  wiki.fetch_time = Math.floor(Date.now() / 1000)
  await saveJson(cachePath, wiki)
  return wiki
}
