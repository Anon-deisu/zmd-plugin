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
const KEY_ACTIVITY_SUBS = "Yz:EndUID:Activity:Subs"
const KEY_ACTIVITY_SEEN_PREFIX = "Yz:EndUID:Activity:Seen:"
const DAY_SEC = 86400

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

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

function shorten(text, maxLen = 120) {
  const s = String(text || "").replace(/\s+/g, " ").trim()
  if (!s) return ""
  return s.length > maxLen ? `${s.slice(0, Math.max(1, maxLen - 1))}…` : s
}

function formatRemainText(targetTs, { nowTs = Math.floor(Date.now() / 1000), endedText = "已结束" } = {}) {
  const ts = Number(targetTs) || 0
  if (!ts) return "-"
  const diff = ts - nowTs
  if (diff <= 0) return endedText
  if (diff < 3600) return `${Math.max(1, Math.ceil(diff / 60))} 分钟后`
  if (diff < DAY_SEC) return `${Math.ceil(diff / 3600)} 小时后`
  if (diff < 30 * DAY_SEC) return `${Math.ceil(diff / DAY_SEC)} 天后`
  if (diff < 60 * DAY_SEC) return "1 个月后"
  return `${Math.floor(diff / (30 * DAY_SEC))} 个月后`
}

function buildActivityId(item, index) {
  return [
    item?.banner_type || "",
    item?.banner_name || "",
    item?.target_name || "",
    Number(item?.start_timestamp) || 0,
    Number(item?.end_timestamp) || 0,
    index,
  ].join(":")
}

function normalizeActivityEntries(data) {
  const list = Array.isArray(data?.gacha) ? data.gacha : []
  return list
    .map((item, index) => ({
      id: buildActivityId(item, index),
      title: String(item?.banner_name || "").trim() || "（未命名卡池）",
      typeLabel: item?.banner_type === "weapon" ? "武器池" : "角色池",
      targetName: String(item?.target_name || "").trim(),
      relatedEvents: Array.isArray(item?.events) ? item.events.filter(Boolean).map(x => String(x).trim()).filter(Boolean) : [],
      startTs: Number(item?.start_timestamp) || 0,
      endTs: Number(item?.end_timestamp) || 0,
    }))
    .filter(item => item.title)
    .sort((a, b) => {
      const startDiff = (a.startTs || Number.MAX_SAFE_INTEGER) - (b.startTs || Number.MAX_SAFE_INTEGER)
      if (startDiff !== 0) return startDiff
      return a.title.localeCompare(b.title, "zh-Hans-CN")
    })
}

function buildActivityCardLines(item, nowTs) {
  const isUpcoming = item.startTs > nowTs
  const isActive = item.startTs > 0 && item.startTs <= nowTs && (!item.endTs || item.endTs > nowTs)
  const status = isUpcoming ? "即将开启" : isActive ? "进行中" : "已结束"
  return [
    `${item.title}（${item.typeLabel} / ${status}）`,
    item.targetName ? `目标：${item.targetName}` : "",
    item.relatedEvents.length ? `关联活动：${joinList(item.relatedEvents, { sep: "；", maxLen: 800 })}` : "",
    `时间：${formatTime(item.startTs)} ~ ${formatTime(item.endTs)}`,
    isUpcoming
      ? `开启：${formatRemainText(item.startTs, { nowTs, endedText: "已开启" })}`
      : `结束：${formatRemainText(item.endTs, { nowTs, endedText: "已结束" })}`,
  ].filter(Boolean)
}

function activitySeenKey(sub) {
  const type = String(sub?.push_type || "private").trim() || "private"
  const target = String(sub?.push_target || sub?.user_id || "").trim()
  return `${KEY_ACTIVITY_SEEN_PREFIX}${type}:${target}`
}

