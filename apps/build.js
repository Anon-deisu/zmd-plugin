import plugin from "../../../lib/plugins/plugin.js"

import cfg from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import { render as renderImg } from "../model/render.js"
import { getCardDetailForUser } from "../model/card.js"
import { getMessageText, getQueryUserId } from "../model/mention.js"

const GAME_TITLE = "[终末地]"

function safeInt(value, def = 0) {
  const n = Number.parseInt(`${value ?? ""}`, 10)
  return Number.isFinite(n) ? n : def
}

function splitCommaList(text) {
  return String(text || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
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

export class build extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: "zmd-plugin-build",
      dsc: "终末地基建/飞船",
      event: "message",
      priority: 5000,
      rule: [{ reg: "^#?(?:终末地|zmd)(?:基建|建设|地区建设|jj)\\s*(.*)$", fnc: "build" }],
    })
  }

  async build() {
    const e = this.e
    const uid = getQueryUserId(e)
    const msg = getMessageText(e, { stripAt: true })
    const arg = msg.replace(/^#?(?:终末地|zmd)(?:基建|建设|地区建设|jj)/i, "").trim()
    const verbose = /^(详细|详情|详|all)$/i.test(arg)

    const result = await getCardDetailForUser(uid)
    if (!result.ok) {
      await e.reply(result.message, true)
      return true
    }

    const detail = result.res?.data?.detail || {}
    const base = detail.base || {}
    const domains = Array.isArray(detail.domain) ? detail.domain : []
    const rooms = Array.isArray(detail.spaceShip?.rooms) ? detail.spaceShip.rooms : []
    const chars = Array.isArray(detail.chars) ? detail.chars : []
    const currentTs = safeInt(detail.currentTs)

    if (!domains.length && !rooms.length) {
      const lines = [
        `${GAME_TITLE} 基建`,
        `昵称: ${base.name || result.account.nickname || "-"}`,
        `UID: ${base.roleId || result.account.uid || "-"}`,
        `暂无基建数据，请先 ${cfg.cmd?.prefix || "#zmd"}刷新`,
      ].join("\n")
      await e.reply(lines, true)
      return true
    }

    const charNameMap = new Map()
    const charAvatarMap = new Map()
    for (const c of chars) {
      const id = String(c?.charData?.id || c?.id || "").trim()
      const name = String(c?.charData?.name || "").trim()
      if (id && name) charNameMap.set(id, name)
      const avatar = String(c?.charData?.avatarSqUrl || c?.charData?.avatarRtUrl || "").trim()
      if (id && avatar) charAvatarMap.set(id, avatar)
    }

    try {
      const maxDomains = verbose ? 12 : 9
      const maxSettlements = verbose ? 4 : 3
      const maxOfficers = verbose ? 6 : 4
      const maxRooms = verbose ? 12 : 8
      const maxRoomChars = verbose ? 6 : 4

      const roomsView = rooms.slice(0, maxRooms).map(r => {
        const rChars = Array.isArray(r?.chars) ? r.chars : []
        const list = rChars.slice(0, maxRoomChars).map(x => {
          const id = String(x?.charId || "").trim()
          const name = id ? charNameMap.get(id) || id.slice(0, 8) : "未知"
          const avatar = id ? charAvatarMap.get(id) || "" : ""
          return { name, avatar }
        })
        return {
          id: String(r?.id || ""),
          type: String(r?.type ?? "-"),
          level: safeInt(r?.level),
          chars: list,
        }
      })

      const domainsView = domains.slice(0, maxDomains).map(d => {
        const collections = Array.isArray(d?.collections) ? d.collections : []
        let totalPuzzle = 0
        let totalTrchest = 0
        let totalPiece = 0
        let totalBlackbox = 0
        for (const c of collections) {
          totalPuzzle += Number(c?.puzzleCount) || 0
          totalTrchest += Number(c?.trchestCount) || 0
          totalPiece += Number(c?.pieceCount) || 0
          totalBlackbox += Number(c?.blackboxCount) || 0
        }

        const settlementsRaw = Array.isArray(d?.settlements) ? d.settlements : []
        const settlements = settlementsRaw.slice(0, maxSettlements).map(s => {
          const officers = splitCommaList(s?.officerCharIds)
            .slice(0, maxOfficers)
            .map(id => ({
              name: charNameMap.get(id) || id.slice(0, 8),
              avatar: charAvatarMap.get(id) || "",
            }))
          return {
            id: String(s?.id || ""),
            name: String(s?.name || s?.id || "据点"),
            level: safeInt(s?.level),
            remainMoney: String(s?.remainMoney ?? "0"),
            officers,
          }
        })

        return {
          domainId: String(d?.domainId || ""),
          name: String(d?.name || d?.domainId || "区域"),
          level: safeInt(d?.level),
          settlements,
          totalPuzzle,
          totalTrchest,
          totalPiece,
          totalBlackbox,
        }
      })

      const img = await renderImg(
        "enduid/build",
        {
          userName: String(base.name || result.account.nickname || "-"),
          userUid: String(base.roleId || result.account.uid || "-"),
          userAvatarUrl: String(base.avatarUrl || "").trim(),
          level: base.level ?? "-",
          worldLevel: base.worldLevel ?? "-",
          charNum: base.charNum ?? chars.length ?? "-",
          weaponNum: base.weaponNum ?? "-",
          docNum: base.docNum ?? "-",
          time: currentTs ? formatYmdHm(currentTs) : "",
          rooms: roomsView,
          domains: domainsView,
          copyright: `${GAME_TITLE} zmd-plugin`,
        },
        { scale: 1, quality: 100 },
      )

      if (img) {
        await e.reply(img, true)
        return true
      }
    } catch (err) {
      logger.error(`${GAME_TITLE} 基建图片渲染失败：${err?.message || err}`)
    }

    const lines = [
      `${GAME_TITLE} 基建`,
      `昵称: ${base.name || result.account.nickname || "-"}`,
      `UID: ${base.roleId || result.account.uid || "-"}`,
    ]

    if (domains.length) {
      lines.push("", "【地区建设】")
      for (const d of domains.slice(0, verbose ? 20 : 6)) {
        const collections = Array.isArray(d?.collections) ? d.collections : []
        let puzzle = 0
        let trchest = 0
        let piece = 0
        let blackbox = 0
        for (const c of collections) {
          puzzle += Number(c?.puzzleCount) || 0
          trchest += Number(c?.trchestCount) || 0
          piece += Number(c?.pieceCount) || 0
          blackbox += Number(c?.blackboxCount) || 0
        }

        lines.push(
          `- ${d?.name || d?.domainId || "区域"} Lv${safeInt(d?.level)} | 拼图${puzzle} 宝箱${trchest} 碎片${piece} 黑盒${blackbox}`,
        )

        if (verbose) {
          const settlements = Array.isArray(d?.settlements) ? d.settlements : []
          for (const s of settlements.slice(0, 10)) {
            const officers = splitCommaList(s?.officerCharIds).map(id => charNameMap.get(id) || id.slice(0, 8))
            lines.push(
              `  · ${s?.name || s?.id || "据点"} Lv${safeInt(s?.level)} | 余额:${s?.remainMoney || "0"}${
                officers.length ? ` | 干员:${officers.join("/")}` : ""
              }`,
            )
          }
        }
      }
      if (!verbose && domains.length > 6) {
        lines.push(`… 还有 ${domains.length - 6} 个区域（发送「${cfg.cmd?.prefix || "#zmd"}基建 详细」查看）`)
      }
    }

    if (rooms.length) {
      lines.push("", "【飞船】")
      lines.push(`房间: ${rooms.length}`)

      if (verbose) {
        for (const r of rooms.slice(0, 20)) {
          const rChars = Array.isArray(r?.chars) ? r.chars : []
          const names = rChars
            .map(x => {
              const id = String(x?.charId || "").trim()
              if (!id) return ""
              const name = charNameMap.get(id) || id.slice(0, 8)
              const ps = x?.physicalStrength
              const fav = x?.favorability
              const extra = []
              if (ps !== undefined) extra.push(`体力${Number(ps).toFixed?.(1) ?? ps}`)
              if (fav !== undefined) extra.push(`好感${fav}`)
              return extra.length ? `${name}(${extra.join(",")})` : name
            })
            .filter(Boolean)
          lines.push(
            `- 房间#${r?.id || "?"} type:${r?.type ?? "-"} Lv${safeInt(r?.level)}${names.length ? ` | ${names.join(" / ")}` : ""}`,
          )
        }
        if (rooms.length > 20) lines.push(`… 还有 ${rooms.length - 20} 个房间`)
      } else {
        lines.push(`发送「${cfg.cmd?.prefix || "#zmd"}基建 详细」查看房间人员详情`)
      }
    }

    await e.reply(lines.join("\n"), true)
    return true
  }
}
