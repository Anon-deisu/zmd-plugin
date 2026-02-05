/**
 * 卡片/面板指令入口。
 *
 * 主要负责：
 * - 解析用户输入（UID / 别名）
 * - 调用 model/card.js 获取数据
 * - 调用 model/render.js 渲染图片
 */
import plugin from "../../../lib/plugins/plugin.js"

import cfg from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import { render as renderImg } from "../model/render.js"
import { getCardDetailForUser } from "../model/card.js"
import { resolveAliasEntry } from "../model/alias.js"
import { getMessageText, getQueryUserId } from "../model/mention.js"

const GAME_TITLE = "[终末地]"

function safeInt(value, def = 0) {
  const n = Number.parseInt(`${value ?? ""}`, 10)
  return Number.isFinite(n) ? n : def
}

function pickValue(kv) {
  if (!kv) return ""
  if (typeof kv === "string" || typeof kv === "number") return String(kv)
  return kv.value ?? kv.name ?? kv.key ?? ""
}

function normalize(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
}

function matchCharByQuery(chars, query) {
  const q = normalize(query)
  if (!q) return { type: "none" }

  const exact = []
  const fuzzy = []
  for (const c of chars || []) {
    const name = String(c?.charData?.name || "").trim()
    const n = normalize(name)
    if (!n) continue
    if (n === q) exact.push(c)
    else if (n.includes(q) || q.includes(n)) fuzzy.push(c)
  }

  if (exact.length === 1) return { type: "one", char: exact[0] }
  if (exact.length > 1) return { type: "many", chars: exact }
  if (fuzzy.length === 1) return { type: "one", char: fuzzy[0] }
  if (fuzzy.length > 1) return { type: "many", chars: fuzzy }
  return { type: "none" }
}

