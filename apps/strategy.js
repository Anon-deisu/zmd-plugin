import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import common from "../../../lib/common/common.js"
import plugin from "../../../lib/plugins/plugin.js"

import cfg from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const GAME_TITLE = "[终末地]"
const GITHUB_REPO = "Entropy-Increase-Team/Endfield-Resource"
const REDIS_UPLOAD_KEY = userId => `Yz:EndUID:StrategyUpload:${userId}`

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function isSubPath(parent, child) {
  const parentPath = path.resolve(parent)
  const childPath = path.resolve(child)
  const parentLower = parentPath.toLowerCase()
  const childLower = childPath.toLowerCase()
  return childLower === parentLower || childLower.startsWith(parentLower + path.sep.toLowerCase())
}

async function getSegment() {
  if (global.segment) return global.segment
  try {
    const mod = await import("icqq")
    return mod.segment
  } catch {}
  try {
    const mod = await import("oicq")
    return mod.segment
  } catch {}
  return null
}

function isUnknownAuthor(name) {
  const s = String(name || "").trim()
  if (!s) return true
  return s === "未知作者" || s === "unknown" || s === "Unknown" || s.includes("未知")
}

export class strategy extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: "enduid-yunzai-strategy",
      dsc: "终末地攻略查询与资源管理",
      event: "message",
      priority: 4990,
      rule: [
        { reg: "^#?(?:终末地|zmd)\\s*(.*?)攻略$", fnc: "queryStrategy" },
        { reg: "^#?(?:终末地|zmd)\\s*攻略资源(下载|(强制)?更新)$", fnc: "downloadOrUpdateResources" },
        { reg: "^#?(?:终末地|zmd)\\s*攻略上传\\s+(.+)$", fnc: "uploadStrategy" },
        { reg: "^#?(?:终末地|zmd)\\s*攻略上传干员\\s+(.+)$", fnc: "receiveCharacterName" },
        { reg: "^#?(?:终末地|zmd)\\s*攻略删除\\s+(.+)$", fnc: "deleteStrategy" },
      ],
    })

    this.strategyDir = path.resolve(__dirname, "..", "data", "strategyimg")
    this.indexFile = path.join(this.strategyDir, "index.json")
    this.characterNamesCache = null
  }

  getCmdPrefixHint() {
    return String(cfg.cmd?.prefix || "#zmd")
  }

  getStrategyName(e = this.e) {
    let msg = String(e?.msg || "").trim()
    msg = msg.replace(/^#?(?:终末地|zmd)\s*/i, "")
    msg = msg.replace(/攻略$/, "").trim()
    return msg
  }

  ensureStrategyDir() {
    if (!fs.existsSync(this.strategyDir)) fs.mkdirSync(this.strategyDir, { recursive: true })
  }

  loadIndex() {
    try {
      const content = fs.readFileSync(this.indexFile, "utf-8")
      return safeJsonParse(content, { strategies: [] }) || { strategies: [] }
    } catch (err) {
      logger.warn("[enduid-yunzai][strategy] 读取 index.json 失败", err)
      return { strategies: [] }
    }
  }

  findAllStrategies(index, name) {
    const strategies = Array.isArray(index?.strategies) ? index.strategies : []
    if (!strategies.length) return []

    const normalized = String(name || "").trim().toLowerCase()
    if (!normalized) return []

    const dedup = list => {
      const seen = new Set()
      const out = []
      for (const s of list) {
        const id = String(s?.id || "")
        const key = id || `${s?.title || ""}@@${s?.url || ""}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(s)
      }
      return out
    }

    const exact = strategies.filter(s => {
      const title = String(s?.title || "").trim().toLowerCase()
      const characterName = String(s?.characterName || "").trim().toLowerCase()
      return title === normalized || characterName === normalized
    })
    if (exact.length) return dedup(exact)

    const contains = strategies.filter(s => {
      const title = String(s?.title || "").trim().toLowerCase()
      const characterName = String(s?.characterName || "").trim().toLowerCase()
      return title.includes(normalized) || characterName.includes(normalized)
    })
    if (contains.length) return dedup(contains)

    const chars = normalized.split("").filter(c => c.trim())
    if (!chars.length) return []
    const threshold = Math.max(1, Math.ceil(chars.length * 0.8))

    const fuzzy = strategies.filter(s => {
      const title = String(s?.title || "").trim().toLowerCase()
      const characterName = String(s?.characterName || "").trim().toLowerCase()
      const matchInTitle = chars.filter(c => title.includes(c)).length
      const matchInChar = chars.filter(c => characterName.includes(c)).length
      return matchInTitle >= threshold || matchInChar >= threshold
    })
    return dedup(fuzzy)
  }

  getStrategyList(index) {
    const strategies = Array.isArray(index?.strategies) ? index.strategies : []
    if (!strategies.length) return "  （暂无攻略）"

    const names = [...new Set(strategies.map(s => String(s?.characterName || "").trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "zh-Hans-CN"),
    )
    return names.map(n => `  - ${n}`).join("\n")
  }

  async getCharacterNames() {
    if (this.characterNamesCache) return this.characterNamesCache
    try {
      if (!fs.existsSync(this.indexFile)) return null
      const index = this.loadIndex()
      const names = [...new Set((index?.strategies || []).map(s => String(s?.characterName || "").trim()).filter(Boolean))]
      if (names.length) {
        this.characterNamesCache = names
        return names
      }
    } catch {}
    return null
  }

  async extractCharacterName(title) {
    const t = String(title || "")
    const names = await this.getCharacterNames()
    if (Array.isArray(names) && names.length) {
      for (const name of names) {
        if (name && t.includes(name)) return name
      }
    }
    return "其他"
  }

  resolveLocalImages(strategy) {
    const base = this.strategyDir
    const images = Array.isArray(strategy?.images) ? strategy.images : []
    const available = []

    for (const img of images) {
      const candidates = []
      if (img?.relativePath && typeof img.relativePath === "string") {
        const rp = img.relativePath.replace(/\\/g, "/")
        const parts = rp.split("/").filter(Boolean)
        candidates.push(path.join(base, ...parts))
      }
      if (strategy?.characterName && img?.filename) {
        candidates.push(path.join(base, String(strategy.characterName), String(img.filename)))
      }
      if (img?.filename && candidates.length === 0) {
        candidates.push(path.join(base, String(img.filename)))
      }

      let found = null
      for (const candidate of candidates) {
        const normalized = path.normalize(candidate)
        if (!isSubPath(base, normalized)) continue
        if (fs.existsSync(normalized)) {
          found = normalized
          break
        }
      }
      if (found) available.push(found)
    }
    return available
  }

  async queryStrategy(e = this.e) {
    const name = this.getStrategyName(e)
    const prefix = this.getCmdPrefixHint()

    if (!name) {
      const hint = `${GAME_TITLE} 请提供攻略名称，例如：${prefix}黎风攻略`
      await e.reply(hint, true)
      if (fs.existsSync(this.indexFile)) {
        const index = this.loadIndex()
        await e.reply(`${GAME_TITLE} 可用攻略列表：\n${this.getStrategyList(index)}`, true)
      }
      return true
    }

    if (!fs.existsSync(this.indexFile)) {
      await e.reply(`${GAME_TITLE} 攻略资源未下载，请先使用 ${prefix}攻略资源下载`, true)
      return true
    }

    const index = this.loadIndex()
    const matches = this.findAllStrategies(index, name)
    if (!matches.length) {
      await e.reply(`${GAME_TITLE} 未找到攻略：${name}\n可用攻略列表：\n${this.getStrategyList(index)}`, true)
      return true
    }

    if (matches.length === 1) {
      await this.sendStrategyImages(matches[0], e)
      return true
    }

    const seg = await getSegment()
    const forwardMessages = []

    for (let i = 0; i < matches.length; i++) {
      const s = matches[i]
      let info = `[${i + 1}/${matches.length}] 标题：${s?.title || "-"}\n`
      const authorName = String(s?.author?.name || "").trim()
      if (authorName && !isUnknownAuthor(authorName)) info += `作者：${authorName}\n`
      if (s?.url) info += `来源：${s.url}`

      const localImages = this.resolveLocalImages(s)
      if (seg && localImages.length) {
        forwardMessages.push([info, seg.image(localImages[0])])
        for (let j = 1; j < localImages.length; j++) forwardMessages.push([seg.image(localImages[j])])
      } else if (!localImages.length) {
        forwardMessages.push([`${info}\n（⚠️ 本地未找到图片，请先 ${prefix}攻略资源下载）`])
      } else {
        forwardMessages.push([info])
      }
    }

    const characterName = String(matches[0]?.characterName || "其他")
    const forwardMsg = common.makeForwardMsg(e, forwardMessages, `${characterName} - 攻略列表 - 共${matches.length}个`)
    await e.reply(forwardMsg)
    return true
  }

  async sendStrategyImages(strategy, e = this.e) {
    const prefix = this.getCmdPrefixHint()
    const seg = await getSegment()

    const images = this.resolveLocalImages(strategy)
    let info = `标题：${strategy?.title || "-"}\n`
    const authorName = String(strategy?.author?.name || "").trim()
    if (authorName && !isUnknownAuthor(authorName)) info += `作者：${authorName}\n`
    if (strategy?.url) info += `来源：${strategy.url}`

    if (!seg) {
      await e.reply(`${GAME_TITLE} 当前环境无法加载 segment（oicq/icqq），无法发送图片`, true)
      return true
    }

    if (!images.length) {
      await e.reply(info, true)
      await e.reply(`${GAME_TITLE} ⚠️ 本地未找到图片，请先 ${prefix}攻略资源下载`, true)
      return true
    }

    const forwardMessages = []
    forwardMessages.push([info, seg.image(images[0])])
    for (let i = 1; i < images.length; i++) forwardMessages.push([seg.image(images[i])])

    const characterName = String(strategy?.characterName || "其他")
    const forwardMsg = common.makeForwardMsg(e, forwardMessages, `${characterName} - 攻略图 - ${images.length}张`)
    await e.reply(forwardMsg)
    return true
  }

  async downloadOrUpdateResources(e = this.e) {
    const msg = String(e?.msg || "")
    const isDownload = msg.includes("下载")
    const isForce = msg.includes("强制")

    const prefix = this.getCmdPrefixHint()
    if (!isDownload && !fs.existsSync(this.indexFile)) {
      await e.reply(`${GAME_TITLE} 攻略资源未下载，请先使用 ${prefix}攻略资源下载`, true)
      return true
    }

    const forwardMessages = []
    forwardMessages.push([isDownload ? "开始下载攻略资源…" : isForce ? "开始强制更新攻略资源…" : "开始检查攻略资源更新…"])

    try {
      this.ensureStrategyDir()

      let indexData
      try {
        forwardMessages.push(["正在从 GitHub 下载 index.json…"])
        indexData = await this.downloadFromGitHub(GITHUB_REPO, "index.json")
      } catch (err) {
        logger.error("[enduid-yunzai][strategy] GitHub 下载 index.json 失败", err)
        forwardMessages.push([`GitHub 下载失败：${err?.message || err}`])
        await e.reply(common.makeForwardMsg(e, forwardMessages, "攻略资源"))
        return true
      }

      if (!indexData || !Array.isArray(indexData.strategies)) {
        forwardMessages.push(["下载的 index.json 格式错误"])
        await e.reply(common.makeForwardMsg(e, forwardMessages, "攻略资源"))
        return true
      }

      let oldIndex = null
      if (!isDownload) oldIndex = this.loadIndex()

      const strategiesToProcess = isDownload || isForce ? indexData.strategies : this.diffStrategies(oldIndex, indexData)
      if (!strategiesToProcess.length && !isDownload && !isForce) {
        forwardMessages.push(["没有发现新的攻略，资源已是最新版本"])
        await e.reply(common.makeForwardMsg(e, forwardMessages, "攻略资源更新"))
        return true
      }

      let successCount = 0
      let failCount = 0

      for (let i = 0; i < strategiesToProcess.length; i++) {
        const s = strategiesToProcess[i]
        let downloadedCount = 0
        try {
          for (const img of s.images || []) {
            const rel = this.getRelativePath(s, img)
            if (!rel) continue

            const localPath = path.join(this.strategyDir, rel)
            const normalized = path.normalize(localPath)
            if (!isSubPath(this.strategyDir, normalized)) continue

            if (fs.existsSync(normalized) && !isForce) {
              downloadedCount++
              continue
            }

            const url = this.getImageUrlFromRepo(GITHUB_REPO, rel)
            const response = await fetch(url, {
              headers: {
                "User-Agent": "Mozilla/5.0",
                Referer: "https://github.com/",
              },
            })
            if (!response.ok) continue

            const dir = path.dirname(normalized)
            if (!isSubPath(this.strategyDir, dir)) continue
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

            fs.writeFileSync(normalized, Buffer.from(await response.arrayBuffer()))
            downloadedCount++
          }

          if (downloadedCount > 0) {
            successCount++
            forwardMessages.push([`[${i + 1}/${strategiesToProcess.length}] ✅ ${s.title || "-"} - ${downloadedCount} 张`])
          } else {
            failCount++
            forwardMessages.push([`[${i + 1}/${strategiesToProcess.length}] ⚠️ ${s.title || "-"} - 未下载到图片`])
          }
        } catch (err) {
          failCount++
          forwardMessages.push([`[${i + 1}/${strategiesToProcess.length}] ❌ ${s.title || "-"} - ${err?.message || err}`])
        }
      }

      const finalIndex = isDownload || isForce ? indexData : this.mergeIndex(oldIndex, strategiesToProcess)
      finalIndex.version = Date.now()
      finalIndex.updatedAt = new Date().toISOString()
      fs.writeFileSync(this.indexFile, JSON.stringify(finalIndex, null, 2), "utf-8")
      this.characterNamesCache = null

      forwardMessages.push([isDownload ? `下载完成：成功 ${successCount}，失败 ${failCount}` : `更新完成：成功 ${successCount}，失败 ${failCount}`])

      const title = isDownload ? "攻略资源下载" : isForce ? "攻略资源强制更新" : "攻略资源更新"
      await e.reply(common.makeForwardMsg(e, forwardMessages, title))
      return true
    } catch (err) {
      logger.error("[enduid-yunzai][strategy] 资源处理失败", err)
      forwardMessages.push([`处理失败：${err?.message || err}`])
      await e.reply(common.makeForwardMsg(e, forwardMessages, "攻略资源"))
      return true
    }
  }

  diffStrategies(oldIndex, newIndex) {
    const oldIds = new Set((oldIndex?.strategies || []).map(s => String(s?.id || "")).filter(Boolean))
    return (newIndex?.strategies || []).filter(s => !oldIds.has(String(s?.id || "")))
  }

  mergeIndex(oldIndex, appendStrategies) {
    const base = oldIndex && typeof oldIndex === "object" ? oldIndex : { strategies: [] }
    const out = {
      ...base,
      strategies: [...(base.strategies || []), ...(appendStrategies || [])],
    }
    const seen = new Set()
    out.strategies = out.strategies.filter(s => {
      const id = String(s?.id || "")
      const key = id || `${s?.title || ""}@@${s?.url || ""}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return out
  }

  getRelativePath(strategy, img) {
    const rp = String(img?.relativePath || "").trim()
    if (rp) return rp.replace(/\\/g, "/").replace(/^\/+/, "")

    const characterName = String(strategy?.characterName || "其他").replace(/[\\/]/g, "_")
    const filename = String(img?.filename || "").replace(/[\\/]/g, "_")
    if (!filename) return ""
    return `${characterName}/${filename}`
  }

  async uploadStrategy(e = this.e) {
    if (!e.isMaster) {
      await e.reply(`${GAME_TITLE} 仅主人可用`, true)
      return true
    }

    this.ensureStrategyDir()

    let imageUrl = ""
    let imageBuffer = null
    const imageMsg = e.message?.find(m => m.type === "image")
    if (imageMsg) {
      try {
        const url = imageMsg.url || imageMsg.file
        if (url) {
          const response = await fetch(url)
          if (response.ok) {
            imageBuffer = Buffer.from(await response.arrayBuffer())
            imageUrl = String(url)
          }
        }
      } catch (err) {
        logger.warn("[enduid-yunzai][strategy] 提取消息图片失败", err)
      }
    }

    const msg = String(e.msg || "").trim()
    const content = msg.replace(/^#?(?:终末地|zmd)\s*攻略上传\s*/i, "").trim()
    const urlMatch = content.match(/https?:\/\/[^\s]+/)
    if (!urlMatch) {
      await e.reply(`${GAME_TITLE} 格式错误：${this.getCmdPrefixHint()}攻略上传 [干员(可选)] [标题(可选)] [作者(可选)] [链接] [图片链接]`, true)
      return true
    }

    const url = urlMatch[0]
    const urlIndex = content.indexOf(url)
    const afterUrl = content.slice(urlIndex + url.length).trim()
    const imageUrlFromText = (afterUrl.match(/https?:\/\/[^\s]+/) || [])[0] || ""

    const beforeUrl = content.slice(0, urlIndex).trim()
    const parts = beforeUrl.split(/\s+/).filter(Boolean)

    let characterName = parts[0] || ""
    let title = parts[1] || ""
    let author = parts[2] || ""

    if (!characterName) {
      if (!title) {
        const info = await this.getAuthorAndTitleFromUrl(url)
        title = info.title
      }
      if (title) characterName = await this.extractCharacterName(title)
      if (!characterName || characterName === "其他") {
        const cache = {
          url,
          imageUrl: imageUrl || imageUrlFromText,
          title,
          author,
          imageBufferBase64: imageBuffer ? imageBuffer.toString("base64") : "",
        }
        await redis.set(REDIS_UPLOAD_KEY(e.user_id), JSON.stringify(cache), { EX: 300 })
        await e.reply(`${GAME_TITLE} 无法自动识别干员，请发送：${this.getCmdPrefixHint()}攻略上传干员 <干员名>`, true)
        this.setContext("receiveCharacterName")
        return true
      }
    }

    if (!imageUrl && imageUrlFromText) imageUrl = imageUrlFromText
    if (!imageUrl && !imageBuffer) {
      await e.reply(`${GAME_TITLE} 请提供图片链接或在消息中附带图片`, true)
      return true
    }

    if (!imageBuffer && imageUrl) {
      const response = await fetch(imageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://www.bilibili.com/",
        },
      })
      if (response.ok) imageBuffer = Buffer.from(await response.arrayBuffer())
    }
    if (!imageBuffer) {
      await e.reply(`${GAME_TITLE} 图片下载失败`, true)
      return true
    }

    const index = this.loadIndex()

    const allImageUrls = new Set()
    for (const s of index.strategies || []) {
      for (const img of s.images || []) if (img?.url) allImageUrls.add(String(img.url))
    }
    if (imageUrl && allImageUrls.has(imageUrl)) {
      await e.reply(`${GAME_TITLE} 图片已存在（疑似重复上传）`, true)
      return true
    }

    let finalTitle = title
    let finalAuthor = author
    if (!finalTitle || !finalAuthor) {
      const info = await this.getAuthorAndTitleFromUrl(url)
      if (!finalTitle) finalTitle = info.title
      if (!finalAuthor) finalAuthor = info.author
    }
    if (!finalTitle) {
      await e.reply(`${GAME_TITLE} 无法获取标题，请手动补全`, true)
      return true
    }

    const imageId = `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
    const safeCharacterName = String(characterName || "其他").replace(/[^\w\u4e00-\u9fa5]/g, "_")
    const safeAuthorName = String(finalAuthor || "未知作者").replace(/[^\w\u4e00-\u9fa5]/g, "_")
    const filename = `${safeCharacterName}_${safeAuthorName}_${imageId}.png`

    const characterDir = path.join(this.strategyDir, characterName || "其他")
    if (!isSubPath(this.strategyDir, characterDir)) {
      await e.reply(`${GAME_TITLE} 干员名称不合法`, true)
      return true
    }
    if (!fs.existsSync(characterDir)) fs.mkdirSync(characterDir, { recursive: true })

    const filePath = path.join(characterDir, filename)
    if (!isSubPath(this.strategyDir, filePath)) {
      await e.reply(`${GAME_TITLE} 文件路径不合法`, true)
      return true
    }
    fs.writeFileSync(filePath, imageBuffer)

    const newStrategy = {
      id: (url.match(/\d+$/) || [])[0] || Date.now().toString(),
      title: finalTitle,
      url,
      author: { name: finalAuthor || "未知作者" },
      characterName: characterName || "其他",
      images: [
        {
          id: imageId,
          filename,
          relativePath: `${characterName || "其他"}/${filename}`,
          url: imageUrl,
          size: "unknown",
        },
      ],
      crawledAt: new Date().toISOString(),
    }

    index.strategies = Array.isArray(index.strategies) ? index.strategies : []
    index.strategies.push(newStrategy)
    index.version = Date.now()
    index.updatedAt = new Date().toISOString()
    fs.writeFileSync(this.indexFile, JSON.stringify(index, null, 2), "utf-8")
    this.characterNamesCache = null

    await e.reply(`${GAME_TITLE} 攻略上传成功！\n干员：${characterName}\n标题：${finalTitle}\n作者：${finalAuthor || "未知作者"}`, true)
    return true
  }

  async receiveCharacterName(e = this.e) {
    if (!e.isMaster) {
      await e.reply(`${GAME_TITLE} 仅主人可用`, true)
      return true
    }

    const cacheText = await redis.get(REDIS_UPLOAD_KEY(e.user_id))
    if (!cacheText) {
      await e.reply(`${GAME_TITLE} 上传会话已过期，请重新发送`, true)
      this.finish("receiveCharacterName")
      return true
    }

    const cache = safeJsonParse(cacheText, null)
    if (!cache) {
      await redis.del(REDIS_UPLOAD_KEY(e.user_id))
      this.finish("receiveCharacterName")
      await e.reply(`${GAME_TITLE} 上传会话已损坏，请重新发送`, true)
      return true
    }

    const msg = String(e.msg || "").trim()
    const m = msg.match(/^#?(?:终末地|zmd)\s*攻略上传干员\s*(.*)$/i)
    const characterName = String((m && m[1]) || msg).trim()
    if (!characterName) {
      await e.reply(`${GAME_TITLE} 请提供干员名称，例如：${this.getCmdPrefixHint()}攻略上传干员 莱万汀`, true)
      return true
    }

    let imageBuffer = null
    if (cache.imageBufferBase64) imageBuffer = Buffer.from(String(cache.imageBufferBase64), "base64")
    if (!imageBuffer && cache.imageUrl) {
      const response = await fetch(cache.imageUrl)
      if (response.ok) imageBuffer = Buffer.from(await response.arrayBuffer())
    }
    if (!imageBuffer) {
      await redis.del(REDIS_UPLOAD_KEY(e.user_id))
      this.finish("receiveCharacterName")
      await e.reply(`${GAME_TITLE} 图片下载失败`, true)
      return true
    }

    const reconstructed = `${this.getCmdPrefixHint()}攻略上传 ${characterName} ${cache.title || ""} ${cache.author || ""} ${cache.url || ""} ${
      cache.imageUrl || ""
    }`.trim()
    e.msg = reconstructed
    e.message = (e.message || []).filter(m2 => m2.type !== "image")
    try {
      await redis.del(REDIS_UPLOAD_KEY(e.user_id))
      this.finish("receiveCharacterName")
      return await this.uploadStrategy(e)
    } catch (err) {
      await redis.del(REDIS_UPLOAD_KEY(e.user_id))
      this.finish("receiveCharacterName")
      await e.reply(`${GAME_TITLE} 上传失败：${err?.message || err}`, true)
      return true
    }
  }

  async deleteStrategy(e = this.e) {
    if (!e.isMaster) {
      await e.reply(`${GAME_TITLE} 仅主人可用`, true)
      return true
    }

    const msg = String(e.msg || "").trim()
    const content = msg.replace(/^#?(?:终末地|zmd)\s*攻略删除\s*/i, "").trim()
    const url = (content.match(/https?:\/\/[^\s]+/) || [])[0] || ""
    if (!url) {
      await e.reply(`${GAME_TITLE} 格式错误：${this.getCmdPrefixHint()}攻略删除 <链接>`, true)
      return true
    }

    const index = this.loadIndex()
    const idx = (index.strategies || []).findIndex(s => String(s?.url || "") === url)
    if (idx < 0) {
      await e.reply(`${GAME_TITLE} 未找到该攻略`, true)
      return true
    }

    const strategy = index.strategies[idx]
    for (const img of strategy.images || []) {
      if (!img?.relativePath) continue
      const filePath = path.join(this.strategyDir, String(img.relativePath))
      const normalized = path.normalize(filePath)
      if (!isSubPath(this.strategyDir, normalized)) continue
      try {
        if (fs.existsSync(normalized)) fs.unlinkSync(normalized)
      } catch (err) {
        logger.warn("[enduid-yunzai][strategy] 删除图片失败", err)
      }
    }

    index.strategies.splice(idx, 1)
    index.version = Date.now()
    index.updatedAt = new Date().toISOString()
    fs.writeFileSync(this.indexFile, JSON.stringify(index, null, 2), "utf-8")
    this.characterNamesCache = null

    await e.reply(`${GAME_TITLE} 攻略删除成功！\n标题：${strategy?.title || "-"}`, true)
    return true
  }

  async getAuthorAndTitleFromUrl(url) {
    try {
      let aid = ""
      let bvid = ""
      const bvMatch = String(url).match(/BV[a-zA-Z0-9]+/i)
      if (bvMatch) bvid = bvMatch[0]
      const avMatch = String(url).match(/av(\d+)/i)
      if (avMatch) aid = avMatch[1]
      if (!aid && !bvid) return { author: "未知作者", title: "" }

      const apiUrl = bvid
        ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
        : `https://api.bilibili.com/x/web-interface/view?aid=${aid}`

      const response = await fetch(apiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://www.bilibili.com/",
        },
      })
      if (!response.ok) return { author: "未知作者", title: "" }

      const data = await response.json()
      if (data?.code !== 0 || !data?.data) return { author: "未知作者", title: "" }

      const title = String(data.data.title || "")
      let authors = []
      if (Array.isArray(data.data.staff) && data.data.staff.length) authors = data.data.staff.map(s => s?.name).filter(Boolean)
      if (!authors.length && data.data.owner?.name) authors = [data.data.owner.name]
      const author = authors.length ? authors.join("、") : "未知作者"
      return { author, title }
    } catch (err) {
      logger.warn("[enduid-yunzai][strategy] 获取作者/标题失败", err)
      return { author: "未知作者", title: "" }
    }
  }

  async downloadFromGitHub(repo, filePath) {
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`
    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/vnd.github.v3.raw",
      },
    })
    if (!response.ok) throw new Error(`GitHub API 错误: ${response.status} ${response.statusText}`)

    const text = await response.text()
    const data = safeJsonParse(text, null)
    if (!data) throw new Error("解析 JSON 失败")
    return data
  }

  getImageUrlFromRepo(repo, relativePath) {
    const rel = String(relativePath || "").replace(/^\/+/, "")
    return `https://raw.githubusercontent.com/${repo}/main/${rel}`
  }
}
