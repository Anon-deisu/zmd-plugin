/**
 * Friend API tools.
 *
 * This app exposes simple commands backed by the third-party `/friend/*` HTTP API
 * (see model/friendApi.js). It's mainly for debugging / manual querying.
 */
import plugin from "../../../lib/plugins/plugin.js"

import cfg from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import { getMessageText } from "../model/mention.js"
import { requestFriendApi, resolveFriendRoleId } from "../model/friendApi.js"

const GAME_TITLE = "[终末地]"

function safeInt(value, def = 0) {
  const n = Number.parseInt(`${value ?? ""}`, 10)
  return Number.isFinite(n) ? n : def
}

function safeFloat(value, def = 0) {
  const n = Number.parseFloat(`${value ?? ""}`)
  return Number.isFinite(n) ? n : def
}

function normalize(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
}

function fmtBool(v) {
  return v ? "是" : "否"
}

function formatTs(sec) {
  const s = safeInt(sec)
  if (s <= 0) return "-"
  const d = new Date(s * 1000)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

function buildCharPanelReport(panel, { url = "" } = {}) {
  const p = panel && typeof panel === "object" ? panel : {}
  const summary = p.summary && typeof p.summary === "object" ? p.summary : {}
  const ability = p.ability && typeof p.ability === "object" ? p.ability : {}
  const attack = p.attack_breakdown && typeof p.attack_breakdown === "object" ? p.attack_breakdown : {}
  const health = p.health_breakdown && typeof p.health_breakdown === "object" ? p.health_breakdown : {}
  const defense = p.defense_breakdown && typeof p.defense_breakdown === "object" ? p.defense_breakdown : {}
  const damage = p.damage_bonus_pct && typeof p.damage_bonus_pct === "object" ? p.damage_bonus_pct : {}

  const strength = safeInt(summary.strength)
  const agility = safeInt(summary.agility)
  const wisdom = safeInt(summary.wisdom)
  const will = safeInt(summary.will)

  const hp = safeInt(summary.hp)
  const atk = safeInt(summary.atk)
  const defe = safeInt(summary.def)
  const criticalRatePct = safeFloat(summary.critical_rate_pct)
  const criticalDamagePct = safeFloat(summary.critical_damage_pct)
  const physicalResist = safeInt(summary.physical_resist)
  const spellResist = safeInt(summary.spell_resist)
  const healTakenBonusPct = safeFloat(summary.heal_taken_bonus_pct)

  const mainAttr = ability.main_attr && typeof ability.main_attr === "object" ? ability.main_attr : {}
  const subAttr = ability.sub_attr && typeof ability.sub_attr === "object" ? ability.sub_attr : {}
  const mainAttrId = safeInt(mainAttr.id)
  const subAttrId = safeInt(subAttr.id)
  const mainName = String(mainAttr.name || "?")
  const subName = String(subAttr.name || "?")

  const atkMainPct = safeFloat(ability.atk_bonus_ratio_from_main) * 100
  const atkSubPct = safeFloat(ability.atk_bonus_ratio_from_sub) * 100

  const charHp = safeFloat(health.char_hp)
  const strHpBonus = safeFloat(health.strength_hp_bonus)
  const hpModel = safeFloat(health.hp_model)

  const baseAttack = safeFloat(attack.char_attack) + safeFloat(attack.weapon_attack)
  const flatBonus = safeFloat(attack.flat_bonus)
  const ratioBonusValue = safeFloat(attack.ratio_bonus_value)
  const ratioBonusPct = safeFloat(attack.ratio_bonus_pct)
  const totalBeforeAbility = safeFloat(attack.total_before_ability)
  const finalAttack = safeFloat(attack.final_attack_runtime)

  const allDmgReductionPct = safeFloat(defense.all_damage_reduction_pct)

  const normalSkillPct = safeFloat(damage.normal_skill)
  const comboSkillPct = safeFloat(damage.combo_skill)
  const ultimateSkillPct = safeFloat(damage.ultimate_skill)
  const brokenPct = safeFloat(damage.vs_broken_target)

  function attrEffectText(attrId) {
    if (attrId === 39) return `提供${strHpBonus.toFixed(0)}点基础生命值`
    if (attrId === 40) return `提供${physicalResist}点物理抗性`
    if (attrId === 41) return `提供${spellResist}点法术抗性`
    if (attrId === 42) return `提供${healTakenBonusPct.toFixed(1)}%受治疗效率加成`
    return ""
  }

  const lines = []
  if (url) lines.push(`URL: ${url}`)
  lines.push(`力量${strength} 敏捷${agility} 智识${wisdom} 意志${will}`)

  const mainParts = [`主属性：${mainName}`]
  const mainEffect = attrEffectText(mainAttrId)
  if (mainEffect) mainParts.push(mainEffect)
  mainParts.push(`提供${atkMainPct.toFixed(1)}%攻击力加成`)
  lines.push(mainParts.join("，"))

  const subParts = [`副属性：${subName}`]
  const subEffect = attrEffectText(subAttrId)
  if (subEffect) subParts.push(subEffect)
  subParts.push(`提供${atkSubPct.toFixed(1)}%攻击力加成`)
  lines.push(subParts.join("，"))

  const zhAttrLabel = { 39: "力量", 40: "敏捷", 41: "智识", 42: "意志" }
  for (const attrId of [39, 40, 41, 42]) {
    if (attrId === mainAttrId || attrId === subAttrId) continue
    const effect = attrEffectText(attrId)
    if (effect) lines.push(`${zhAttrLabel[attrId] || attrId}${effect}`)
  }

  lines.push(`生命值：干员生命值${charHp.toFixed(0)} + 力量提供生命${strHpBonus.toFixed(0)} = 基础生命值${hpModel.toFixed(0)}`)
  lines.push(
    `攻击力：基础攻击${baseAttack.toFixed(0)} + 固定加成${flatBonus.toFixed(0)} + 百分比加成${ratioBonusValue.toFixed(0)}(当前${ratioBonusPct.toFixed(1)}%) = 基础总值${totalBeforeAbility.toFixed(0)}，再叠加能力值加成（副属性+${atkSubPct.toFixed(1)}% 主属性+${atkMainPct.toFixed(1)}%）得到最终攻击${finalAttack.toFixed(0)}`,
  )
  lines.push(`防御力：${defe}，当前提供${allDmgReductionPct.toFixed(1)}%全伤害减免`)
  lines.push(`暴击率${criticalRatePct.toFixed(1)}% 暴击伤害${criticalDamagePct.toFixed(1)}%`)
  lines.push(`抗性：物理${physicalResist} 灼热${spellResist} 电磁${spellResist} 寒冷${spellResist} 自然${spellResist} 超域0`)
  lines.push(
    `增伤：受治疗效率${healTakenBonusPct.toFixed(1)}% 战技伤害${normalSkillPct.toFixed(1)}% 连携技伤害${comboSkillPct.toFixed(1)}% 终结技伤害${ultimateSkillPct.toFixed(1)}% 对失衡目标伤害${brokenPct.toFixed(1)}%`,
  )
  lines.push(`最终面板：生命${hp} 攻击${atk} 防御${defe}`)

  return lines
}

export class friend extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: "zmd-plugin-friend",
      dsc: "终末地 Friend API 查询",
      event: "message",
      priority: 5000,
      rule: [
        { reg: "^#?(?:终末地|zmd)(?:好友搜索|查好友|好友查找)\\s+(.+)$", fnc: "search", permission: "master" },
        { reg: "^#?(?:终末地|zmd)(?:好友详情|好友信息)\\s+(\\d+)$", fnc: "detail", permission: "master" },
        {
          reg: "^#?(?:终末地|zmd)(?:角色报告|面板报告|查角色)(高级|adv)?\\s+(\\d+)\\s+([\\w\\-]+)$",
          fnc: "charReport",
          permission: "master",
        },
      ],
    })
  }

  async search() {
    const e = this.e
    const msg = getMessageText(e, { stripAt: true })
    const m = msg.match(/^#?(?:终末地|zmd)(?:好友搜索|查好友|好友查找)\s+(.+)$/i)
    const raw = String(m?.[1] || "").trim()
    if (!raw) {
      await e.reply(`${GAME_TITLE} 用法：${cfg.cmd?.prefix || "#zmd"}好友搜索 <关键词|uid>`, true)
      return true
    }

    // /friend/search supports:
    // - keyword=xxx  (can be name#shortId)
    // - uid=123      (platform role id)
    let params = { keyword: raw }
    const uidMatch = raw.match(/^(?:uid|role_id)\s*[:=]?\s*(\d+)$/i)
    if (uidMatch?.[1]) {
      params = { uid: uidMatch[1] }
    } else if (/^\d{8,}$/.test(raw)) {
      params = { uid: raw }
    }

    const res = await requestFriendApi("/friend/search", params)
    if (!res.ok) {
      await e.reply(`${GAME_TITLE} Friend API 请求失败：${res.message || "unknown"}`, true)
      return true
    }

    const data = res.data || {}
    const items = Array.isArray(data.items) ? data.items : []
    if (!items.length) {
      await e.reply(`${GAME_TITLE} 未搜索到结果`, true)
      return true
    }

    const lines = [`${GAME_TITLE} 好友搜索结果（${items.length}/${safeInt(data.count) || items.length}）`]
    for (const it of items.slice(0, 10)) {
      lines.push(
        `- ${it.name || "-"} role_id=${it.role_id || "-"} short_id=${it.short_id || "-"} 等级=${it.adventure_level ?? "-"} 在线=${fmtBool(it.online)} 最近登录=${formatTs(it.last_login_time)}`,
      )
    }
    if (items.length > 10) lines.push(`（仅显示前10条，可换更精确关键词）`)
    await e.reply(lines.join("\n"), true)
    return true
  }

  async detail() {
    const e = this.e
    const msg = getMessageText(e, { stripAt: true })
    const m = msg.match(/^#?(?:终末地|zmd)(?:好友详情|好友信息)\s+(\d+)$/i)
    const roleId = String(m?.[1] || "").trim()
    if (!roleId) {
      await e.reply(`${GAME_TITLE} 用法：${cfg.cmd?.prefix || "#zmd"}好友详情 <role_id>`, true)
      return true
    }

    let resolvedRoleId = roleId
    let res = await requestFriendApi("/friend/detail", { role_id: resolvedRoleId })
    // If the caller passes uid instead of role_id, try resolving and retry.
    if (res.ok && !res.data?.role_profile) {
      try {
        const resolved = await resolveFriendRoleId(roleId)
        if (resolved?.ok && resolved.roleId && resolved.roleId !== roleId) {
          resolvedRoleId = resolved.roleId
          res = await requestFriendApi("/friend/detail", { role_id: resolvedRoleId })
        }
      } catch {}
    }
    if (!res.ok) {
      await e.reply(`${GAME_TITLE} Friend API 请求失败：${res.message || "unknown"}`, true)
      return true
    }

    const role = res.data?.role_profile || {}
    const chars = Array.isArray(role.char_data) ? role.char_data : []

    const lines = [
      `${GAME_TITLE} 好友详情`,
      `昵称: ${role.name || "-"}  short_id: ${role.short_id || "-"}`,
      `role_id: ${role.role_id || roleId}`,
      `等级: ${role.adventure_level ?? "-"}  在线: ${fmtBool(role.online)}`,
      `最近登录: ${formatTs(role.last_login_time)}  最近登出: ${formatTs(role.last_logout_time)}`,
    ]

    if (chars.length) {
      lines.push("\n角色列表：")
      for (const c of chars.slice(0, 30)) {
        const tid = c?.template_id || "-"
        const name = c?.template?.name_cn || c?.template?.name || tid
        const lv = c?.level ?? "-"
        const pot = c?.potential_level ?? "-"
        lines.push(`- ${name} (${tid}) Lv${lv} 潜能${pot}`)
      }
      if (chars.length > 30) lines.push("（仅显示前30个角色）")
    }

    await e.reply(lines.join("\n"), true)
    return true
  }

  async charReport() {
    const e = this.e
    const msg = getMessageText(e, { stripAt: true })
    const m = msg.match(/^#?(?:终末地|zmd)(?:角色报告|面板报告|查角色)(高级|adv)?\s+(\d+)\s+([\w\-]+)$/i)
    const advanced = Boolean(m?.[1])
    const roleId = String(m?.[2] || "").trim()
    const templateId = String(m?.[3] || "").trim()

    if (!roleId || !templateId) {
      await e.reply(`${GAME_TITLE} 用法：${cfg.cmd?.prefix || "#zmd"}角色报告 <role_id> <template_id>（可加 高级/adv）`, true)
      return true
    }

    let resolvedRoleId = roleId
    try {
      const resolved = await resolveFriendRoleId(roleId)
      if (resolved?.ok && resolved.roleId) resolvedRoleId = resolved.roleId
    } catch {}

    let res = await requestFriendApi(advanced ? "/friend/char_advanced" : "/friend/char", {
      role_id: resolvedRoleId,
      template_id: templateId,
    })
    if (!res.ok && advanced && res.message === "friendApi.http_404") {
      // Most deployments only provide the single /friend/char endpoint.
      res = await requestFriendApi("/friend/char", { role_id: resolvedRoleId, template_id: templateId })
    }
    if (!res.ok) {
      await e.reply(`${GAME_TITLE} Friend API 请求失败：${res.message || "unknown"}`, true)
      return true
    }

    const panel = res.data?.panel
    if (!panel || typeof panel !== "object") {
      await e.reply(`${GAME_TITLE} 返回中缺少 panel，请检查 template_id 是否正确`, true)
      return true
    }

    const found = res.data?.found
    const available = Array.isArray(res.data?.available_template_ids) ? res.data.available_template_ids : []
    const info = []
    if (found === false && available.length) info.push(`可用 template_id: ${available.slice(0, 8).join(", ")}${available.length > 8 ? " ..." : ""}`)

    const lines = buildCharPanelReport(panel, { url: res.url || "" })
    if (info.length) lines.push("\n" + info.join("\n"))
    await e.reply(lines.join("\n"), true)
    return true
  }
}
