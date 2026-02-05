/**
 * 图鉴（biligame wiki）指令入口。
 *
 * 使用 model/wiki/* 抓取/缓存/解析 wiki 页面，并格式化为文本回复。
 */
import common from "../../../lib/common/common.js"
import plugin from "../../../lib/plugins/plugin.js"

import cfg from "../model/config.js"
import { resolveAliasEntry } from "../model/alias.js"
import { patchTempSessionReply } from "../model/reply.js"
import { ensureListData, getCharWiki, getWeaponWiki } from "../model/wiki/fetch.js"
import { resolveWeaponAlias } from "../model/wiki/weaponAlias.js"

const GAME_TITLE = "[终末地]"

function formatTime(tsSec) {
  const t = Number(tsSec) || 0
  if (t <= 0) return "-"
  const d = new Date(t * 1000)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

function joinList(items, { sep = "、", maxLen = 800 } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean).map(x => String(x).trim()).filter(Boolean) : []
  if (!list.length) return "-"
  let out = ""
  for (const item of list) {
    const next = out ? `${out}${sep}${item}` : item
    if (next.length > maxLen) return `${out}${sep}…`
    out = next
  }
  return out
}

function formatRarity(r) {
  const n = Number(r) || 0
  return n > 0 ? `${n}★` : "-"
}

function wikiUrl(name) {
  const n = String(name || "").trim()
  if (!n) return ""
  return `https://wiki.biligame.com/zmd/${encodeURIComponent(n)}`
}

async function resolveCharName(raw) {
  const s = String(raw || "").trim()
  if (!s) return ""
  try {
    const resolved = await resolveAliasEntry(s)
    if (!resolved) return s
    const name = String(resolved.entry?.name || resolved.key || "").trim()
    return name || s
  } catch {
    return s
  }
}

