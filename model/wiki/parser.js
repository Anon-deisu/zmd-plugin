/**
 * Wiki HTML 解析器。
 *
 * biligame wiki 并非标准 JSON API，这里通过字符串/正则启发式 + 简易 HTML 分析
 * 提取结构化数据。
 */
import { BANNER_CYCLE_SECONDS } from "./types.js"

const STAR_RARITY_MAP = {
  "6星": 6,
  "5星": 5,
  "4星": 4,
  "3星": 3,
}

const STAR_IMG_RARITY_MAP = {
  "居中6星.png": 6,
  "居中5星.png": 5,
  "居中4星.png": 4,
  "居中3星.png": 3,
}

const CHAR_RARITY_ALT_MAP = {
  "6星.png": 6,
  "5星.png": 5,
  "4星.png": 4,
  "3星.png": 3,
}

const WEAPON_RARITY_ALT_MAP = {
  "橙色.png": 6,
  "金色.png": 5,
  "紫色.png": 4,
  "蓝色.png": 3,
}

function decodeHtml(text) {
  const s = String(text || "")
  // 简化版实体解码：满足 wiki 页面中常见的转义即可。
  return s
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
}

function stripTags(html) {
  let s = String(html || "")
  // wiki 页面可能夹带脚本/样式，先剔除再做纯文本抽取。
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "")
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "")
  // 将常见的“换行语义”标签替换为 \n，便于后续 split/trim。
  s = s.replace(/<br\s*\/?>/gi, "\n")
  s = s.replace(/<\/(p|div|tr|li|table|tbody|thead|section)>/gi, "\n")
  s = s.replace(/<[^>]+>/g, "")
  s = decodeHtml(s)
  s = s.replace(/\u00a0/g, " ")
  s = s.replace(/[ \t\r]+/g, " ")
  s = s.replace(/\n\s*\n+/g, "\n")
  return s.trim()
}

