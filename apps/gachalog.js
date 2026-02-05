/**
 * 抽卡记录指令入口。
 *
 * 数据同步/导入导出在 model/gachalog.js；
 * 这里负责解析消息、调用更新/导出并渲染概览图片。
 */
import plugin from "../../../lib/plugins/plugin.js"
import fetch from "node-fetch"

import cfg from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import { render as renderImg } from "../model/render.js"
import {
  deleteGachaLogsForUser,
  exportGachaLogsForUser,
  getGachaLogViewForRoleId,
  getGachaLogViewForUser,
  importGachaLogsFromJsonForUser,
  importGachaLogsFromU8TokenForUser,
  updateGachaLogsForUser,
  updateGachaLogsForRoleId,
} from "../model/gachalog.js"
import { getQueryUserId } from "../model/mention.js"

const GAME_TITLE = "[终末地]"

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

function normalizeText(text) {
  return String(text || "").trim()
}

function extractUrlLike(text) {
  const s = normalizeText(text)
  if (!s) return ""
  const m = s.match(/https?:\/\/\S+/i)
  return m?.[0] ? m[0] : ""
}

function parseRoleIdFromCommand(msg, kind) {
  const text = normalizeText(msg)
  const reg =
    kind === "refresh"
      ? /^#?(?:终末地|zmd)(?:刷新抽卡记录|更新抽卡记录)\s*([0-9]{5,})\b/i
      : /^#?(?:终末地|zmd)(?:抽卡记录|抽卡纪录)\s*([0-9]{5,})\b/i
  const m = text.match(reg)
  const roleId = m?.[1] ? String(m[1]).trim() : ""
  return /^[0-9]{5,}$/.test(roleId) ? roleId : ""
}

