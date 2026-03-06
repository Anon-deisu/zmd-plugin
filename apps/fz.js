/**
 * 明日方舟（森空岛）功能入口。
 *
 * 指令前缀：#fz
 * - #fz签到 / #fz全部签到 / #fz开启自动签到
 * - #fz更新抽卡记录 / #fz抽卡记录
 *
 * 说明：复用本插件（#zmd）的绑定信息（cred/token）。
 */

import plugin from "../../../lib/plugins/plugin.js"

import fetch from "node-fetch"

import cfg from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import { render as renderImg } from "../model/render.js"
import { getQueryUserId } from "../model/mention.js"
import { listBoundUsers } from "../model/store.js"
import { attendanceArknights } from "../model/skland/client.js"
import { getFzAccountForUser } from "../model/fz/account.js"
import {
  deleteFzGachaLogsForUser,
  exportFzGachaLogsForUser,
  getFzGachaLogViewForUser,
  importFzGachaLogsFromJsonForUser,
  updateFzGachaLogsForUser,
} from "../model/fz/gachalog.js"
import { listFzAutoSignUsers, setFzAutoSign } from "../model/fz/store.js"

const GAME_TITLE = "[明日方舟]"
const PREFIX = "#fz"

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatAwards(res) {
  const awards = res?.data?.awards || []
  if (!Array.isArray(awards) || !awards.length) return "（暂无奖励信息）"
  return awards
    .map(a => {
      const name = a?.resource?.name || a?.resource?.id || "未知"
      const count = a?.count ?? 0
      return `- ${name} × ${count}`
    })
    .join("\n")
}

function cleanBatchMessage(message) {
  const text = String(message || "").replace(/^\[[^\]]+\]\s*/, "").trim()
  return text || "未绑定"
}