export class wiki extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: "zmd-plugin-wiki",
      dsc: "终末地图鉴（biligame wiki）",
      event: "message",
      priority: 5000,
      rule: [
        { reg: "^#?(?:终末地|zmd)角色列表$", fnc: "charList" },
        { reg: "^#?(?:终末地|zmd)武器列表$", fnc: "weaponList" },
        { reg: "^#?(?:终末地|zmd)(?:卡池|卡池信息|up角色)$", fnc: "gacha" },
        { reg: "^#?(?:终末地|zmd)\\s*(.+?)\\s*(图鉴|介绍|技能|天赋|潜能|专武|武器)$", fnc: "query" },
      ],
    })
  }

  getCmdPrefixHint() {
    return String(cfg.cmd?.prefix || "#zmd")
  }

  async charList() {
    const e = this.e
    const data = await ensureListData()
    const groups = data?.characters && typeof data.characters === "object" ? data.characters : {}
    const keys = Object.keys(groups)
    if (!keys.length) {
      await e.reply(`${GAME_TITLE} 暂无角色列表数据`, true)
      return true
    }

    const forward = []
    forward.push([`${GAME_TITLE} 角色列表（更新：${formatTime(data.fetch_time)}）`])

    for (const key of keys.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))) {
      const entries = Array.isArray(groups[key]) ? groups[key] : []
      const names = entries.map(x => x?.name).filter(Boolean)
      forward.push([`【${key}】(${names.length})\n${joinList(names, { maxLen: 950 })}`])
    }

    await e.reply(common.makeForwardMsg(e, forward, "终末地-角色列表"))
    return true
  }

  async weaponList() {
    const e = this.e
    const data = await ensureListData()
    const groups = data?.weapons && typeof data.weapons === "object" ? data.weapons : {}
    const keys = Object.keys(groups)
    if (!keys.length) {
      await e.reply(`${GAME_TITLE} 暂无武器列表数据`, true)
      return true
    }

    const forward = []
    forward.push([`${GAME_TITLE} 武器列表（更新：${formatTime(data.fetch_time)}）`])

    for (const key of keys.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))) {
      const entries = Array.isArray(groups[key]) ? groups[key] : []
      const names = entries.map(x => x?.name).filter(Boolean)
      forward.push([`【${key}】(${names.length})\n${joinList(names, { maxLen: 950 })}`])
    }

    await e.reply(common.makeForwardMsg(e, forward, "终末地-武器列表"))
    return true
  }

  async gacha() {
    const e = this.e
    const data = await ensureListData()
    const list = Array.isArray(data?.gacha) ? data.gacha : []
    if (!list.length) {
      await e.reply(`${GAME_TITLE} 暂无卡池信息`, true)
      return true
    }

    const forward = []
    forward.push([`${GAME_TITLE} 卡池信息（更新：${formatTime(data.fetch_time)}）`])

    for (const b of list) {
      const title = String(b?.banner_name || "").trim() || "（未命名卡池）"
      const type = b?.banner_type === "weapon" ? "武器" : "角色"
      const target = String(b?.target_name || "").trim()
      const events = Array.isArray(b?.events) ? b.events.filter(Boolean) : []
      const start = formatTime(b?.start_timestamp)
      const end = formatTime(b?.end_timestamp)
      const time = start !== "-" || end !== "-" ? `${start} ~ ${end}` : "-"

      const lines = [
        `${title}（${type}）`,
        target ? `目标：${target}` : "",
        events.length ? `活动：${joinList(events, { sep: "；", maxLen: 800 })}` : "",
        `时间：${time}`,
      ].filter(Boolean)

      forward.push([lines.join("\n")])
    }

    await e.reply(common.makeForwardMsg(e, forward, "终末地-卡池信息"))
    return true
  }

  async query() {
    const e = this.e
    const msg = String(e.msg || "").trim()
    const m = msg.match(/^#?(?:终末地|zmd)\s*(.+?)\s*(图鉴|介绍|技能|天赋|潜能|专武|武器)$/i)
    const rawName = m?.[1] ? String(m[1]).trim() : ""
    const keyword = m?.[2] ? String(m[2]).trim() : "图鉴"

    if (!rawName) {
      await e.reply(`${GAME_TITLE} 请提供查询名称，例如：${this.getCmdPrefixHint()}莱万汀图鉴`, true)
      return true
    }

    // "{角色}专武" / "{角色}武器"：先按角色别名解析，再走武器别名映射
    if (keyword === "专武" || keyword === "武器" || rawName.endsWith("专武") || rawName.endsWith("武器")) {
      const charPart = rawName.replace(/(专武|武器)$/, "")
      const realChar = await resolveCharName(charPart)
      const weaponName = await resolveWeaponAlias(`${realChar}专武`)
      if (weaponName) {
        const wiki = await getWeaponWiki(weaponName)
        if (wiki) {
          await e.reply(
            [
              `${GAME_TITLE} 武器图鉴：${weaponName}（${formatRarity(wiki.rarity)}）`,
              wiki.weapon_type ? `类型：${wiki.weapon_type}` : "",
              wiki.base_attack_max ? `基础攻击：${wiki.base_attack} / ${wiki.base_attack_max}` : "",
              wiki.description ? `描述：${wiki.description}` : "",
              `Wiki：${wikiUrl(weaponName)}`,
              `更新时间：${formatTime(wiki.fetch_time)}`,
            ].filter(Boolean).join("\n"),
            true,
          )
          return true
        }
      }
    }

    const realName = await resolveCharName(rawName)

    const charWiki = await getCharWiki(realName)
    if (charWiki) {
      await e.reply(
        [
          `${GAME_TITLE} 角色图鉴：${charWiki.name}（${formatRarity(charWiki.rarity)}）`,
          charWiki.profession ? `职业：${charWiki.profession}` : "",
          charWiki.attribute ? `属性：${charWiki.attribute}` : "",
          Array.isArray(charWiki.tags) && charWiki.tags.length ? `TAG：${joinList(charWiki.tags, { maxLen: 800 })}` : "",
          charWiki.faction ? `阵营：${charWiki.faction}` : "",
          charWiki.race ? `种族：${charWiki.race}` : "",
          Array.isArray(charWiki.specialties) && charWiki.specialties.length
            ? `专长：${joinList(charWiki.specialties, { maxLen: 800 })}`
            : "",
          Array.isArray(charWiki.hobbies) && charWiki.hobbies.length ? `爱好：${joinList(charWiki.hobbies, { maxLen: 800 })}` : "",
          charWiki.release_date ? `实装：${charWiki.release_date}` : "",
          `Wiki：${wikiUrl(charWiki.name)}`,
          `更新时间：${formatTime(charWiki.fetch_time)}`,
        ].filter(Boolean).join("\n"),
        true,
      )
      return true
    }

    const weaponWiki = await getWeaponWiki(realName)
    if (weaponWiki) {
      await e.reply(
        [
          `${GAME_TITLE} 武器图鉴：${weaponWiki.name}（${formatRarity(weaponWiki.rarity)}）`,
          weaponWiki.weapon_type ? `类型：${weaponWiki.weapon_type}` : "",
          weaponWiki.base_attack_max ? `基础攻击：${weaponWiki.base_attack} / ${weaponWiki.base_attack_max}` : "",
          weaponWiki.description ? `描述：${weaponWiki.description}` : "",
          `Wiki：${wikiUrl(weaponWiki.name)}`,
          `更新时间：${formatTime(weaponWiki.fetch_time)}`,
        ].filter(Boolean).join("\n"),
        true,
      )
      return true
    }

    const weaponResolved = await resolveWeaponAlias(realName)
    if (weaponResolved && weaponResolved !== realName) {
      const wiki = await getWeaponWiki(weaponResolved)
      if (wiki) {
        await e.reply(
          [
            `${GAME_TITLE} 武器图鉴：${wiki.name}（${formatRarity(wiki.rarity)}）`,
            wiki.weapon_type ? `类型：${wiki.weapon_type}` : "",
            wiki.base_attack_max ? `基础攻击：${wiki.base_attack} / ${wiki.base_attack_max}` : "",
            wiki.description ? `描述：${wiki.description}` : "",
            `Wiki：${wikiUrl(wiki.name)}`,
            `更新时间：${formatTime(wiki.fetch_time)}`,
          ].filter(Boolean).join("\n"),
          true,
        )
        return true
      }
    }

    await e.reply(`${GAME_TITLE} 未找到相关图鉴信息`, true)
    return true
  }
}
