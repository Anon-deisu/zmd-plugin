/**
 * 明日方舟（森空岛）功能入口。
 *
 * 指令前缀：#fz
 * - #fz签到 / #fz开启自动签到
 * - #fz更新抽卡记录 / #fz抽卡记录
 *
 * 说明：复用本插件（#zmd）的绑定信息（cred/token）。
 */

import plugin from "../../../lib/plugins/plugin.js"

import cfg from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import { render as renderImg } from "../model/render.js"
import { getQueryUserId } from "../model/mention.js"
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

let autoSignRunning = false

async function runFzAutoSignAll() {
  if (cfg.fz?.autoSign?.enableTask === false) return
  if (autoSignRunning) return
  autoSignRunning = true

  try {
    const users = await listFzAutoSignUsers()
    if (!users.length) return

    const concurrency = Math.max(1, Number(cfg.fz?.autoSign?.concurrency) || 3)
    const minInterval = Math.max(0, Number(cfg.fz?.autoSign?.minIntervalSec) || 0)
    const maxInterval = Math.max(minInterval, Number(cfg.fz?.autoSign?.maxIntervalSec) || minInterval)

    const results = []

    async function runOne(userId) {
      const acc = await getFzAccountForUser(userId)
      if (!acc.ok) return `${userId}: 未绑定`

      try {
        const res = await attendanceArknights(acc.cred, acc.akUid)
        if (!res) return `${userId}: 请求失败`
        if (res.code === 0) return `${userId}: ✅ ${acc.nickname || acc.akUid}`
        if (res.code === 10001) return `${userId}: ☑️ 已签 ${acc.nickname || acc.akUid}`
        return `${userId}: ❌ ${acc.nickname || acc.akUid} ${res.message || res.code}`
      } catch (err) {
        return `${userId}: 异常 ${err?.message || err}`
      }
    }

    for (let i = 0; i < users.length; i += concurrency) {
      const batch = users.slice(i, i + concurrency).map(u => String(u))
      const batchResults = await Promise.all(batch.map(u => runOne(u)))
      results.push(...batchResults)

      if (i + concurrency < users.length && maxInterval > 0) {
        const waitSec =
          minInterval === maxInterval ? minInterval : minInterval + Math.random() * (maxInterval - minInterval)
        await sleep(waitSec * 1000)
      }
    }

    const notify = String(cfg.fz?.autoSign?.notifyUserId || "").trim()
    if (notify) {
      try {
        await Bot.pickFriend(notify).sendMsg([`${GAME_TITLE} 自动签到结果：`, ...results].join("\n"))
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

  async autoSignOn() {
    const e = this.e
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
