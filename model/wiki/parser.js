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
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "")
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "")
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

function parseAttrs(tag) {
  const attrs = {}
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
    const m = src.match(/\/(\d+)px-/)
    if (m?.[1]) {
      const px = Number.parseInt(m[1], 10)
      if (Number.isFinite(px) && px > 0 && px < 120) src = src.replace(`/${m[1]}px-`, "/120px-")
    }
  }

  return src
}

function parseBasicInfoFromFirstTable(html) {
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

  for (let i = 1; i < charBanners.length; i++) {
    const prev = charBanners[i - 1]
    charBanners[i].start_timestamp = prev.end_timestamp
    charBanners[i].end_timestamp = prev.end_timestamp + BANNER_CYCLE_SECONDS
  }
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