function formatTs(ts) {
  const t = Number(ts) || 0
  if (t <= 0) return ""
  const d = new Date(t > 10_000_000_000 ? t : t * 1000)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${mm}-${dd}`
}

function formatYmd(ts) {
  const t = Number(ts) || 0
  if (t <= 0) return ""
  const sec = t > 10_000_000_000 ? Math.floor(t / 1000) : t
  const d = new Date(sec * 1000)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

function formatYmdHm(tsSec) {
  const sec = Number(tsSec) || 0
  if (sec <= 0) return ""
  const d = new Date(sec * 1000)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

function rarityColor(rarity) {
  const r = Number(rarity) || 0
  if (r >= 6) return "#ff4e20"
  if (r === 5) return "#ffc900"
  if (r === 4) return "#a366ff"
  if (r === 3) return "#0091ff"
  return "rgba(255,255,255,0.20)"
}

export class card extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: "zmd-plugin-card",
      dsc: "终末地卡片/面板",
      event: "message",
      priority: 5000,
      rule: [
        { reg: "^#?(?:终末地|zmd)(?:刷新|更新|刷新数据|刷新面板|upd)$", fnc: "refresh" },
        { reg: "^#?(?:终末地|zmd)(?:卡片|kp|card)(?:\\s*.*)?$", fnc: "card" },
        { reg: "^#?(?:终末地|zmd)(?:面板|查询|mb)\\s*(.+)$", fnc: "panel" },
      ],
    })
  }

  async refresh() {
    const e = this.e
    const result = await getCardDetailForUser(e.user_id, { force: true })
    if (!result.ok) {
      await e.reply(result.message, true)
      return true
    }

    const base = result.res?.data?.detail?.base || {}
    const name = base.name || result.account.nickname || result.account.uid
    const uid = base.roleId || result.account.uid

    await e.reply(`${GAME_TITLE} 刷新成功：${name} UID:${uid}`, true)
    return true
  }

  async card() {
    const e = this.e
    const uid = getQueryUserId(e)
    const result = await getCardDetailForUser(uid)
    if (!result.ok) {
      await e.reply(result.message, true)
      return true
    }

    const detail = result.res?.data?.detail || {}
    const base = detail.base || {}
    const achieve = detail.achieve || {}
    const chars = Array.isArray(detail.chars) ? detail.chars : []
    const domains = Array.isArray(detail.domain) ? detail.domain : []
    const currentTs = safeInt(detail.currentTs)

    let etherTotal = 0
    let trchestTotal = 0
    let pieceTotal = 0
    let blackboxTotal = 0
    let domainLevel = 0
    for (const d of domains) {
      domainLevel = Math.max(domainLevel, Number(d?.level) || 0)
      for (const c of d?.collections || []) {
        etherTotal += Number(c?.puzzleCount) || 0
        trchestTotal += Number(c?.trchestCount) || 0
        pieceTotal += Number(c?.pieceCount) || 0
        blackboxTotal += Number(c?.blackboxCount) || 0
      }
    }

    const mainMission = base?.mainMission?.description || base?.mainMission?.id || ""

    const cardChars = chars
      .slice()
      .sort((a, b) => (Number(b?.level) || 0) - (Number(a?.level) || 0))
      .slice(0, 25)
      .map(c => {
        const cData = c?.charData || {}
        const rarity = safeInt(pickValue(cData.rarity), 1)
        return {
          name: String(cData.name || "-"),
          avatar: String(cData.avatarSqUrl || cData.avatarRtUrl || "").trim(),
          rarity,
          rarityColor: rarityColor(rarity),
          level: Number(c?.level) || 0,
          potentialLevel: Number(c?.potentialLevel) || 0,
          property: String(pickValue(cData.property) || "-"),
          profession: String(pickValue(cData.profession) || "-"),
        }
      })

    try {
      const img = await renderImg(
        "enduid/card",
        {
          name: String(base.name || result.account.nickname || "-"),
          uid: String(base.roleId || result.account.uid || "-"),
          avatarUrl: String(base.avatarUrl || "").trim(),
          createTime: base.createTime ? formatYmd(base.createTime) : "",
          mainMission: String(mainMission || ""),
          level: base.level ?? "-",
          worldLevel: base.worldLevel ?? "-",
          charNum: base.charNum ?? chars.length ?? "-",
          weaponNum: base.weaponNum ?? "-",
          docNum: base.docNum ?? "-",
          achieveCount: safeInt(achieve.count),
          domainLevel,
          puzzleTotal: etherTotal,
          trchestTotal,
          pieceTotal,
          blackboxTotal,
          chars: cardChars,
          time: currentTs ? formatYmdHm(currentTs) : "",
          subtitle: `${GAME_TITLE} 卡片`,
          copyright: `${GAME_TITLE} zmd-plugin`,
        },
        { scale: 1, quality: 100 },
      )
      if (img) {
        await e.reply(img, true)
        return true
      }
    } catch (err) {
      logger.error(`${GAME_TITLE} 卡片图片渲染失败：${err?.message || err}`)
    }

    const top = chars
      .slice()
      .sort((a, b) => (Number(b?.level) || 0) - (Number(a?.level) || 0))
      .slice(0, 12)
      .map(c => {
        const name = c?.charData?.name || "-"
        const level = Number(c?.level) || 0
        const rarity = pickValue(c?.charData?.rarity)
        return `${name} Lv${level}${rarity ? ` ${rarity}` : ""}`.trim()
      })

    const lines = [
      `${GAME_TITLE} 卡片${result.fromCache ? "（缓存）" : ""}`,
      `昵称: ${base.name || result.account.nickname || "-"}`,
      `UID: ${base.roleId || result.account.uid || "-"}`,
      `等级: ${base.level ?? "-"}  世界等级: ${base.worldLevel ?? "-"}`,
      base.createTime ? `注册: ${formatTs(base.createTime)}` : "",
      mainMission ? `主线: ${mainMission}` : "",
      `角色: ${base.charNum ?? chars.length ?? "-"}  武器: ${base.weaponNum ?? "-"}  文档: ${base.docNum ?? "-"}`,
      `成就: ${safeInt(achieve.count)}  区域等级: ${domainLevel}`,
      `收藏: 拼图${etherTotal} 宝箱${trchestTotal} 碎片${pieceTotal} 黑盒${blackboxTotal}`,
      top.length ? `角色(前${top.length}): ${top.join(" / ")}` : "",
    ]
      .filter(Boolean)
      .join("\n")

    await e.reply(lines, true)
    return true
  }

  async panel() {
    const e = this.e
    const uid = getQueryUserId(e)
    const msg = getMessageText(e, { stripAt: true })
    const query = msg.replace(/^#?(?:终末地|zmd)(?:面板|查询|mb)\s*/i, "").trim()
    if (!query) {
      await e.reply(`${GAME_TITLE} 用法：${cfg.cmd?.prefix || "#zmd"}面板 <角色>`, true)
      return true
    }

    const result = await getCardDetailForUser(uid)
    if (!result.ok) {
      await e.reply(result.message, true)
      return true
    }

    const chars = Array.isArray(result.res?.data?.detail?.chars) ? result.res.data.detail.chars : []
    if (!chars.length) {
      await e.reply(`${GAME_TITLE} 卡片数据为空，请先 ${cfg.cmd?.prefix || "#zmd"}刷新`, true)
      return true
    }

    let char = null
    const resolved = await resolveAliasEntry(query)
    const resolvedId = String(resolved?.entry?.id || "").trim()
    const resolvedName = String(resolved?.entry?.name || resolved?.key || "").trim()

    if (resolvedId) {
      char = chars.find(c => String(c?.charData?.id || c?.id || "").trim() === resolvedId) || null
    }
    if (!char && resolvedName) {
      char = chars.find(c => String(c?.charData?.name || "").trim() === resolvedName) || null
    }
    if (!char) {
      const match = matchCharByQuery(chars, query)
      if (match.type === "one") char = match.char
      if (match.type === "many") {
        const list = match.chars.slice(0, 8).map(c => c?.charData?.name || "-")
        await e.reply(`${GAME_TITLE} 匹配到多个角色：${list.join(" / ")}\n请更精确一点`, true)
        return true
      }
    }

    if (!char) {
      await e.reply(`${GAME_TITLE} 未找到角色「${query}」，可先 ${cfg.cmd?.prefix || "#zmd"}刷新`, true)
      return true
    }

    const base = result.res?.data?.detail?.base || {}
    const currentTs = safeInt(result.res?.data?.detail?.currentTs)

    const cData = char?.charData || {}
    const userSkills = char?.userSkills || {}
    const skills = Array.isArray(cData.skills) ? cData.skills : []

    const weaponData = char?.weapon?.weaponData || {}
    const weaponName = weaponData?.name || ""
    const weaponLv = Number(char?.weapon?.level) || 0
    const refine = Number(char?.weapon?.refineLevel) || 0
    const breakLv = Number(char?.weapon?.breakthroughLevel) || 0

    const rarity = safeInt(pickValue(cData.rarity), 1)
    const rarityStars = Array(Math.max(0, rarity)).fill(1)

    const skillData = skills.slice(0, 8).map(s => {
      const sid = String(s?.id || "").trim()
      const lv = sid && userSkills?.[sid]?.level ? Number(userSkills[sid].level) : 1
      return {
        name: String(s?.name || sid || "技能"),
        icon: String(s?.iconUrl || "").trim(),
        level: lv,
      }
    })

    const weaponRarity = safeInt(pickValue(weaponData.rarity), 0)
    const weaponStars = Array(Math.max(0, weaponRarity)).fill(1)
    const weapon =
      weaponName || weaponData?.iconUrl
        ? {
            name: String(weaponName || "武器"),
            icon: String(weaponData?.iconUrl || "").trim(),
            level: weaponLv,
            rarity: weaponRarity,
            refine,
            breakthrough: breakLv,
          }
        : null

    function equipToView(slotName, equip) {
      const data = equip?.equipData
      if (!data?.name) return null
      return {
        slotName,
        name: String(data.name || ""),
        icon: String(data.iconUrl || "").trim(),
        level: String(pickValue(data.level) || "").trim(),
      }
    }

    const bodyEquip = equipToView("护甲", char?.bodyEquip)
    const equipSlots = [
      equipToView("护手", char?.armEquip),
      equipToView("配件1", char?.firstAccessory),
      equipToView("配件2", char?.secondAccessory),
      char?.tacticalItem?.tacticalItemData?.name
        ? {
            slotName: "战术道具",
            name: String(char.tacticalItem.tacticalItemData.name),
            icon: String(char.tacticalItem.tacticalItemData.iconUrl || "").trim(),
            level: "",
          }
        : null,
    ]
      .filter(Boolean)
      .slice(0, 4)

    while (equipSlots.length < 4) equipSlots.push(null)

    const placeholder = "———"

    const stats = [
      { key: "hp", title: "生命", value: placeholder, base: placeholder, plus: placeholder },
      { key: "atk", title: "攻击", value: placeholder, base: placeholder, plus: placeholder },
      { key: "def", title: "防御", value: placeholder, base: placeholder, plus: placeholder },
      { key: "speed", title: "速度", value: placeholder, base: placeholder, plus: placeholder },
      { key: "cpct", title: "暴击率", value: placeholder, base: placeholder, plus: placeholder },
      { key: "cdmg", title: "暴击伤害", value: placeholder, base: placeholder, plus: placeholder },
    ]

    const equipDefaults = [
      { slotName: "护甲" },
      { slotName: "护手" },
      { slotName: "配件1" },
      { slotName: "配件2" },
      { slotName: "战术道具" },
    ]

    const equipItems = [bodyEquip, ...equipSlots].map((equip, idx) => {
      const baseInfo = equipDefaults[idx] || { slotName: `装备${idx + 1}` }
      return {
        slotName: String(equip?.slotName || baseInfo.slotName || ""),
        name: String(equip?.name || placeholder),
        icon: String(equip?.icon || ""),
        level: String(equip?.level || ""),
        detail: {
          main: placeholder,
          subs: [placeholder, placeholder, placeholder],
        },
      }
    })

    try {
      const charUrl = String(cData.illustrationUrl || cData.avatarRtUrl || cData.avatarSqUrl || "").trim()
      const img = await renderImg(
        "enduid/panel",
        {
          elem: "sr",
          imgType: "png",
          charName: String(cData.name || query),
          charUrl,
          rarityStars,
          property: String(pickValue(cData.property) || "-"),
          profession: String(pickValue(cData.profession) || "-"),
          weaponType: String(pickValue(cData.weaponType) || "-"),
          charTags: Array.isArray(cData.tags) ? cData.tags.slice(0, 8).map(t => String(t)) : [],
          level: Number(char.level) || 0,
          evolvePhase: Number(char.evolvePhase) || 0,
          potential: Number(char.potentialLevel) || 0,
          skills: skillData,
          stats,
          weapon,
          weaponStars,
          bodyEquip,
          equipSlots,
          equipItems,
          userName: String(base.name || result.account.nickname || "-"),
          userUid: String(base.roleId || result.account.uid || "-"),
          userLevel: base.level ?? "-",
          userWorldLevel: base.worldLevel ?? "-",
          userAvatarUrl: String(base.avatarUrl || "").trim(),
          time: currentTs ? formatYmdHm(currentTs) : "",
          subtitle: `${GAME_TITLE} 面板`,
          copyright: `${GAME_TITLE} zmd-plugin`,
        },
        { scale: 2, quality: 100 },
      )
      if (img) {
        await e.reply(img, true)
        return true
      }
    } catch (err) {
      logger.error(`${GAME_TITLE} 面板图片渲染失败：${err?.message || err}`)
    }

    function formatEquip(label, equip) {
      const data = equip?.equipData
      if (!data?.name) return ""
      const lv = pickValue(data.level)
      return `${label}: ${data.name}${lv ? ` Lv${lv}` : ""}`.trim()
    }

    const equips = [
      formatEquip("护甲", char?.bodyEquip),
      formatEquip("护手", char?.armEquip),
      formatEquip("配件1", char?.firstAccessory),
      formatEquip("配件2", char?.secondAccessory),
      char?.tacticalItem?.tacticalItemData?.name ? `战术道具: ${char.tacticalItem.tacticalItemData.name}` : "",
    ].filter(Boolean)

    const skillLines = skills.slice(0, 10).map(s => {
      const sid = String(s?.id || "").trim()
      const lv = sid && userSkills?.[sid]?.level ? Number(userSkills[sid].level) : 1
      return `- ${s?.name || sid || "技能"} Lv${lv}`
    })

    const lines = [
      `${GAME_TITLE} 面板`,
      `角色: ${cData.name || query}`,
      `稀有度: ${pickValue(cData.rarity) || "-"}`,
      `职业: ${pickValue(cData.profession) || "-"}`,
      `属性: ${pickValue(cData.property) || "-"}`,
      `武器类型: ${pickValue(cData.weaponType) || "-"}`,
      `等级: ${Number(char.level) || 0}  潜能: ${Number(char.potentialLevel) || 0}  突破: ${Number(char.evolvePhase) || 0}`,
      weaponName ? `武器: ${weaponName} Lv${weaponLv}${breakLv ? ` 突破${breakLv}` : ""}${refine ? ` 精${refine}` : ""}` : "",
      equips.length ? `装备: ${equips.join(" / ")}` : "",
      cData.tags?.length ? `Tag: ${(cData.tags || []).slice(0, 8).join(" / ")}` : "",
      skillLines.length ? ["技能：", ...skillLines].join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n")

    await e.reply(lines, true)
    return true
  }
}
