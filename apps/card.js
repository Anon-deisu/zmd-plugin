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
import { buildPanelStatsFromFriendPanel, getFriendCharComputed, getFriendCharComputedByRoleId, getFriendDetail } from "../model/friendApi.js"
import { getActiveAccount } from "../model/store.js"
import { pluginResourcesRelPath } from "../model/pluginMeta.js"
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
        // 新用法：#<角色名>面板
        // 注意：TRSS 插件规则默认大小写敏感，因此需要同时排除 zmd/ZMD。
        { reg: "^#(?!终末地|zmd|ZMD|更新|刷新|查询|卡片)([\\w\\u4e00-\\u9fa5·_\\-]{1,20})\\s*面板(?:\\s*.*)?$", fnc: "panel" },
        // 兼容旧用法：#zmd面板 <角色名>
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

    const okText = result.stale ? "刷新失败（已使用缓存）" : "刷新成功"
    const tip = result.stale && result.error ? `\n${result.error}` : ""
    await e.reply(`${GAME_TITLE} ${okText}：${name} UID:${uid}${tip}`, true)
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
          copyright: `${GAME_TITLE}zmd-plugin & yuyu-bot`,
        },
        { scale: 1.2, quality: 100 },
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
    // 同时支持两种触发方式：
    // 1) #<角色名>面板（推荐）
    // 2) #zmd面板 <角色名>（旧用法）
    let query = ""
    const direct = msg.match(/^#(?!终末地|zmd|ZMD|更新|刷新|查询|卡片)([\w\u4e00-\u9fa5·_\-]{1,20})\s*面板(?:\s*.*)?$/i)
    if (direct?.[1]) query = String(direct[1]).trim()
    if (!query) query = msg.replace(/^#?(?:终末地|zmd)(?:面板|查询|mb)\s*/i, "").trim()
    if (!query) {
      await e.reply(`${GAME_TITLE} 用法：#角色名面板（推荐） 或 ${cfg.cmd?.prefix || "#zmd"}面板 <角色>`, true)
      return true
    }

    // Resolve aliases first so UID-only binding can also reuse the keyword.
    let resolved = null
    try {
      resolved = await resolveAliasEntry(query)
    } catch {}
    const resolvedId = String(resolved?.entry?.id || "").trim()
    const resolvedName = String(resolved?.entry?.name || resolved?.key || "").trim()

    // UID-only binding: use Friend API to render panel without Skland login.
    try {
      const { account } = await getActiveAccount(uid)
      if (account?.uidOnly && account?.uid && !account?.cred) {
        const friendEnabled = cfg.friendApi?.enable !== false && cfg.friendApi?.baseUrl
        if (!friendEnabled) {
          await e.reply(`${GAME_TITLE} 未配置 friendApi，无法使用 UID 绑定面板功能`, true)
          return true
        }

        const uidForFriend = String(account.uid || "").trim()
        if (!uidForFriend) {
          await e.reply(`${GAME_TITLE} 未绑定 UID，请先 ${cfg.cmd?.prefix || "#zmd"}绑定<UID>`, true)
          return true
        }

        const detail = await getFriendDetail({ uidOrRoleId: uidForFriend })
        if (!detail?.ok) {
          await e.reply(`${GAME_TITLE} 获取角色列表失败：${detail?.message || "unknown"}`, true)
          return true
        }

        const roleId = String(detail.roleId || "").trim()
        const profile = detail.profile && typeof detail.profile === "object" ? detail.profile : {}
        const charList = Array.isArray(detail.chars) ? detail.chars : []
        if (!roleId || !charList.length) {
          await e.reply(`${GAME_TITLE} 未找到可展示角色（Friend API 仅返回名片展示位）`, true)
          return true
        }

        const normalizeKey = raw =>
          String(raw || "")
            .trim()
            .toLowerCase()
            .replace(/[^0-9a-z\u4e00-\u9fff]+/gi, "")

        const normalizeTemplateId = raw => {
          const s = String(raw || "").trim()
          if (!s) return ""
          let m = s.match(/(?:chr|char)_(\d{1,4})_([a-z0-9]+)/i)
          if (!m) m = s.match(/^(\d{1,4})_([a-z0-9]+)$/i)
          if (!m?.[1] || !m?.[2]) return ""
          const num = String(m[1]).padStart(4, "0")
          const code = String(m[2]).toLowerCase()
          return `chr_${num}_${code}`
        }

        // 1) Prefer explicit template_id in message.
        let templateId = ""
        {
          const m1 = msg.match(/((?:chr|char)_\d{1,4}_[a-z0-9]+)/i)
          const m2 = msg.match(/(?:^|\s)(\d{1,4}_[a-z0-9]+)(?=\s|$)/i)
          templateId = normalizeTemplateId(m1?.[1] || m2?.[1] || "")
        }

        // 2) Match by visible character list.
        if (!templateId) {
          const q = normalizeKey(resolvedName || query)
          const exact = []
          const fuzzy = []
          for (const c of charList) {
            const tid = String(c?.template_id || "").trim().toLowerCase()
            if (!tid) continue
            const nameCn = String(c?.template?.name_cn || "").trim()
            const name = String(c?.template?.name || "").trim()
            const code = tid.replace(/^chr_\d{4}_/i, "")
            const keys = [normalizeKey(nameCn), normalizeKey(name), normalizeKey(tid), normalizeKey(code)].filter(Boolean)
            if (!keys.length) continue
            if (keys.some(k => k === q)) exact.push(tid)
            else if (keys.some(k => k.includes(q) || q.includes(k))) fuzzy.push(tid)
          }

          const uniq = list => Array.from(new Set(list))
          const exactU = uniq(exact)
          const fuzzyU = uniq(fuzzy)
          if (exactU.length === 1) templateId = exactU[0]
          else if (fuzzyU.length === 1) templateId = fuzzyU[0]
          else if (exactU.length > 1 || fuzzyU.length > 1) {
            const tids = exactU.length ? exactU : fuzzyU
            const names = tids
              .map(tid => {
                const c = charList.find(x => String(x?.template_id || "").trim().toLowerCase() === tid)
                const n1 = String(c?.template?.name_cn || "").trim()
                const n2 = String(c?.template?.name || "").trim()
                return n1 || n2 || tid
              })
              .filter(Boolean)
              .slice(0, 8)
            await e.reply(`${GAME_TITLE} 匹配到多个角色：${names.join(" / ")}\n请使用模板ID，例如：${cfg.cmd?.prefix || "#zmd"}面板 ${tids[0]}`, true)
            return true
          }
        }

        if (!templateId) {
          const list = charList
            .map(c => String(c?.template?.name_cn || c?.template?.name || c?.template_id || "").trim())
            .filter(Boolean)
            .slice(0, 8)
          await e.reply(
            `${GAME_TITLE} 未找到角色「${query}」\n可展示角色：${list.join(" / ") || "-"}\n提示：Friend API 仅返回名片展示位，可用模板ID查询，例如：${cfg.cmd?.prefix || "#zmd"}面板 chr_0005_chen`,
            true,
          )
          return true
        }

        const computed = await getFriendCharComputedByRoleId({ roleId, templateId })
        if (!computed?.ok || !computed.panel) {
          await e.reply(`${GAME_TITLE} 获取角色面板失败：${computed?.message || "unknown"}`, true)
          return true
        }

        const placeholder = "———"

        const stats = [
          { key: "hp", title: "生命", value: placeholder, base: "", plus: "" },
          { key: "atk", title: "攻击", value: placeholder, base: "", plus: "" },
          { key: "def", title: "防御", value: placeholder, base: "", plus: "" },
          { key: "speed", title: "敏捷", value: placeholder, base: "", plus: "" },
          { key: "str", title: "力量", value: placeholder, base: "", plus: "" },
          { key: "wis", title: "智识", value: placeholder, base: "", plus: "" },
          { key: "will", title: "意志", value: placeholder, base: "", plus: "" },
          { key: "cpct", title: "暴击率", value: placeholder, base: "", plus: "" },
          { key: "cdmg", title: "暴击伤害", value: placeholder, base: "", plus: "" },
          { key: "pres", title: "物抗", value: placeholder, base: "", plus: "" },
          { key: "sres", title: "法抗", value: placeholder, base: "", plus: "" },
          { key: "heal", title: "受治疗", value: placeholder, base: "", plus: "" },
        ]

        try {
          const fragments = buildPanelStatsFromFriendPanel(computed.panel)
          for (const s of stats) {
            const frag = fragments?.[s.key]
            if (!frag) continue
            if (frag.value) s.value = frag.value
            if (frag.base) s.base = frag.base
            if ((frag.value || frag.base) && frag.plus !== undefined && frag.plus !== null && frag.plus !== "") s.plus = frag.plus
          }
        } catch {}

        const cv = computed.charView && typeof computed.charView === "object" ? computed.charView : {}
        const charName = String(computed.charMeta?.nameCn || computed.charMeta?.name || resolvedName || query)

        const mainAttr = String(cv.mainAttrType || "").trim().toLowerCase()
        const propertyMap = {
          physical: "物理",
          electromagnetic: "电磁",
          electromagnetism: "电磁",
          electric: "电磁",
          heat: "灼热",
          fire: "灼热",
          thermal: "灼热",
          cold: "寒冷",
          ice: "寒冷",
          nature: "自然",
          natural: "自然",
        }
        const property = propertyMap[mainAttr] || "-"

        const skills = Array.isArray(cv.skills)
          ? cv.skills.slice(0, 8).map(s => ({ name: String(s?.name || ""), icon: "", level: Number(s?.level) || 1 }))
          : []

        const weaponRaw = String(cv.weapon?.rawName || "").trim()
        const weaponIcon = weaponRaw ? pluginResourcesRelPath(`endfield/itemiconbig/${weaponRaw}.png`) : ""
        const weapon = cv.weapon
          ? {
              name: String(cv.weapon?.name || "武器"),
              icon: weaponIcon,
              level: Number(cv.weapon?.level) || 0,
              rarity: 0,
              refine: Number(cv.weapon?.refine) || 0,
              breakthrough: Number(cv.weapon?.breakthrough) || 0,
              terms: Array.isArray(computed.weaponTerms) ? computed.weaponTerms : [],
            }
          : null

        const weaponStars = []

        const equipBySlot = new Map()
        if (Array.isArray(cv.equips)) {
          for (const eq of cv.equips) {
            const slot = Number(eq?.slot)
            if (!Number.isFinite(slot)) continue
            equipBySlot.set(slot, eq)
          }
        }

        const buildEquip = (slot, slotName) => {
          const eq = equipBySlot.get(slot)
          if (!eq) return null
          return { slotName, name: String(eq.name || placeholder), icon: "", level: "" }
        }

        const bodyEquip = buildEquip(1, "护甲")
        const equipSlots = [buildEquip(0, "护手"), buildEquip(2, "配件1"), buildEquip(3, "配件2")]
          .filter(Boolean)

        if (cv.tacticalItem?.name) {
          equipSlots.push({ slotName: "战术道具", name: String(cv.tacticalItem.name), icon: "", level: "" })
        }

        // Reuse the same equip detail filling logic.
        const slotIdBySlotName = {
          护手: 0,
          护甲: 1,
          配件1: 2,
          配件2: 3,
        }

        const equipItems = [bodyEquip, ...equipSlots]
          .filter(Boolean)
          .map(equip => {
            const slotName = String(equip?.slotName || "").trim()
            return {
              slotName,
              name: String(equip?.name || placeholder),
              icon: String(equip?.icon || ""),
              level: String(equip?.level || ""),
              slotId: Object.prototype.hasOwnProperty.call(slotIdBySlotName, slotName) ? slotIdBySlotName[slotName] : null,
              detail: { main: null, subs: [] },
            }
          })

        const friendEquipMods = Array.isArray(computed.equipMods) ? computed.equipMods : []
        const friendAttrNameMap = computed.attrNameMap && typeof computed.attrNameMap === "object" ? computed.attrNameMap : {}

        if (friendEquipMods.length) {
          try {
            const modsBySlot = new Map()
            for (const m of friendEquipMods) {
              const slot = Number(m?.slot)
              if (!Number.isFinite(slot) || slot < 0) continue
              if (!modsBySlot.has(slot)) modsBySlot.set(slot, [])
              modsBySlot.get(slot).push(m)
            }

            const fmtValue = (value, mode) => {
              const v = Number(value)
              if (!Number.isFinite(v)) return ""
              if (String(mode || "").toLowerCase() === "ratio") {
                const pct = v * 100
                const abs = Math.abs(pct)
                const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(1)
                return (pct >= 0 ? "+" : "-") + s + "%"
              }
              const abs = Math.abs(v)
              const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(1)
              return (v >= 0 ? "+" : "-") + s
            }

            const fmtAttr = mod => {
              if (!mod) return null
              const typeId = Number(mod.attr_type)
              const name =
                (Number.isFinite(typeId) && friendAttrNameMap?.[typeId] ? String(friendAttrNameMap[typeId]) : "") ||
                String(mod.attr_name || "") ||
                (Number.isFinite(typeId) ? `Attr${typeId}` : "属性")
              const val = fmtValue(mod.value, mod.mode)
              if (!name && !val) return null
              return { name: name || "属性", value: val }
            }

            for (const equip of equipItems) {
              const slotId = equip?.slotId
              if (slotId === null || slotId === undefined) continue
              const mods = modsBySlot.get(Number(slotId)) || []
              if (!mods.length) continue

              const main = mods.find(m => m.source === "equip_base" && Number(m.attr_index) === 0) ||
                mods.find(m => m.source === "equip_base") ||
                null
              const subs = mods
                .filter(m => m.source === "equip_display")
                .slice()
                .sort((a, b) => Number(a.attr_index) - Number(b.attr_index))
                .slice(0, 3)

              const mainObj = fmtAttr(main)
              if (mainObj) equip.detail.main = mainObj

              const subsObjs = subs.map(fmtAttr).filter(Boolean)
              equip.detail.subs = subsObjs.slice(0, 3)
            }
          } catch {}
        }

        const rarityStars = []
        const profession = "-"
        const weaponType = "-"
        const charTags = []

        const img = await renderImg(
          "enduid/panel",
          {
            elem: "sr",
            imgType: "png",
            charName,
            charUrl: "",
            rarityStars,
            property,
            profession,
            weaponType,
            charTags,
            level: Number(cv.level) || 0,
            evolvePhase: 0,
            potential: Number(cv.potential) || 0,
            skills,
            stats,
            weapon,
            weaponStars,
            bodyEquip,
            equipSlots,
            equipItems,
            userName: String(profile.name || account.nickname || "-"),
            userUid: uidForFriend,
            userLevel: profile.adventure_level ?? "-",
            userWorldLevel: "-",
            userAvatarUrl: "",
            time: "",
            subtitle: "",
            copyright: `${GAME_TITLE}zmd-plugin & yuyu-bot`,
          },
          { scale: 2, quality: 100 },
        )

        if (img) {
          await e.reply(img, true)
          return true
        }

        await e.reply(`${GAME_TITLE} 面板图片渲染失败`, true)
        return true
      }
    } catch {}

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

    // Optional: use friend API to补全面板数值（HP/ATK/DEF/暴击等）。
    // 失败时自动降级，不影响原有渲染。
    let friendPanel = null
    let friendEquipMods = []
    let friendAttrNameMap = {}
    let friendCharNameCn = ""
    let friendWeaponTerms = []
    try {
      await (async () => {
      const friendEnabled = cfg.friendApi?.enable !== false && cfg.friendApi?.baseUrl
      const uidForFriend = String(base.roleId || result.account.uid || "").trim()
      if (!friendEnabled || !uidForFriend) return

      const candidates = [
        cData.id,
        cData.templateId,
        cData.template_id,
        cData.rawName,
        cData.raw_name,
        cData.charId,
        cData.characterId,
        cData.character_id,
        char?.id,
      ]
        .map(v => String(v || "").trim())
        .filter(Boolean)

      const normalizeAscii = raw =>
        String(raw || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "")

      const normalizeName = raw =>
        String(raw || "")
          .trim()
          // Keep only CJK + ASCII letters/digits; remove punctuation/spaces.
          .replace(/[^0-9a-z\u4e00-\u9fff]+/gi, "")

      const normalizeCjk = raw =>
        String(raw || "")
          .trim()
          .replace(/[^\u4e00-\u9fff]+/g, "")

      const expectedName = String(cData?.name || resolvedName || query || "").trim()
      const expectedNorm = normalizeName(expectedName)
      const expectedCjk = normalizeCjk(expectedName)

      const normalizeTemplateId = raw => {
        const s = String(raw || "").trim()
        if (!s) return ""

        // Accept variations like:
        // - chr_9000_endmin
        // - Chr_5_Chen
        // - char_0009_azrila
        // - 9000_endmin (only when it's the whole token)
        // - chr_9000_endmin_NormalSkill (extracts chr_9000_endmin)
        let m = s.match(/(?:chr|char)_(\d{1,4})_([a-z0-9]+)/i)
        if (!m) m = s.match(/^(\d{1,4})_([a-z0-9]+)$/i)
        if (!m?.[1] || !m?.[2]) return ""

        const num = String(m[1]).padStart(4, "0")
        const code = String(m[2]).toLowerCase()
        return `chr_${num}_${code}`
      }

      const tryFetch = async templateId => {
        const tid = String(templateId || "").trim().toLowerCase()
        if (!tid) return false
        const res = await getFriendCharComputed({ roleId: uidForFriend, templateId: tid })
        if (!res?.ok || !res.panel) return false

        const gotNameCn = String(res.charMeta?.nameCn || "").trim()
        const gotNorm = normalizeName(gotNameCn)
        const gotCjk = normalizeCjk(gotNameCn)

        // Guarantee: only apply when friend char name matches the card char name.
        if (expectedCjk) {
          if (!gotCjk || gotCjk !== expectedCjk) return false
        } else if (expectedNorm) {
          if (!gotNorm || gotNorm !== expectedNorm) return false
        } else {
          if (!gotNorm) return false
        }

        friendCharNameCn = gotNameCn

        friendPanel = res.panel
        friendEquipMods = Array.isArray(res.equipMods) ? res.equipMods : []
        friendAttrNameMap = res.attrNameMap && typeof res.attrNameMap === "object" ? res.attrNameMap : {}
        friendWeaponTerms = Array.isArray(res.weaponTerms) ? res.weaponTerms : []
        return true
      }

      const tryFetchByRoleId = async (roleId, templateId) => {
        const rid = String(roleId || "").trim()
        const tid = String(templateId || "").trim().toLowerCase()
        if (!rid || !tid) return false

        const res = await getFriendCharComputedByRoleId({ roleId: rid, templateId: tid })
        if (!res?.ok || !res.panel) return false

        const gotNameCn = String(res.charMeta?.nameCn || "").trim()
        const gotNorm = normalizeName(gotNameCn)
        const gotCjk = normalizeCjk(gotNameCn)

        if (expectedCjk) {
          if (!gotCjk || gotCjk !== expectedCjk) return false
        } else if (expectedNorm) {
          if (!gotNorm || gotNorm !== expectedNorm) return false
        } else {
          if (!gotNorm) return false
        }

        friendCharNameCn = gotNameCn
        friendPanel = res.panel
        friendEquipMods = Array.isArray(res.equipMods) ? res.equipMods : []
        friendAttrNameMap = res.attrNameMap && typeof res.attrNameMap === "object" ? res.attrNameMap : {}
        friendWeaponTerms = Array.isArray(res.weaponTerms) ? res.weaponTerms : []
        return true
      }

      // 1) Quick path: parse template_id from message / card detail.
      let templateId = ""
      {
        const m1 = msg.match(/((?:chr|char)_\d{1,4}_[a-z0-9]+)/i)
        const m2 = msg.match(/(?:^|\s)(\d{1,4}_[a-z0-9]+)(?=\s|$)/i)
        templateId = normalizeTemplateId(m1?.[1] || m2?.[1] || "")
      }
      if (!templateId) {
        for (const v of candidates) {
          templateId = normalizeTemplateId(v)
          if (templateId) break
        }
      }

      if (!templateId) {
        // Fallback: template id may appear in nested strings (URLs/skill ids).
        try {
          const text = JSON.stringify({ cData, char })
          const m = text.match(/((?:chr|char)_\d{1,4}_[a-z0-9]+)/i)
          if (m?.[1]) templateId = normalizeTemplateId(m[1])
        } catch {}
      }

      // Try direct fetch first.
      if (templateId) {
        await tryFetch(templateId)
        if (friendPanel) return
      }

      // 2) Robust mapping: uid -> role_id -> detail(char list) -> pick template_id -> fetch.
      if (!friendPanel) {
        const detail = await getFriendDetail({ uidOrRoleId: uidForFriend })
        const resolvedRoleId = String(detail?.roleId || "").trim()
        const charList = Array.isArray(detail?.chars) ? detail.chars : []
        if (!resolvedRoleId || !charList.length) return

        const tids = charList
          .map(c => String(c?.template_id || "").trim().toLowerCase())
          .filter(Boolean)

        // Prefer name->template_id mapping from /friend/detail.
        if (expectedCjk) {
          const hits = charList
            .map(c => ({
              tid: String(c?.template_id || "").trim().toLowerCase(),
              nameCn: String(c?.template?.name_cn || "").trim(),
            }))
            .filter(x => x.tid && normalizeCjk(x.nameCn) === expectedCjk)
            .map(x => x.tid)
          const uniq = Array.from(new Set(hits))
          if (uniq.length === 1) {
            await tryFetchByRoleId(resolvedRoleId, uniq[0])
            if (friendPanel) return
          }
        }

        // Build an ordered candidate list. We will try each template_id and only accept
        // if /friend/char returns a matching `name_cn`.
        const ordered = []
        const push = v => {
          const s = String(v || "").trim().toLowerCase()
          if (!s) return
          if (!ordered.includes(s)) ordered.push(s)
        }

        // Prefer obvious ones first.
        if (expectedName && /管理员/i.test(expectedName)) {
          tids.filter(t => t.endsWith("_endmin")).forEach(push)
        }

        // Prefer numeric id matches.
        const rawId = cData.id ?? char?.id
        const n = Number.parseInt(String(rawId ?? "").trim(), 10)
        if (Number.isFinite(n) && n >= 0 && n <= 9999) {
          const prefix = `chr_${String(n).padStart(4, "0")}_`
          tids.filter(t => t.startsWith(prefix)).forEach(push)
        }

        // Prefer raw/english tokens.
        const rawTokens = [
          cData.rawName,
          cData.raw_name,
          cData.enName,
          cData.en_name,
          cData.nameEn,
          cData.name_en,
        ]
          .map(normalizeAscii)
          .filter(Boolean)
        if (rawTokens.length) {
          for (const t of tids) {
            const m = t.match(/^chr_\d{4}_([a-z0-9]+)$/)
            const code = normalizeAscii(m?.[1] || "")
            if (code && rawTokens.some(x => x === code || x.includes(code) || code.includes(x))) push(t)
          }
        }

        // Prefer level/potential matches.
        const lv = Number(char?.level) || 0
        const pot = Number(char?.potentialLevel) || 0
        if (lv > 0) {
          for (const c of charList) {
            const clv = Number(c?.level) || 0
            const cpot = Number(c?.potential_level ?? c?.potentialLevel) || 0
            if (clv === lv && cpot === pot) push(c?.template_id)
          }
        }

        // Finally, try every template_id from char list.
        tids.forEach(push)

        for (const tid of ordered) {
          await tryFetchByRoleId(resolvedRoleId, tid)
          if (friendPanel) break
        }
      }
      })()
    } catch {}

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
            terms: Array.isArray(friendWeaponTerms) ? friendWeaponTerms : [],
          }
        : null

    function equipToView(slotName, equip) {
      const data = equip?.equipData
      if (!data?.name) return null
      const lv0 = pickValue(data.level)
      const lv = lv0 === 0 || lv0 ? String(lv0).trim() : ""
      return {
        slotName,
        name: String(data.name || ""),
        icon: String(data.iconUrl || "").trim(),
        level: lv,
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

    const placeholder = "———"

    const stats = [
      { key: "hp", title: "生命", value: placeholder, base: "", plus: "" },
      { key: "atk", title: "攻击", value: placeholder, base: "", plus: "" },
      { key: "def", title: "防御", value: placeholder, base: "", plus: "" },
      { key: "speed", title: "敏捷", value: placeholder, base: "", plus: "" },
      { key: "str", title: "力量", value: placeholder, base: "", plus: "" },
      { key: "wis", title: "智识", value: placeholder, base: "", plus: "" },
      { key: "will", title: "意志", value: placeholder, base: "", plus: "" },
      { key: "cpct", title: "暴击率", value: placeholder, base: "", plus: "" },
      { key: "cdmg", title: "暴击伤害", value: placeholder, base: "", plus: "" },
      { key: "pres", title: "物抗", value: placeholder, base: "", plus: "" },
      { key: "sres", title: "法抗", value: placeholder, base: "", plus: "" },
      { key: "heal", title: "受治疗", value: placeholder, base: "", plus: "" },
    ]

    if (friendPanel) {
      try {
        const fragments = buildPanelStatsFromFriendPanel(friendPanel)
        for (const s of stats) {
          const frag = fragments?.[s.key]
          if (!frag) continue
          if (frag.value) s.value = frag.value
          if (frag.base) s.base = frag.base
          // plus 允许为 "0"（显示 +0），但必须有 value/base 才写入。
          if ((frag.value || frag.base) && frag.plus !== undefined && frag.plus !== null && frag.plus !== "") s.plus = frag.plus
        }
      } catch {}
    }

    const slotIdBySlotName = {
      护手: 0,
      护甲: 1,
      配件1: 2,
      配件2: 3,
    }

    const equipItems = [bodyEquip, ...equipSlots]
      .filter(Boolean)
      .map(equip => {
        const slotName = String(equip?.slotName || "").trim()
        return {
          slotName,
          name: String(equip?.name || placeholder),
          icon: String(equip?.icon || ""),
          level: String(equip?.level || ""),
          // Friend API equip slot mapping: 0=护手 1=护甲 2=配件1 3=配件2
          slotId: Object.prototype.hasOwnProperty.call(slotIdBySlotName, slotName) ? slotIdBySlotName[slotName] : null,
          detail: {
            // main/subs are omitted when unavailable to avoid placeholder noise in UI.
            main: null,
            subs: [],
          },
        }
      })

    // Try to fill装备属性展示（main + 3 subs） from friend API runtime modifiers.
    if (friendEquipMods.length) {
      try {
        const modsBySlot = new Map()
        for (const m of friendEquipMods) {
          const slot = Number(m?.slot)
          if (!Number.isFinite(slot) || slot < 0) continue
          if (!modsBySlot.has(slot)) modsBySlot.set(slot, [])
          modsBySlot.get(slot).push(m)
        }

        const fmtValue = (value, mode) => {
          const v = Number(value)
          if (!Number.isFinite(v)) return ""
          if (String(mode || "").toLowerCase() === "ratio") {
            const pct = v * 100
            const abs = Math.abs(pct)
            const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(1)
            return (pct >= 0 ? "+" : "-") + s + "%"
          }
          const abs = Math.abs(v)
          const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(1)
          return (v >= 0 ? "+" : "-") + s
        }

        const fmtAttr = mod => {
          if (!mod) return null
          const typeId = Number(mod.attr_type)
          const name =
            (Number.isFinite(typeId) && friendAttrNameMap?.[typeId] ? String(friendAttrNameMap[typeId]) : "") ||
            String(mod.attr_name || "") ||
            (Number.isFinite(typeId) ? `Attr${typeId}` : "属性")
          const val = fmtValue(mod.value, mod.mode)
          if (!name && !val) return null
          return { name: name || "属性", value: val }
        }

        for (const equip of equipItems) {
          const slotId = equip?.slotId
          if (slotId === null || slotId === undefined) continue
          const mods = modsBySlot.get(Number(slotId)) || []
          if (!mods.length) continue

          const main = mods.find(m => m.source === "equip_base" && Number(m.attr_index) === 0) ||
            mods.find(m => m.source === "equip_base") ||
            null
          const subs = mods
            .filter(m => m.source === "equip_display")
            .slice()
            .sort((a, b) => Number(a.attr_index) - Number(b.attr_index))
            .slice(0, 3)

          const mainObj = fmtAttr(main)
          if (mainObj) equip.detail.main = mainObj

          const subsObjs = subs.map(fmtAttr).filter(Boolean)
          equip.detail.subs = subsObjs.slice(0, 3)
        }
      } catch {}
    }

    try {
      const charUrl = String(cData.illustrationUrl || cData.avatarRtUrl || cData.avatarSqUrl || "").trim()

      const charTags = Array.isArray(cData.tags) ? cData.tags.slice(0, 12).map(t => String(t).trim()).filter(Boolean) : []

      const img = await renderImg(
        "enduid/panel",
        {
          elem: "sr",
          imgType: "png",
          // If Friend API data is used, use its name_cn to guarantee name-data consistency.
          charName: String(friendCharNameCn || cData.name || query),
          charUrl,
          rarityStars,
          property: String(pickValue(cData.property) || "-"),
          profession: String(pickValue(cData.profession) || "-"),
          weaponType: String(pickValue(cData.weaponType) || "-"),
          charTags,
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
          copyright: `${GAME_TITLE}zmd-plugin & yuyu-bot`,
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
