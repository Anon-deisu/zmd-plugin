/**
 * Skland 公告模块。
 *
 * 提供：
 * - 列表/详情抓取（优先 fetch，必要时用 puppeteer 兜底）
 * - 进程内缓存（减少网络请求与渲染压力）
 * - 群订阅 + 定时推送任务（Redis 持久化）
 */
import fetch from "node-fetch"
import puppeteer from "puppeteer"

import cfg from "./config.js"

const GAME_TITLE = "[终末地]"

const SKLAND_ANN_LIST_URL = "https://zonai.skland.com/web/v1/home/index"
const SKLAND_ANN_DETAIL_URL = "https://zonai.skland.com/web/v1/item"
const SKLAND_GAME_ID_ENDFIELD = 3
const SKLAND_CATE_ID_ENDFIELD = 12

// 保留历史 `Yz:EndUID:*` Key：避免老用户订阅/已读记录丢失。
const KEY_ANN_SUB_GROUPS = "Yz:EndUID:Ann:SubGroups"
const KEY_ANN_SEEN_IDS = "Yz:EndUID:Ann:SeenIds"

// 进程内缓存（机器人重启后清空）。
const memCache = {
  list: { ts: 0, data: [] },
  detail: new Map(),
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function uniqBy(items, keyFn) {
  const seen = new Set()
  const out = []
  for (const item of items || []) {
    const k = keyFn(item)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

function pickCoverUrl(item) {
  if (item?.imageCover?.url) return String(item.imageCover.url)
  const imgList = Array.isArray(item?.imageListSlice) ? item.imageListSlice : []
  if (imgList[0]?.url) return String(imgList[0].url)
  const videoList = Array.isArray(item?.videoListSlice) ? item.videoListSlice : []
  const cover = videoList[0]?.cover?.url
  if (cover) return String(cover)
  return ""
}

async function waitMs(page, ms) {
  const delay = Math.max(0, Number(ms) || 0) || 0
  if (!delay) return
  if (page && typeof page.waitForTimeout === "function") return page.waitForTimeout(delay)
  if (page && typeof page.waitFor === "function") return page.waitFor(delay)
  return new Promise(resolve => setTimeout(resolve, delay))
}

function parseAnnListResponse(res, { pageSize }) {
  if (!res || res.code !== 0) return []
  const list = res?.data?.list
  if (!Array.isArray(list)) return []

  const out = []
  for (const entry of list) {
    const item = entry?.item || {}
    const user = entry?.user || {}
    const id = String(item.id || "").trim()
    if (!id) continue

    const createdAtTs = Number(item.publishedAtTs || item.timestamp || 0) || 0
    out.push({
      id,
      title: String(item.title || ""),
      coverUrl: pickCoverUrl(item),
      createdAtTs,
      userName: String(user.nickname || ""),
      userAvatar: String(user.avatar || ""),
      userIpLocation: String(user.latestIpLocation || ""),
      viewKind: item.viewKind,
      gameId: item.gameId,
      cateId: item.cateId,
    })
  }
  return uniqBy(out, x => x.id).slice(0, pageSize)
}

async function fetchJsonSafe(url, { headers, timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { method: "GET", headers: headers || {}, signal: controller.signal })
    if (resp.status !== 200) return null
    const text = await resp.text()
    return safeJsonParse(text, null)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function buildWebHeaders({ referer } = {}) {
  return {
    "User-Agent": cfg.skland?.ua?.web || "Mozilla/5.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: referer || "https://www.skland.com/",
    Origin: "https://www.skland.com",
  }
}

async function fetchAnnListByFetch({ pageSize }) {
  const url = `${SKLAND_ANN_LIST_URL}?gameId=${SKLAND_GAME_ID_ENDFIELD}&cateId=${SKLAND_CATE_ID_ENDFIELD}&page=1&pageSize=${pageSize}`
  const referer = `https://www.skland.com/game/endfield?cateId=${SKLAND_CATE_ID_ENDFIELD}`
  const data = await fetchJsonSafe(url, { headers: buildWebHeaders({ referer }), timeoutMs: 20000 })
  const list = parseAnnListResponse(data, { pageSize })
  return list.length ? list : []
}

async function fetchAnnDetailByFetch(postId) {
  const url = `${SKLAND_ANN_DETAIL_URL}?id=${encodeURIComponent(postId)}`
  const referer = `https://www.skland.com/article?id=${encodeURIComponent(postId)}`
  return fetchJsonSafe(url, { headers: buildWebHeaders({ referer }), timeoutMs: 20000 })
}

async function fetchAnnListByPuppeteer({ pageSize }) {
  // puppeteer 兜底：用于处理偶发的反爬/跨域限制导致 fetch 无法直接拿到接口数据。
  const apiResponses = []

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  })
  try {
    const page = await browser.newPage()
    page.on("response", async response => {
      const url = response.url()
      if (!url.includes("home/index") || !url.includes(`gameId=${SKLAND_GAME_ID_ENDFIELD}`)) return
      try {
        apiResponses.push(await response.json())
      } catch {}
    })

    await page.goto(`https://www.skland.com/game/endfield?cateId=${SKLAND_CATE_ID_ENDFIELD}`, {
      waitUntil: "networkidle2",
      timeout: 30000,
    })
    await waitMs(page, 3000)

    for (let i = 0; i < 6; i++) {
      await page.evaluate("window.scrollBy(0, 1200)")
      await waitMs(page, 1200)
    }

    await page.close()
  } finally {
    await browser.close()
  }

  const merged = []
  for (const res of apiResponses) merged.push(...parseAnnListResponse(res, { pageSize }))
  return uniqBy(merged, x => x.id).slice(0, pageSize)
}

async function fetchAnnDetailByPuppeteer(postId) {
  let captured = null

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  })
  try {
    const page = await browser.newPage()
    page.on("response", async response => {
      const url = response.url()
      if (!url.includes("web/v1/item") || !url.includes(`id=${postId}`)) return
      try {
        captured = await response.json()
      } catch {}
    })

    await page.goto(`https://www.skland.com/article?id=${encodeURIComponent(postId)}`, {
      waitUntil: "networkidle2",
      timeout: 30000,
    })
    await waitMs(page, 5000)
    await page.close()
  } finally {
    await browser.close()
  }

  return captured
}