async function getActivitySubList() {
  try {
    const raw = await redis.get(KEY_ACTIVITY_SUBS)
    const parsed = raw ? safeJsonParse(raw, []) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function setActivitySubList(list) {
  try {
    await redis.set(KEY_ACTIVITY_SUBS, JSON.stringify(Array.isArray(list) ? list : []))
  } catch {}
}

async function getActivitySeenList(sub) {
  try {
    const raw = await redis.get(activitySeenKey(sub))
    const parsed = raw ? safeJsonParse(raw, []) : []
    return Array.isArray(parsed) ? parsed.map(x => String(x)) : []
  } catch {
    return []
  }
}

async function setActivitySeenList(sub, list) {
  try {
    await redis.set(activitySeenKey(sub), JSON.stringify(Array.isArray(list) ? list : []))
  } catch {}
}

function getReminderHours(sub) {
  const custom = Number(sub?.before_hours)
  if (Number.isFinite(custom) && custom > 0) return Math.min(168, Math.max(1, Math.floor(custom)))
  return Math.min(168, Math.max(1, Number(cfg.activity?.remindBeforeHours) || 24))
}

async function sendActivityReminderMessage(sub, msg) {
  const type = String(sub?.push_type || "private").trim()
  const target = String(sub?.push_target || sub?.user_id || "").trim()
  if (type === "group" && target) {
    await Bot.pickGroup(target).sendMsg(msg)
    return
  }
  if (target) await Bot.pickFriend(target).sendMsg(msg)
}

function buildCharSummaryReply(charWiki) {
  return [
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
    charWiki.operator_preference ? `干员偏好：${charWiki.operator_preference}` : "",
    charWiki.release_date ? `实装：${charWiki.release_date}` : "",
    `Wiki：${wikiUrl(charWiki.name)}`,
    `更新时间：${formatTime(charWiki.fetch_time)}`,
  ].filter(Boolean)
}

function buildCharIntroReply(charWiki) {
  const base = Array.isArray(charWiki.archive_base) ? charWiki.archive_base.map(line => shorten(line, 100)) : []
  const brief = Array.isArray(charWiki.archive_brief) ? charWiki.archive_brief.map(line => shorten(line, 100)) : []
  const lines = [
    `${GAME_TITLE} 角色介绍：${charWiki.name}（${formatRarity(charWiki.rarity)}）`,
    [charWiki.profession, charWiki.attribute].filter(Boolean).join(" / "),
    base.length ? `基础档案：${base.join(" ")}` : "",
    brief.length ? `人事简述：${brief.join(" ")}` : "",
    `Wiki：${wikiUrl(charWiki.name)}`,
    `更新时间：${formatTime(charWiki.fetch_time)}`,
  ].filter(Boolean)
  return lines.length > 4 ? lines : buildCharSummaryReply(charWiki)
}

function buildCharTalentReply(charWiki) {
  const talents = Array.isArray(charWiki.talents) ? charWiki.talents.filter(item => item?.name) : []
  if (!talents.length) return []

  const lines = [`${GAME_TITLE} 角色天赋：${charWiki.name}`]
  for (const talent of talents.slice(0, 4)) {
    lines.push(`【${talent.name}】`)
    const effects = Array.isArray(talent.effects) ? talent.effects : []
    for (const effect of effects.slice(0, 3)) {
      const stage = shorten(effect?.stage, 20) || "效果"
      const desc = shorten(effect?.description, 150)
      if (desc) lines.push(`${stage}：${desc}`)
    }
  }
  lines.push(`Wiki：${wikiUrl(charWiki.name)}`)
  lines.push(`更新时间：${formatTime(charWiki.fetch_time)}`)
  return lines
}

function buildCharSkillReply(charWiki) {
  const skills = Array.isArray(charWiki.skills) ? charWiki.skills.filter(item => item?.name) : []
  if (!skills.length) return []

  const lines = [`${GAME_TITLE} 角色技能：${charWiki.name}`]
  for (const skill of skills.slice(0, 6)) {
    lines.push(`【${skill.name}】`)
    const summary = Array.isArray(skill.summary) ? skill.summary : []
    for (const row of summary.slice(0, 4)) {
      const label = shorten(row?.label, 20)
      const desc = shorten(row?.description, 140)
      if (label && desc) lines.push(`${label}：${desc}`)
    }
  }
  lines.push(`Wiki：${wikiUrl(charWiki.name)}`)
  lines.push(`更新时间：${formatTime(charWiki.fetch_time)}`)
  return lines
}

function buildCharPotentialReply(charWiki) {
  const potentials = Array.isArray(charWiki.potentials) ? charWiki.potentials.filter(item => item?.level || item?.title) : []
  if (!potentials.length) return []

  const lines = [`${GAME_TITLE} 角色潜能：${charWiki.name}`]
  for (const item of potentials.slice(0, 5)) {
    const title = item.title ? ` ${item.title}` : ""
    const desc = shorten(item.description, 150)
    lines.push(`${item.level || "潜能"}${title}${desc ? `：${desc}` : ""}`)
  }
  lines.push(`Wiki：${wikiUrl(charWiki.name)}`)
  lines.push(`更新时间：${formatTime(charWiki.fetch_time)}`)
  return lines
}

function buildCharReplyByKeyword(charWiki, keyword) {
  if (keyword === "介绍") return buildCharIntroReply(charWiki)
  if (keyword === "天赋") return buildCharTalentReply(charWiki)
  if (keyword === "技能") return buildCharSkillReply(charWiki)
  if (keyword === "潜能") return buildCharPotentialReply(charWiki)
  return buildCharSummaryReply(charWiki)
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
        { reg: "^#?(?:终末地|zmd)(?:日历|活动日历|活动)$", fnc: "calendar" },
        { reg: "^#?(?:终末地|zmd)(?:订阅活动提醒|活动提醒订阅)(?:\\s*(\\d+))?$", fnc: "subscribeActivityReminder" },
        { reg: "^#?(?:终末地|zmd)(?:取消订阅活动提醒|取消活动提醒)$", fnc: "unsubscribeActivityReminder" },
        { reg: "^#?(?:终末地|zmd)活动提醒列表$", fnc: "listActivityReminder" },
        { reg: "^#?(?:终末地|zmd)\\s*(.+?)\\s*(图鉴|介绍|技能|天赋|潜能|专武|武器)$", fnc: "query" },
      ],
      task: {
        name: "zmd-plugin活动提醒",
        cron: String(cfg.activity?.cron || "0 */15 * * * *"),
        fnc: () => this.runActivityReminderTask(),
      },
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

  async calendar() {
    const e = this.e
    const data = await ensureListData()
    const list = normalizeActivityEntries(data)
    if (!list.length) {
      await e.reply(`${GAME_TITLE} 暂无活动日历数据`, true)
      return true
    }

    const nowTs = Math.floor(Date.now() / 1000)
    const listDays = Math.max(1, Number(cfg.activity?.listDays) || 21)
    const upcomingLimitTs = nowTs + listDays * DAY_SEC
    const ongoing = list.filter(item => item.startTs > 0 && item.startTs <= nowTs && (!item.endTs || item.endTs > nowTs))
    const upcoming = list.filter(item => item.startTs > nowTs && item.startTs <= upcomingLimitTs)

    const summary = [
      `${GAME_TITLE} 活动日历（更新：${formatTime(data.fetch_time)}）`,
      `进行中：${ongoing.length} 个`,
      `未来 ${listDays} 天：${upcoming.length} 个`,
      `提醒：${this.getCmdPrefixHint()}订阅活动提醒`,
    ].join("\n")

    const forward = []
    forward.push([summary])

    if (ongoing.length) {
      forward.push(["【进行中】"])
      for (const item of ongoing) forward.push([buildActivityCardLines(item, nowTs).join("\n")])
    }

    if (upcoming.length) {
      forward.push(["【即将开启】"])
      for (const item of upcoming) forward.push([buildActivityCardLines(item, nowTs).join("\n")])
    }

    if (!ongoing.length && !upcoming.length) {
      forward.push([`${GAME_TITLE} 当前没有处于进行中或未来 ${listDays} 天内可见的卡池活动`])
    }

    await e.reply(common.makeForwardMsg(e, forward, "终末地-活动日历"))
    return true
  }

  async subscribeActivityReminder() {
    const e = this.e
    const raw = String(e.msg || "").trim()
    const matchedHours = raw.match(/(\d{1,3})/)
    const beforeHours = matchedHours?.[1] ? Math.min(168, Math.max(1, Number(matchedHours[1]) || 24)) : 0
    const isGroup = !!e.isGroup
    const sub = {
      bot_id: String(e.self_id || ""),
      user_id: String(e.user_id || ""),
      group_id: isGroup ? String(e.group_id || "") : "",
      push_type: isGroup ? "group" : "private",
      push_target: isGroup ? String(e.group_id || "") : String(e.user_id || ""),
      before_hours: beforeHours,
      nickname: String(e.sender?.card || e.sender?.nickname || e.user_id || "").trim(),
    }

    const list = await getActivitySubList()
    const idx = list.findIndex(item => (
      String(item?.bot_id || "") === sub.bot_id
      && String(item?.user_id || "") === sub.user_id
      && String(item?.group_id || "") === sub.group_id
    ))

    if (idx >= 0) list[idx] = { ...list[idx], ...sub }
    else list.push(sub)

    await setActivitySubList(list)
    await setActivitySeenList(sub, [])

    const hours = getReminderHours(sub)
    await e.reply(
      `${GAME_TITLE} 已订阅活动提醒\n推送位置：${isGroup ? "当前群聊" : "当前私聊"}\n提醒窗口：提前 ${hours} 小时\n查看日历：${this.getCmdPrefixHint()}日历`,
      true,
    )
    return true
  }

  async unsubscribeActivityReminder() {
    const e = this.e
    const isGroup = !!e.isGroup
    const botId = String(e.self_id || "")
    const userId = String(e.user_id || "")
    const groupId = isGroup ? String(e.group_id || "") : ""
    const list = await getActivitySubList()
    const filtered = list.filter(item => !(
      String(item?.bot_id || "") === botId
      && String(item?.user_id || "") === userId
      && String(item?.group_id || "") === groupId
    ))

    if (filtered.length === list.length) {
      await e.reply(`${GAME_TITLE} 当前会话还没有订阅活动提醒`, true)
      return true
    }

    await setActivitySubList(filtered)
    await setActivitySeenList({ push_type: isGroup ? "group" : "private", push_target: isGroup ? groupId : userId, user_id: userId }, [])
    await e.reply(`${GAME_TITLE} 已取消活动提醒`, true)
    return true
  }

  async listActivityReminder() {
    const e = this.e
    const isGroup = !!e.isGroup
    const botId = String(e.self_id || "")
    const userId = String(e.user_id || "")
    const groupId = isGroup ? String(e.group_id || "") : ""
    const list = await getActivitySubList()
    const current = list.find(item => (
      String(item?.bot_id || "") === botId
      && String(item?.user_id || "") === userId
      && String(item?.group_id || "") === groupId
    ))

    if (!current) {
      await e.reply(`${GAME_TITLE} 当前会话未订阅活动提醒\n可用：${this.getCmdPrefixHint()}订阅活动提醒`, true)
      return true
    }

    const hours = getReminderHours(current)
    await e.reply(
      `${GAME_TITLE} 活动提醒订阅中\n推送位置：${isGroup ? "当前群聊" : "当前私聊"}\n提醒窗口：提前 ${hours} 小时\n取消订阅：${this.getCmdPrefixHint()}取消订阅活动提醒`,
      true,
    )
    return true
  }

  async runActivityReminderTask() {
    if (cfg.activity?.enableTask === false) return

    const list = await getActivitySubList()
    if (!list.length) return

    const data = await ensureListData()
    const activities = normalizeActivityEntries(data).filter(item => item.startTs || item.endTs)
    if (!activities.length) return

    const nowTs = Math.floor(Date.now() / 1000)
    for (const sub of list) {
      const seenList = await getActivitySeenList(sub)
      const seenSet = new Set(seenList)
      const windowHours = getReminderHours(sub)
      const windowSec = windowHours * 3600
      const lines = []

      for (const item of activities) {
        if (item.startTs > nowTs && item.startTs - nowTs <= windowSec) {
          const key = `start:${item.id}:${item.startTs}`
          if (!seenSet.has(key)) {
            seenSet.add(key)
            lines.push(`- 即将开启：${item.title}（${item.typeLabel}）`)
            lines.push(`  时间：${formatTime(item.startTs)} ~ ${formatTime(item.endTs)}`)
            if (item.targetName) lines.push(`  目标：${item.targetName}`)
            lines.push(`  开启：${formatRemainText(item.startTs, { nowTs, endedText: "已开启" })}`)
          }
        }

        if (item.endTs > nowTs && item.endTs - nowTs <= windowSec) {
          const key = `end:${item.id}:${item.endTs}`
          if (!seenSet.has(key)) {
            seenSet.add(key)
            lines.push(`- 即将结束：${item.title}（${item.typeLabel}）`)
            lines.push(`  时间：${formatTime(item.startTs)} ~ ${formatTime(item.endTs)}`)
            if (item.targetName) lines.push(`  目标：${item.targetName}`)
            lines.push(`  结束：${formatRemainText(item.endTs, { nowTs, endedText: "已结束" })}`)
          }
        }
      }

      await setActivitySeenList(sub, Array.from(seenSet).slice(-300))
      if (!lines.length) continue

      try {
        await sendActivityReminderMessage(sub, [`${GAME_TITLE} 活动提醒`, ...lines].join("\n"))
      } catch (err) {
        logger?.warn?.("[zmd-plugin] 活动提醒推送失败", sub?.push_target, err)
      }
    }
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

    const charWiki = await getCharWiki(realName, { ensureSections: ["介绍", "技能", "天赋", "潜能"].includes(keyword) })
    if (charWiki) {
      const lines = buildCharReplyByKeyword(charWiki, keyword)
      await e.reply((lines.length ? lines : buildCharSummaryReply(charWiki)).join("\n"), true)
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