function formatNow() {
  const t = new Date()
  const yyyy = t.getFullYear()
  const mm = String(t.getMonth() + 1).padStart(2, "0")
  const dd = String(t.getDate()).padStart(2, "0")
  const hh = String(t.getHours()).padStart(2, "0")
  const mi = String(t.getMinutes()).padStart(2, "0")
  const ss = String(t.getSeconds()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
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

function normalizeText(text) {
  return String(text || "").trim()
}

function extractUrlLike(text) {
  const s = normalizeText(text)
  if (!s) return ""
  const m = s.match(/https?:\/\/\S+/i)
  return m?.[0] ? m[0] : ""
}

function buildRefreshDoneLines({ res, isOther, targetId, full = false }) {
  if (!full) {
    return [
      `${GAME_TITLE} 抽卡记录已更新！`,
      isOther ? `目标：${targetId}` : "",
      `UID：${res.akUid}`,
      res.channelName ? `服务器：${res.channelName}` : "",
      `新增记录：${res.newCount} 条`,
      `当前总记录：${res.total} 条`,
      `查看：${PREFIX}抽卡记录`,
    ]
  }

  return [
    `${GAME_TITLE} 抽卡记录全量重拉完成！`,
    isOther ? `目标：${targetId}` : "",
    `UID：${res.akUid}`,
    res.channelName ? `服务器：${res.channelName}` : "",
    `覆盖前：${res.oldCount} 条`,
    `覆盖后：${res.total} 条`,
    `新增去重后记录：${res.newCount} 条`,
    `提示：该指令会重建本地记录，用于修复分类异常或历史缺失`,
  ]
}

async function runFzSignOne(userId) {
  const userText = String(userId || "").trim()
  const fallbackName = userText ? `QQ:${userText}` : "未绑定"

  const acc = await getFzAccountForUser(userId)
  if (!acc.ok) {
    const msg = cleanBatchMessage(acc.message)
    return {
      status: "skip",
      uid: "-",
      name: fallbackName,
      msg,
      text: `⏭️ ${fallbackName} ${msg}`,
    }
  }

  const name = String(acc.nickname || acc.akUid || "博士")
  const uidText = String(acc.akUid || "-")
  const label = `UID:${uidText} ${name}`

  try {
    const res = await attendanceArknights(acc.cred, acc.akUid)
    if (!res) {
      return {
        status: "fail",
        uid: uidText,
        name,
        msg: "请求失败",
        text: `❌ ${label} 请求失败`,
      }
    }
    if (res.code === 0) {
      return {
        status: "success",
        uid: uidText,
        name,
        msg: "签到完成",
        text: `✅ ${label}`,
      }
    }
    if (res.code === 10001) {
      return {
        status: "signed",
        uid: uidText,
        name,
        msg: "今日已签到",
        text: `☑️ 已签 ${label}`,
      }
    }

    const errMsg = String(res.message || res.code || "失败")
    return {
      status: "fail",
      uid: uidText,
      name,
      msg: errMsg,
      text: `❌ ${label} ${errMsg}`,
    }
  } catch (err) {
    const errMsg = String(err?.message || err || "异常")
    return {
      status: "fail",
      uid: uidText,
      name,
      msg: `异常 ${errMsg}`,
      text: `❌ ${label} 异常 ${errMsg}`,
    }
  }
}

async function runFzSignBatch(userIds) {
  const users = Array.isArray(userIds) ? userIds.map(String).filter(Boolean) : []
  const concurrency = Math.max(1, Number(cfg.fz?.autoSign?.concurrency) || 3)
  const minInterval = Math.max(0, Number(cfg.fz?.autoSign?.minIntervalSec) || 0)
  const maxInterval = Math.max(minInterval, Number(cfg.fz?.autoSign?.maxIntervalSec) || minInterval)

  let success = 0
  let signed = 0
  let fail = 0
  let skip = 0
  const resultsAll = []

  for (let i = 0; i < users.length; i += concurrency) {
    const batch = users.slice(i, i + concurrency)
    const results = await Promise.all(batch.map(u => runFzSignOne(u)))

    for (const r of results) {
      if (r.status === "success") success++
      else if (r.status === "signed") signed++
      else if (r.status === "fail") fail++
      else if (r.status === "skip") skip++
      resultsAll.push(r)
    }

    if (i + concurrency < users.length && maxInterval > 0) {
      const waitSec = minInterval === maxInterval ? minInterval : minInterval + Math.random() * (maxInterval - minInterval)
      await sleep(waitSec * 1000)
    }
  }

  return { success, signed, fail, skip, resultsAll }
}

let autoSignRunning = false

async function runFzAutoSignAll() {
  if (cfg.fz?.autoSign?.enableTask === false) return
  if (autoSignRunning) return
  autoSignRunning = true

  try {
    const users = await listFzAutoSignUsers()
    if (!users.length) return

    const { resultsAll } = await runFzSignBatch(users)

    const notify = String(cfg.fz?.autoSign?.notifyUserId || "").trim()
    if (notify) {
      try {
        await Bot.pickFriend(notify).sendMsg([`${GAME_TITLE} 自动签到结果：`, ...resultsAll.map(item => item.text)].join("\n"))
      } catch (err) {
        logger.error(`[zmd-plugin][fz] 自动签到推送失败`, err)
      }
    }
  } finally {
    autoSignRunning = false
  }
}

export class fz extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: "zmd-plugin-fz",
      dsc: "明日方舟（Skland）签到/抽卡记录",
      event: "message",
      priority: 5000,
      rule: [
        { reg: "^#?fz抽卡帮助$", fnc: "help" },
        { reg: "^#?fz签到$", fnc: "sign" },
        { reg: "^#?fz(?:全部签到|全体签到|一键签到)$", fnc: "allSign", permission: "master" },
        { reg: "^#?fz(?:开启自动签到|自动签到开启)$", fnc: "autoSignOn" },
        { reg: "^#?fz(?:关闭自动签到|自动签到关闭)$", fnc: "autoSignOff" },
        { reg: "^#?fz导入抽卡记录(?:\\s*.*)?$", fnc: "importLogs" },
        { reg: "^#?fz导出抽卡记录$", fnc: "exportLogs" },
        { reg: "^#?fz删除抽卡记录$", fnc: "deleteLogs" },
        { reg: "^#?fz(?:全量更新抽卡记录|重刷抽卡记录|重置抽卡记录|重拉抽卡记录)(?:\\s*.*)?$", fnc: "refreshAll" },
        { reg: "^#?fz更新抽卡记录(?:\\s*.*)?$", fnc: "refresh" },
        { reg: "^#?fz抽卡记录(?:\\s*.*)?$", fnc: "show" },
      ],
      task: {
        name: "zmd-plugin方舟自动签到",
        cron: String(cfg.fz?.autoSign?.cron || "0 10 4 * * *"),
        fnc: runFzAutoSignAll,
      },
    })
  }

  async help() {
    const e = this.e
    const lines = [
      `${GAME_TITLE} 抽卡帮助`,
      `更新：${PREFIX}更新抽卡记录<@用户>`,
      `全量：${PREFIX}全量更新抽卡记录<@用户>`,
      `查看：${PREFIX}抽卡记录<@用户>`,
      `导入：${PREFIX}导入抽卡记录<JSON文件>`,
      `导出：${PREFIX}导出抽卡记录`,
      `删除：${PREFIX}删除抽卡记录`,
    ]
    await e.reply(lines.join("\n"), true)
    return true
  }

  async sign() {
    const e = this.e

    const acc = await getFzAccountForUser(e.user_id)
    if (!acc.ok) {
      await e.reply(acc.message, true)
      return true
    }

    let res
    try {
      res = await attendanceArknights(acc.cred, acc.akUid)
    } catch (err) {
      await e.reply(`${GAME_TITLE} 签到请求失败：${err?.message || err}`, true)
      return true
    }
    if (!res) {
      await e.reply(`${GAME_TITLE} 签到请求失败`, true)
      return true
    }

    if (res.code === 0) {
      await e.reply(`${GAME_TITLE} ✅ [${acc.nickname || acc.akUid}] 签到完成\n${formatAwards(res)}`, true)
      return true
    }
    if (res.code === 10001) {
      await e.reply(`${GAME_TITLE} ☑️ [${acc.nickname || acc.akUid}] 今日已签到`, true)
      return true
    }

    await e.reply(`${GAME_TITLE} ❌ [${acc.nickname || acc.akUid}] 签到失败：${res.message || res.code}`, true)
    return true
  }

  async allSign() {
    const e = this.e
    if (autoSignRunning) {
      await e.reply(`${GAME_TITLE} 正在执行自动签到，请稍后再试`, true)
      return true
    }

    autoSignRunning = true
    try {
      const users = await listBoundUsers()
      if (!users.length) {
        await e.reply(`${GAME_TITLE} 暂无已绑定用户`, true)
        return true
      }

      const { success, signed, fail, skip, resultsAll } = await runFzSignBatch(users)
      const maxLines = 40
      const shown = resultsAll.slice(0, maxLines)
      const remain = Math.max(0, resultsAll.length - shown.length)

      try {
        const img = await renderImg(
          "fz/all_sign",
          {
            title: `${GAME_TITLE} 全部签到`,
            subtitle: "罗德岛值班账号签到总览",
            time: formatNow(),
            success,
            signed,
            fail,
            skip,
            total: resultsAll.length,
            items: shown,
            truncated: remain > 0,
            shown: shown.length,
            remain,
            imgType: "png",
            copyright: `${GAME_TITLE}zmd-plugin & yuyu-bot`,
          },
          { scale: 1.05, quality: 100 },
        )
        if (img) {
          await e.reply(img, true)
          return true
        }
      } catch (err) {
        logger.error(`${GAME_TITLE} 全部签到图片渲染失败：${err?.message || err}`)
      }

      const body = remain > 0 ? `${shown.map(r => r.text).join("\n")}
... 还有 ${remain} 条` : shown.map(r => r.text).join("\n")
      await e.reply(`${GAME_TITLE} 全部签到完成：成功 ${success} | 已签 ${signed} | 失败 ${fail} | 跳过 ${skip}\n${body}`, true)
      return true
    } finally {
      autoSignRunning = false
    }
  }

  async autoSignOn() {
    const e = this.e
    const acc = await getFzAccountForUser(e.user_id)
    if (!acc.ok) {
      await e.reply(acc.message, true)
      return true
    }
    try {
      await setFzAutoSign(e.user_id, true)
    } catch (err) {
      await e.reply(`${GAME_TITLE} 开启失败：${err?.message || err}`, true)
      return true
    }
    await e.reply(`${GAME_TITLE} 已开启自动签到`, true)
    return true
  }

  async autoSignOff() {
    const e = this.e
    try {
      await setFzAutoSign(e.user_id, false)
    } catch (err) {
      await e.reply(`${GAME_TITLE} 关闭失败：${err?.message || err}`, true)
      return true
    }
    await e.reply(`${GAME_TITLE} 已关闭自动签到`, true)
    return true
  }

  async refresh() {
    const e = this.e

    const targetUserId = getQueryUserId(e)
    const isOther = String(targetUserId) !== String(e.user_id)

    await e.reply(`${GAME_TITLE} 正在获取抽卡记录，请稍候...${isOther ? `\n目标：${targetUserId}` : ""}`, true)

    const res = await updateFzGachaLogsForUser(targetUserId, { full: false })
    if (!res.ok) {
      await e.reply(res.message, true)
      return true
    }

    await e.reply(buildRefreshDoneLines({ res, isOther, targetId: targetUserId, full: false }).filter(Boolean).join("\n"), true)
    return true
  }

  async refreshAll() {
    const e = this.e

    const targetUserId = getQueryUserId(e)
    const isOther = String(targetUserId) !== String(e.user_id)

    await e.reply(`${GAME_TITLE} 正在全量重拉抽卡记录，请稍候...${isOther ? `\n目标：${targetUserId}` : ""}`, true)

    const res = await updateFzGachaLogsForUser(targetUserId, { full: true })
    if (!res.ok) {
      await e.reply(res.message, true)
      return true
    }

    await e.reply(buildRefreshDoneLines({ res, isOther, targetId: targetUserId, full: true }).filter(Boolean).join("\n"), true)
    return true
  }

  async show() {
    const e = this.e

    const targetUserId = getQueryUserId(e)
    const res = await getFzGachaLogViewForUser(targetUserId)
    if (!res.ok) {
      await e.reply(res.message, true)
      return true
    }

    try {
      const img = await renderImg(
        "fz/gachalog",
        {
          ...res.view,
          prefix: PREFIX,
          imgType: "png",
          copyright: `${GAME_TITLE}zmd-plugin & yuyu-bot`,
        },
        { scale: 1.2, quality: 100 },
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
    const res = await exportFzGachaLogsForUser(e.user_id)
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
    const res = await deleteFzGachaLogsForUser(e.user_id)
    if (!res.ok) {
      await e.reply(res.message, true)
      return true
    }

    await e.reply(`${GAME_TITLE} 已删除抽卡记录（已备份）：${res.backupPath}`, true)
    return true
  }

  async importLogs() {
    const e = this.e

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

        const res = await importFzGachaLogsFromJsonForUser(e.user_id, raw)
        if (!res.ok) {
          await e.reply(res.message, true)
          return true
        }

        await e.reply(
          [
            `${GAME_TITLE} 导入完成！`,
            `UID：${res.akUid}`,
            `新增记录：${res.newCount} 条`,
            `当前总记录：${res.total} 条`,
          ].join("\n"),
          true,
        )
        return true
      } catch (err) {
        await e.reply(`${GAME_TITLE} 导入失败：${err?.message || err}`, true)
        return true
      }
    }

    const msg = String(e.msg || "")
    const content = msg.replace(/^#?fz\s*导入抽卡记录/i, "").trim()
    if (content.startsWith("{") || content.startsWith("[")) {
      const res = await importFzGachaLogsFromJsonForUser(e.user_id, content)
      if (!res.ok) {
        await e.reply(res.message, true)
        return true
      }

      await e.reply(
        [
          `${GAME_TITLE} 导入完成！`,
          `UID：${res.akUid}`,
          `新增记录：${res.newCount} 条`,
          `当前总记录：${res.total} 条`,
        ].join("\n"),
        true,
      )
      return true
    }

    const input = content || extractUrlLike(msg)
    if (!input) {
      await e.reply(`${GAME_TITLE} 请直接发送 JSON 文件，或在命令后粘贴 JSON 内容 / 文件链接`, true)
      return true
    }

    try {
      const resp = await fetch(input)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const raw = await resp.text()
      const res = await importFzGachaLogsFromJsonForUser(e.user_id, raw)
      if (!res.ok) {
        await e.reply(res.message, true)
        return true
      }

      await e.reply(
        [
          `${GAME_TITLE} 导入完成！`,
          `UID：${res.akUid}`,
          `新增记录：${res.newCount} 条`,
          `当前总记录：${res.total} 条`,
        ].join("\n"),
        true,
      )
      return true
    } catch (err) {
      await e.reply(`${GAME_TITLE} 导入失败：${err?.message || err}`, true)
      return true
    }
  }
}