export class gachalog extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: "zmd-plugin-gachalog",
      dsc: "终末地抽卡记录",
      event: "message",
      priority: 5000,
      rule: [
        { reg: "^#?(?:终末地|zmd)抽卡帮助$", fnc: "help" },
        { reg: "^#?(?:终末地|zmd)抽卡工具$", fnc: "tool" },
        { reg: "^#?(?:终末地|zmd)导入抽卡记录(?:\\s*.*)?$", fnc: "importLogs" },
        { reg: "^#?(?:终末地|zmd)导出抽卡记录$", fnc: "exportLogs" },
        { reg: "^#?(?:终末地|zmd)删除抽卡记录$", fnc: "deleteLogs" },
        { reg: "^#?(?:终末地|zmd)(?:抽卡记录|抽卡纪录)(?:\\s*.*)?$", fnc: "show" },
        { reg: "^#?(?:终末地|zmd)(?:刷新抽卡记录|更新抽卡记录)(?:\\s*.*)?$", fnc: "refresh" },
      ],
    })
  }

  async help() {
    const e = this.e
    const p = String(cfg.cmd?.prefix || "#zmd")
    const lines = [
      `${GAME_TITLE} 抽卡帮助`,
      `1) 登录后刷新：${p}更新抽卡记录 / ${p}更新抽卡记录1234567890`,
      `2) 导入 u8_token：${p}导入抽卡记录 <u8_token 或含 u8_token= 的链接>`,
      `3) 导入 JSON 文件：${p}导入抽卡记录（直接发送文件）`,
      ``,
      `查看：${p}抽卡记录 / ${p}抽卡记录1234567890 / ${p}抽卡记录 @用户`,
      `导出：${p}导出抽卡记录`,
      `删除：${p}删除抽卡记录`,
    ]
    await e.reply(lines.join("\n"), true)
    return true
  }

  async tool() {
    const e = this.e
    const url = String(cfg.gacha?.toolUrl || "").trim()
    if (!url) {
      await e.reply(`${GAME_TITLE} 未配置抽卡工具下载链接（管理员可在 config/zmd-plugin.yaml 设置 gacha.toolUrl）`, true)
      return true
    }
    await e.reply(`${GAME_TITLE} 抽卡工具下载：${url}`, true)
    return true
  }

  async refresh() {
    const e = this.e
    const queryUserId = getQueryUserId(e)
    const callerId = String(e.user_id ?? "")
    const targetId = String(queryUserId ?? "")
    const isOther = !!targetId && !!callerId && targetId !== callerId

    if (isOther && !e.isMaster) {
      const p = String(cfg.cmd?.prefix || "#zmd")
      await e.reply(`${GAME_TITLE} 仅支持更新自己的抽卡记录；管理员可用：${p}更新抽卡记录 @用户`, true)
      return true
    }

    const roleId = !isOther ? parseRoleIdFromCommand(e.msg, "refresh") : ""
    const res = roleId
      ? await updateGachaLogsForRoleId(e.user_id, roleId)
      : await updateGachaLogsForUser(queryUserId)
    if (!res.ok) {
      await e.reply(res.message, true)
      return true
    }

    await e.reply(
      [
        `${GAME_TITLE} 抽卡记录已更新！`,
        isOther ? `目标：${targetId}` : "",
        res.roleId ? `UID：${res.roleId}` : "",
        `新增角色记录：${res.newCharCount} 条`,
        `新增武器记录：${res.newWeaponCount} 条`,
      ].join("\n"),
      true,
    )
    return true
  }

  async show() {
    const e = this.e
    const queryUserId = getQueryUserId(e)
    const callerId = String(e.user_id ?? "")
    const targetId = String(queryUserId ?? "")
    const isOther = !!targetId && !!callerId && targetId !== callerId

    const roleId = !isOther ? parseRoleIdFromCommand(e.msg, "show") : ""
    const res = roleId
      ? await getGachaLogViewForRoleId(roleId, { userId: e.user_id, allowUnbound: !!e.isMaster })
      : await getGachaLogViewForUser(queryUserId)
    if (!res.ok) {
      await e.reply(res.message, true)
      return true
    }

    const p = String(cfg.cmd?.prefix || "#zmd")
    const subtitle = roleId ? `${p}更新抽卡记录${roleId}` : `${p}更新抽卡记录`

    try {
      const img = await renderImg(
        "enduid/gachalog",
        {
          ...res.view,
          prefix: p,
          title: `${GAME_TITLE} 抽卡记录`,
          subtitle,
          imgType: "png",
          copyright: `${GAME_TITLE} zmd-plugin`,
        },
        { scale: 1, quality: 100 },
      )
      if (img) {
        await e.reply(img, true)
        return true
      }
    } catch (err) {
      logger.error(`${GAME_TITLE} 抽卡记录图片渲染失败：${err?.message || err}`)
    }

    await e.reply(res.text, true)
    return true
  }

  async exportLogs() {
    const e = this.e
    const res = await exportGachaLogsForUser(e.user_id)
    if (!res.ok) {
      await e.reply(res.message, true)
      return true
    }

    const seg = await getSegment()
    if (seg?.file) {
      await e.reply(seg.file(res.filePath, res.fileName), true)
      return true
    }

    await e.reply(`${GAME_TITLE} 抽卡记录文件：${res.filePath}`, true)
    return true
  }

  async deleteLogs() {
    const e = this.e
    const res = await deleteGachaLogsForUser(e.user_id)
    if (!res.ok) {
      await e.reply(res.message, true)
      return true
    }

    await e.reply(`${GAME_TITLE} 已删除抽卡记录（已备份）：${res.backupPath}`, true)
    return true
  }

  async importLogs() {
    const e = this.e

    // 优先：用户上传 JSON 文件
    const fileMsg = Array.isArray(e.message) ? e.message.find(m => m?.type === "file") : null
    if (fileMsg) {
      try {
        const url = String(fileMsg.url || fileMsg.file || "").trim()
        if (!url) throw new Error("missing_file_url")

        let raw = ""
        const filePath = url.startsWith("file://") ? url.slice("file://".length) : url
        if (/^[a-zA-Z]:\\/.test(filePath) || filePath.startsWith("/") || filePath.startsWith("\\")) {
          const fs = await import("node:fs/promises")
          raw = await fs.readFile(filePath, "utf8")
        } else {
          const resp = await fetch(url)
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          raw = await resp.text()
        }

        const res = await importGachaLogsFromJsonForUser(e.user_id, raw)
        if (!res.ok) {
          await e.reply(res.message, true)
          return true
        }

        await e.reply(
          [
            `${GAME_TITLE} 导入完成！`,
            `新增角色记录：${res.newCharCount} 条`,
            `新增武器记录：${res.newWeaponCount} 条`,
            `当前角色记录：${res.totalChar} 条`,
            `当前武器记录：${res.totalWeapon} 条`,
          ].join("\n"),
          true,
        )
        return true
      } catch (err) {
        await e.reply(`${GAME_TITLE} 导入失败：${err?.message || err}`, true)
        return true
      }
    }

    // 其次：u8_token / URL 导入
    const msg = String(e.msg || "")
    const content = msg.replace(/^#?(?:终末地|zmd)\s*导入抽卡记录/i, "").trim()
    const input = content || extractUrlLike(msg)
    if (!input) {
      await e.reply(`${GAME_TITLE} 请提供 u8_token 或包含 u8_token= 的链接，或直接发送 JSON 文件`, true)
      return true
    }

    const res = await importGachaLogsFromU8TokenForUser(e.user_id, input)
    if (!res.ok) {
      await e.reply(res.message, true)
      return true
    }

    await e.reply(
      [
        `${GAME_TITLE} 导入完成！`,
        `新增角色记录：${res.newCharCount} 条`,
        `新增武器记录：${res.newWeaponCount} 条`,
        `当前角色记录：${res.totalChar} 条`,
        `当前武器记录：${res.totalWeapon} 条`,
      ].join("\n"),
      true,
    )
    return true
  }

}
