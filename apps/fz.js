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

import cfg from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import { render as renderImg } from "../model/render.js"
import { getQueryUserId } from "../model/mention.js"
import { listBoundUsers } from "../model/store.js"
import { attendanceArknights } from "../model/skland/client.js"
import { getFzAccountForUser } from "../model/fz/account.js"
import { getFzGachaLogViewForUser, updateFzGachaLogsForUser } from "../model/fz/gachalog.js"
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
        { reg: "^#?fz签到$", fnc: "sign" },
        { reg: "^#?fz(?:全部签到|全体签到|一键签到)$", fnc: "allSign", permission: "master" },
        { reg: "^#?fz(?:开启自动签到|自动签到开启)$", fnc: "autoSignOn" },
        { reg: "^#?fz(?:关闭自动签到|自动签到关闭)$", fnc: "autoSignOff" },
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
          "enduid/all_sign",
          {
            title: `${GAME_TITLE} 全部签到`,
            subtitle: "森空岛账号批量签到结果",
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
            theme: "fz",
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

    const lines = [
      `${GAME_TITLE} 抽卡记录已更新！`,
      isOther ? `目标：${targetUserId}` : "",
      `UID：${res.akUid}`,
      res.channelName ? `服务器：${res.channelName}` : "",
      `新增记录：${res.newCount} 条`,
      `当前总记录：${res.total} 条`,
      `查看：${PREFIX}抽卡记录`,
    ]
      .filter(Boolean)
      .join("\n")

    await e.reply(lines, true)
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
}