export async function fetchAnnList({ pageSize = 18, useCache = true } = {}) {
  const cacheSec = Math.max(0, Number(cfg.ann?.listCacheSec) || 600)
  const now = Date.now()
  if (useCache && cacheSec > 0 && memCache.list.data.length && now - memCache.list.ts < cacheSec * 1000) {
    return memCache.list.data
  }

  const size = Math.max(1, Number(pageSize) || 18)
  let list = await fetchAnnListByFetch({ pageSize: size })
  if (!list.length && cfg.ann?.enablePuppeteerFallback !== false) {
    try {
      list = await fetchAnnListByPuppeteer({ pageSize: size })
    } catch (err) {
      logger?.warn?.("[zmd-plugin] 公告 puppeteer 获取失败", err)
    }
  }

  memCache.list = { ts: now, data: list }
  return list
}

export async function fetchAnnDetail(postId, { useCache = true } = {}) {
  const id = String(postId || "").trim()
  if (!id) return null
  if (useCache && memCache.detail.has(id)) return memCache.detail.get(id)

  let data = await fetchAnnDetailByFetch(id)
  if ((!data || data.code !== 0) && cfg.ann?.enablePuppeteerFallback !== false) {
    try {
      data = await fetchAnnDetailByPuppeteer(id)
    } catch (err) {
      logger?.warn?.("[zmd-plugin] 公告详情 puppeteer 获取失败", err)
    }
  }

  if (!data || data.code !== 0) return null

  const item = data?.data?.item || {}
  const user = data?.data?.user || {}

  const images = []
  for (const img of item?.imageListSlice || []) {
    images.push({
      url: String(img?.url || ""),
      width: Number(img?.width || 0) || 0,
      height: Number(img?.height || 0) || 0,
    })
  }

  const videos = []
  for (const v of item?.videoListSlice || []) {
    videos.push({
      url: String(v?.url || ""),
      coverUrl: String(v?.cover?.url || ""),
    })
  }

  const textContent = []
  for (const t of item?.textSlice || []) textContent.push(String(t?.c || ""))

  const createdAtTs = Number(item.publishedAtTs || item.timestamp || 0) || 0

  const detail = {
    id: String(item.id || id),
    title: String(item.title || ""),
    createdAtTs,
    userName: String(user.nickname || ""),
    userAvatar: String(user.avatar || ""),
    userIpLocation: String(user.latestIpLocation || ""),
    images,
    videos,
    textContent,
    format: String(item.format || ""),
  }

  memCache.detail.set(id, detail)
  return detail
}