function splitList(text) {
  const parts = String(text || "")
    .split(/[,，、]/g)
    .map(s => s.trim())
    .filter(Boolean)
  return parts
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function cleanTextBlock(text) {
  return String(text || "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n")
}

function parseAttrs(tag) {
  const attrs = {}
  // 只解析双引号/单引号包裹的属性值，够用且更稳。
  const re = /([:\w-]+)\s*=\s*(\"([^\"]*)\"|'([^']*)')/g
  let m
  while ((m = re.exec(tag))) {
    const key = m[1]
    const val = m[3] ?? m[4] ?? ""
    attrs[key] = val
  }
  return attrs
}

function normalizeUrl(url) {
  const u = String(url || "").trim()
  if (!u) return ""
  if (u.startsWith("//")) return `https:${u}`
  return u
}

function bestImgUrl(attrs) {
  const srcset = String(attrs.srcset || "").trim()
  if (srcset) {
    // srcset: "url 1x, url 2x" -> 取倍率最大的那张。
    let best = ""
    let bestScale = 0
    for (const partRaw of srcset.split(",")) {
      const part = partRaw.trim()
      if (!part) continue
      const pieces = part.split(/\s+/).filter(Boolean)
      const url = normalizeUrl(pieces[0] || "")
      const scaleStr = String(pieces[1] || "").replace(/x$/i, "")
      const scale = Number.parseFloat(scaleStr)
      if (url && Number.isFinite(scale) && scale > bestScale) {
        bestScale = scale
        best = url
      }
      if (url && !Number.isFinite(scale) && !best) best = url
    }
    if (best) return best
  }

  let src = normalizeUrl(attrs.src || "")
  if (src.includes("/thumb/")) {
    // thumb 链接可能是 48px/80px 等过小版本，这里尽量提升到 120px 以便展示。
    const m = src.match(/\/(\d+)px-/)
    if (m?.[1]) {
      const px = Number.parseInt(m[1], 10)
      if (Number.isFinite(px) && px > 0 && px < 120) src = src.replace(`/${m[1]}px-`, "/120px-")
    }
  }

  return src
}

function parseBasicInfoFromFirstTable(html) {
  // 通用解析：角色/武器页面的“基础信息”通常在第一个 wikitable 表格内。
  const tableMatch = html.match(/<table[^>]*class=\"[^\"]*wikitable[^\"]*\"[^>]*>([\s\S]*?)<\/table>/i)
  if (!tableMatch?.[1]) return {}

  const tableHtml = tableMatch[1]
  const info = {}

  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let tr
  while ((tr = trRe.exec(tableHtml))) {
    const rowHtml = tr[1]
    const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi
    const cells = []
    let cell
    while ((cell = cellRe.exec(rowHtml))) {
      cells.push({ tag: cell[1], html: cell[2] })
    }

    for (let i = 0; i < cells.length - 1; i++) {
      const cur = cells[i]
      const next = cells[i + 1]
      if (cur.tag !== "th" || next.tag !== "td") continue
      const key = stripTags(cur.html)
      const val = stripTags(next.html)
      if (key) info[key] = val
      i++
    }
  }

  return info
}

function parseTableRows(tableHtml) {
  const rows = []
  const trRe = /<tr([^>]*)>([\s\S]*?)<\/tr>/gi
  let tr
  while ((tr = trRe.exec(String(tableHtml || "")))) {
    const trAttrs = String(tr[1] || "")
    if (/display\s*:\s*none/i.test(trAttrs)) continue

    const rowHtml = tr[2]
    const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi
    const cells = []
    let cell
    while ((cell = cellRe.exec(rowHtml))) {
      const text = cleanTextBlock(stripTags(cell[2]))
      cells.push({ tag: cell[1], html: cell[2], text })
    }
    if (cells.some(cell => cell.text)) rows.push(cells)
  }
  return rows
}

function findHeadingIndex(html, heading) {
  const re = new RegExp(`<th[^>]*>\\s*${escapeRegExp(heading)}\\s*`, "i")
  return String(html || "").search(re)
}

function extractWikitableByHeading(html, heading) {
  const tableRe = /(<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>[\s\S]*?<\/table>)/gi
  let m
  while ((m = tableRe.exec(String(html || "")))) {
    const tableHtml = m[1]
    const headMatch = tableHtml.match(/<th[^>]*>([\s\S]*?)<\/th>/i)
    const head = cleanTextBlock(stripTags(headMatch?.[1] || ""))
    if (head === heading) return tableHtml
  }
  return ""
}

function extractSectionSlice(html, heading, nextHeadings = []) {
  const source = String(html || "")
  const start = findHeadingIndex(source, heading)
  if (start < 0) return ""

  let end = source.length
  for (const next of nextHeadings) {
    const idx = findHeadingIndex(source.slice(start + 1), next)
    if (idx >= 0) end = Math.min(end, start + 1 + idx)
  }
  return source.slice(start, end)
}

function extractAnchorTexts(html) {
  return [...String(html || "").matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(m => cleanTextBlock(stripTags(m[1] || "")))
    .filter(Boolean)
}

function extractFirstImgUrl(html) {
  const match = String(html || "").match(/<img[^>]*>/i)
  if (!match?.[0]) return ""
  return bestImgUrl(parseAttrs(match[0]))
}

function parseVersionTag(text) {
  const m = String(text || "").match(/(\d+(?:\.\d+)+)/)
  return m?.[1] || ""
}

function parseMonthDayRange(text, year) {
  const s = cleanTextBlock(String(text || "")).replace(/\s+/g, " ")
  const m = s.match(/(\d{1,2})\/(\d{1,2})\s*-\s*(?:(\d{1,2})\/(\d{1,2}))?/) 
  if (!m) return { start_timestamp: 0, end_timestamp: 0, raw_range: s }

  const startMonth = Number.parseInt(m[1], 10)
  const startDay = Number.parseInt(m[2], 10)
  const endMonth = m[3] ? Number.parseInt(m[3], 10) : 0
  const endDay = m[4] ? Number.parseInt(m[4], 10) : 0
  if (![startMonth, startDay].every(Number.isFinite)) return { start_timestamp: 0, end_timestamp: 0, raw_range: s }

  const startTs = Math.floor(new Date(year, startMonth - 1, startDay, 0, 0, 0).getTime() / 1000)
  let endTs = 0
  if (Number.isFinite(endMonth) && Number.isFinite(endDay) && endMonth > 0 && endDay > 0) {
    const endYear = endMonth < startMonth ? year + 1 : year
    endTs = Math.floor(new Date(endYear, endMonth - 1, endDay, 23, 59, 59).getTime() / 1000)
  }

  return {
    start_timestamp: startTs,
    end_timestamp: endTs,
    raw_range: s,
  }
}

function takeLines(text, maxLines = 4) {
  return String(text || "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
}

function parseCharRarity(html) {
  const m = html.match(/alt=\"(6星\.png|5星\.png|4星\.png|3星\.png)\"/i)
  if (m?.[1] && CHAR_RARITY_ALT_MAP[m[1]]) return CHAR_RARITY_ALT_MAP[m[1]]
  return 0
}

function parseWeaponRarity(html) {
  const m = html.match(/alt=\"(橙色\.png|金色\.png|紫色\.png|蓝色\.png)\"/i)
  if (m?.[1] && WEAPON_RARITY_ALT_MAP[m[1]]) return WEAPON_RARITY_ALT_MAP[m[1]]
  return 0
}

function parseWeaponBaseAttack(html) {
  const matches = [...String(html || "").matchAll(/基础攻击力[^\d]*(\d+)/g)]
  const base_attack = matches?.[0]?.[1] ? Number.parseInt(matches[0][1], 10) : 0
  const base_attack_max = matches?.[1]?.[1] ? Number.parseInt(matches[1][1], 10) : 0
  return {
    base_attack: Number.isFinite(base_attack) ? base_attack : 0,
    base_attack_max: Number.isFinite(base_attack_max) ? base_attack_max : 0,
  }
}

function parseTimestamp(raw) {
  const s = String(raw || "").trim()
  const m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/)
  if (!m) return 0
  const yyyy = Number.parseInt(m[1], 10)
  const mm = Number.parseInt(m[2], 10)
  const dd = Number.parseInt(m[3], 10)
  const hh = Number.parseInt(m[4], 10)
  const mi = Number.parseInt(m[5], 10)
  if (![yyyy, mm, dd, hh, mi].every(n => Number.isFinite(n))) return 0
  const d = new Date(yyyy, mm - 1, dd, hh, mi)
  return Math.floor(d.getTime() / 1000)
}

function parseActivityBlock(blockHtml, { bannerType }) {
  // 首页的卡池活动块结构不稳定：这里只抽取名称/目标图/时间戳等核心字段。
  const activityListMatch = blockHtml.match(
    /<div[^>]*class=\"[^\"]*\bactivityList\b[^\"]*\"[^>]*>([\s\S]*?)<\/div>/i,
  )
  const activityText = activityListMatch?.[1] ? stripTags(activityListMatch[1]).replace(/MediaWiki:EventTimer.*/g, "") : ""

  let bannerName = ""
  if (bannerType === "character") {
    const m = activityText.match(/(特许寻访·[^\s限距]+)/)
    if (m?.[1]) bannerName = m[1]
  } else {
    const m = activityText.match(/(武库申领·[^\s限距]+)/)
    if (m?.[1]) bannerName = m[1]
  }

  const events = []
  if (bannerType === "character") {
    const re = /(限时签到·[^\s<]+|作战演练·[^\s<]+)/g
    let em
    while ((em = re.exec(activityText))) events.push(em[1])
  }

  let target_name = ""
  let target_icon_url = ""
  const imageMatch = blockHtml.match(
    /<div[^>]*class=\"[^\"]*\bactivityImage\b[^\"]*\"[^>]*>([\s\S]*?)<\/div>/i,
  )
  if (imageMatch?.[1]) {
    const inner = imageMatch[1]
    const am = inner.match(/<a[^>]*title=(\"([^\"]*)\"|'([^']*)')/i)
    target_name = am?.[2] ?? am?.[3] ?? ""

    const img = inner.match(/<img[^>]*>/i)
    if (img?.[0]) {
      const attrs = parseAttrs(img[0])
      target_icon_url = bestImgUrl(attrs)
    }
  }

  let start_timestamp = 0
  let end_timestamp = 0
  const timerMatch = blockHtml.match(/<span[^>]*class=\"[^\"]*\beventTimer\b[^\"]*\"[^>]*>/i)
  if (timerMatch?.[0]) {
    const attrs = parseAttrs(timerMatch[0])
    start_timestamp = parseTimestamp(attrs["data-start"])
    end_timestamp = parseTimestamp(attrs["data-end"])
  }

  if (!bannerName && !target_name) return null
  return {
    banner_name: bannerName,
    banner_type: bannerType,
    events,
    target_name,
    target_icon_url,
    start_timestamp,
    end_timestamp,
  }
}

function fillCharBannerTimes(banners) {
  const charBanners = banners.filter(b => b.banner_type === "character")
  if (!charBanners.length) return
  if (!charBanners[0].end_timestamp) return

  // wiki 有时只在第一个卡池标注了结束时间；后续卡池按固定周期顺延。
  for (let i = 1; i < charBanners.length; i++) {
    const prev = charBanners[i - 1]
    charBanners[i].start_timestamp = prev.end_timestamp
    charBanners[i].end_timestamp = prev.end_timestamp + BANNER_CYCLE_SECONDS
  }
}

function parseActivityOverviewTable(tableHtml, { sectionLabel }) {
  const rows = parseTableRows(tableHtml)
  const list = []
  let currentYear = 0

  for (const row of rows) {
    if (!row.length) continue
    const firstText = String(row[0]?.text || "").trim()
    const yearMatch = firstText.match(/(\d{4})年/)
    if (yearMatch?.[1]) {
      currentYear = Number.parseInt(yearMatch[1], 10) || currentYear
      continue
    }

    if (!currentYear) continue
    if (sectionLabel === "主题活动") {
      if (row.length < 2 || firstText === "活动") continue
      const title = extractAnchorTexts(row[0]?.html || "").at(-1) || firstText.replace(/^\d+(?:\.\d+)+\s*/, "")
      const version = parseVersionTag(row[0]?.text || "") || parseVersionTag(row[1]?.text || "")
      const range = parseMonthDayRange(row[1]?.text || "", currentYear)
      if (!title || !range.start_timestamp) continue
      list.push({
        title,
        section_label: sectionLabel,
        version,
        target_name: "",
        cover_url: extractFirstImgUrl(row[row.length - 1]?.html || ""),
        start_timestamp: range.start_timestamp,
        end_timestamp: range.end_timestamp,
        time_text: range.raw_range,
      })
      continue
    }

    if (sectionLabel === "叙事活动") {
      if (row.length < 3 || firstText === "角色") continue
      const targetName = extractAnchorTexts(row[0]?.html || "").at(-1) || firstText
      const title = extractAnchorTexts(row[1]?.html || "").at(-1) || String(row[1]?.text || "").trim()
      const version = parseVersionTag(row[2]?.text || "")
      const range = parseMonthDayRange(row[2]?.text || "", currentYear)
      if (!title || !range.start_timestamp) continue
      list.push({
        title,
        section_label: sectionLabel,
        version,
        target_name: targetName,
        cover_url: extractFirstImgUrl(row[row.length - 1]?.html || ""),
        start_timestamp: range.start_timestamp,
        end_timestamp: range.end_timestamp,
        time_text: range.raw_range,
      })
    }
  }

  return list
}

export function parseActivityOverview(html) {
  const source = String(html || "")
  if (!source.includes("mw-parser-output")) return []

  const themeTable = extractWikitableByHeading(source, "主题活动")
  const storyTable = extractWikitableByHeading(source, "叙事活动")
  return [
    ...parseActivityOverviewTable(themeTable, { sectionLabel: "主题活动" }),
    ...parseActivityOverviewTable(storyTable, { sectionLabel: "叙事活动" }),
  ]
}

export function parseHomepage(html) {
  const source = String(html || "")
  if (!source.includes("mw-parser-output")) return null

  const characters = {}
  const weapons = {}

  const divSortRe = /<div[^>]*class=\"[^\"]*\bdivsort\b[^\"]*\"[^>]*>/gi
  let m
  while ((m = divSortRe.exec(source))) {
    const tag = m[0]
    const attrs = parseAttrs(tag)

    const rarityStr = String(attrs["data-param1"] || "").trim()
    const profession = String(attrs["data-param2"] || "").trim()
    const attribute = String(attrs["data-param3"] || "").trim()

    const start = m.index
    // 仅截取一段局部 HTML 做启发式解析，避免全量解析器带来的复杂度与性能开销。
    const slice = source.slice(start, Math.min(source.length, start + 1800))
    const aMatch = slice.match(/<a[^>]*title=(\"([^\"]*)\"|'([^']*)')/i)
    const name = aMatch?.[2] ?? aMatch?.[3] ?? ""
    if (!name) continue

    const imgTags = [...slice.matchAll(/<img[^>]*>/gi)].map(x => x[0])

    if (rarityStr && profession && attribute) {
      const rarity = STAR_RARITY_MAP[rarityStr] || 0
      let avatar_url = ""
      if (imgTags.length) avatar_url = bestImgUrl(parseAttrs(imgTags[0]))

      const entry = { name, rarity, profession, attribute, avatar_url }
      characters[attribute] ??= []
      characters[attribute].push(entry)
      continue
    }

    const weaponType = String(attrs["data-param1"] || "").trim()
    if (weaponType) {
      let rarity = 0
      let icon_url = ""
      for (const imgTag of imgTags) {
        const imgAttrs = parseAttrs(imgTag)
        const alt = String(imgAttrs.alt || "").trim()
        if (STAR_IMG_RARITY_MAP[alt]) {
          rarity = STAR_IMG_RARITY_MAP[alt]
          continue
        }
        if (!icon_url) icon_url = bestImgUrl(imgAttrs)
      }

      const entry = { name, rarity, weapon_type: weaponType, icon_url }
      weapons[weaponType] ??= []
      weapons[weaponType].push(entry)
    }
  }

  const banners = []

  const charActivityRe = /<div[^>]*class=\"[^\"]*\bcharacterActivity\b[^\"]*\"[^>]*>/gi
  let cm
  while ((cm = charActivityRe.exec(source))) {
    const start = cm.index
    // 活动块内容更长，给更大的 slice 窗口。
    const block = source.slice(start, Math.min(source.length, start + 8000))
    const b = parseActivityBlock(block, { bannerType: "character" })
    if (b) banners.push(b)
  }

  const weaponActivityRe = /<div[^>]*class=\"[^\"]*\bweaponActivity\b[^\"]*\"[^>]*>/gi
  let wm
  while ((wm = weaponActivityRe.exec(source))) {
    const start = wm.index
    const block = source.slice(start, Math.min(source.length, start + 8000))
    const b = parseActivityBlock(block, { bannerType: "weapon" })
    if (b) banners.push(b)
  }

  fillCharBannerTimes(banners)

  return {
    characters,
    weapons,
    gacha: banners,
    fetch_time: 0,
  }
}

export function parseCharWiki(html, charName) {
  const source = String(html || "")
  if (!source.includes("mw-parser-output")) return null

  const basic = parseBasicInfoFromFirstTable(source)
  const rarity = parseCharRarity(source)
  const archiveTable = extractWikitableByHeading(source, "档案")
  const archiveRows = parseTableRows(archiveTable)
  let archive_base = []
  let archive_brief = []
  for (let i = 0; i < archiveRows.length - 1; i++) {
    const cur = archiveRows[i]
    if (cur.length < 2) continue
    if (cur[0].text === "基础档案" && cur[1].text === "人事简述") {
      const next = archiveRows[i + 1]
      if (Array.isArray(next) && next.length >= 2) {
        archive_base = takeLines(next[0].text, 6)
        archive_brief = takeLines(next[1].text, 4)
      }
      break
    }
  }

  const talentTable = extractWikitableByHeading(source, "天赋")
  const talentRows = parseTableRows(talentTable)
  const talents = []
  let currentTalent = null
  for (const row of talentRows.slice(1)) {
    if (row.length < 2) continue
    let name = ""
    let stage = ""
    let description = ""

    if (row.length >= 3) {
      name = row[0].text
      stage = row[1].text
      description = row.slice(2).map(cell => cell.text).join(" ").trim()
      currentTalent = name ? { name, effects: [] } : currentTalent
      if (currentTalent && name) talents.push(currentTalent)
    } else {
      stage = row[0].text
      description = row.slice(1).map(cell => cell.text).join(" ").trim()
    }

    if (!currentTalent || (!stage && !description)) continue
    currentTalent.effects.push({ stage, description })
  }

  const skillSlice = extractSectionSlice(source, "技能", ["潜能", "信物", "档案"])
  const skillTitleBlockMatch = skillSlice.match(
    /<div[^>]*class="[^"]*d-tab-titles[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*d-tab-contents[^"]*"/i,
  )
  const skillTitleBlock = skillTitleBlockMatch?.[1] || ""
  const skillTitleSet = new Set()
  const skillTitles = []
  const skillTitleRe = /<img[^>]*alt="([^"]+?)\.png"/gi
  let skillTitleMatch
  while ((skillTitleMatch = skillTitleRe.exec(skillTitleBlock))) {
    const title = String(skillTitleMatch[1] || "").trim()
    if (!title || skillTitleSet.has(title)) continue
    skillTitleSet.add(title)
    skillTitles.push(title)
  }

  const skillSummaryKeySet = new Set(["普通攻击", "下落攻击", "处决攻击", "战技", "连携技", "终结技", "源石技艺", "闪避", "特性"])
  const skillBlocks = skillSlice.split(/<div class="tab-content(?:\s+[^"]*)?">/i).slice(1)
  const skills = skillBlocks.map((block, index) => {
    const summary = []
    const skillTableRe = /<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi
    let skillTableMatch
    while ((skillTableMatch = skillTableRe.exec(block))) {
      const rows = parseTableRows(skillTableMatch[1])
      if (!rows.length) continue
      const firstKey = rows[0]?.[0]?.text || ""

      if (skillSummaryKeySet.has(firstKey)) {
        for (const row of rows) {
          if (row.length < 2) continue
          const label = row[0].text
          const description = row.slice(1).map(cell => cell.text).join(" ").trim()
          if (!label || !description) continue
          summary.push({ label, description })
          if (summary.length >= 4) break
        }
      } else if (!summary.length) {
        const description = rows[0]?.[0]?.text || ""
        if (description) summary.push({ label: "技能效果", description })
      }

      if (summary.length >= 4) break
    }

    return {
      name: skillTitles[index] || `技能模块${index + 1}`,
      summary,
    }
  }).filter(item => item.name || item.summary.length)

  const potentialTable = extractWikitableByHeading(source, "潜能")
  const potentialRows = parseTableRows(potentialTable)
  const potentials = potentialRows.slice(1)
    .map(row => ({
      level: row[0]?.text || "",
      title: row[1]?.text || "",
      description: row.slice(2).map(cell => cell.text).join(" ").trim(),
    }))
    .filter(item => item.level || item.title || item.description)

  return {
    name: String(charName || ""),
    rarity,
    profession: basic["职业"] || "",
    attribute: basic["属性"] || "",
    tags: splitList(basic["TAG"] || ""),
    faction: basic["阵营"] || "",
    race: basic["种族"] || "",
    specialties: splitList(basic["专长"] || ""),
    hobbies: splitList(basic["爱好"] || ""),
    operator_preference: basic["干员偏好"] || "",
    release_date: basic["实装日期"] || "",
    archive_base,
    archive_brief,
    talents,
    skills,
    potentials,
    fetch_time: 0,
  }
}

export function parseWeaponWiki(html, weaponName) {
  const source = String(html || "")
  if (!source.includes("mw-parser-output")) return null

  const basic = parseBasicInfoFromFirstTable(source)
  const rarity = parseWeaponRarity(source)
  const atk = parseWeaponBaseAttack(source)

  return {
    name: String(weaponName || ""),
    weapon_type: basic["武器种类"] || "",
    rarity,
    description: basic["描述"] || "",
    base_attack: atk.base_attack || 0,
    base_attack_max: atk.base_attack_max || 0,
    fetch_time: 0,
  }
}