export async function subscribeAnnGroup(groupId) {
  const gid = String(groupId || "").trim()
  if (!gid) return
  try {
    await redis.sAdd(KEY_ANN_SUB_GROUPS, gid)
  } catch {}
}

export async function unsubscribeAnnGroup(groupId) {
  const gid = String(groupId || "").trim()
  if (!gid) return
  try {
    await redis.sRem(KEY_ANN_SUB_GROUPS, gid)
  } catch {}
}

export async function listSubscribedAnnGroups() {
  try {
    return (await redis.sMembers(KEY_ANN_SUB_GROUPS)) || []
  } catch {
    return []
  }
}

export async function clearAnnMemoryCache() {
  memCache.list = { ts: 0, data: [] }
  memCache.detail.clear()
}

export async function getSeenAnnIds() {
  try {
    const raw = await redis.get(KEY_ANN_SEEN_IDS)
    const parsed = raw ? safeJsonParse(raw, []) : []
    return Array.isArray(parsed) ? parsed.map(x => String(x)) : []
  } catch {
    return []
  }
}

export async function setSeenAnnIds(ids) {
  const list = Array.isArray(ids) ? ids.map(x => String(x)).filter(Boolean) : []
  try {
    await redis.set(KEY_ANN_SEEN_IDS, JSON.stringify(list))
  } catch {}
}

let running = false
export async function runAnnPushTask() {
  if (!cfg.ann?.enableTask) return
  // 防止 cron 重入（网络慢或 puppeteer 兜底时，单次执行可能比较久）。
  if (running) return
  running = true
  try {
    const groups = await listSubscribedAnnGroups()
    if (!groups.length) return

    const pageSize = Math.max(1, Number(cfg.ann?.pageSize) || 18)
    const list = await fetchAnnList({ pageSize, useCache: false })
    if (!list.length) return

    const seen = await getSeenAnnIds()
    const ids = list.map(x => String(x.id)).filter(Boolean)
    if (!seen.length) {
      await setSeenAnnIds(ids)
      return
    }

    const newIds = ids.filter(id => !seen.includes(id))
    if (!newIds.length) return

    await setSeenAnnIds(uniqBy([...newIds, ...seen], x => x).slice(0, 200))

    const lines = [
      `${GAME_TITLE} 新公告 ${newIds.length} 条：`,
      ...newIds
        .map(id => {
          const item = list.find(x => String(x.id) === id)
          return item ? `- (${id}) ${item.title || ""}` : `- (${id})`
        })
        .slice(0, 10),
      `${GAME_TITLE} 查看：${cfg.cmd?.prefix || "#zmd"}公告 <id>`,
    ].join("\n")

    for (const gid of groups) {
      try {
        await Bot.pickGroup(String(gid)).sendMsg(lines)
      } catch (err) {
        logger?.warn?.("[zmd-plugin] 公告推送失败", gid, err)
      }
    }
  } finally {
    running = false
  }
}
