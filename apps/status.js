/**
 * 状态/更新日志指令入口。
 *
 * - 状态：绑定用户数 + 签到统计
 * - 更新日志：从 git 提交信息生成简短列表
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

import plugin from "../../../lib/plugins/plugin.js"

import cfg from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import { getTodayCounts, getYesterdayCounts } from "../model/signStats.js"
import { getBoundStats } from "../model/store.js"
import { getUpdateLogs } from "../model/updateLog.js"

const GAME_TITLE = "[终末地]"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pluginRoot = path.resolve(__dirname, "..")

export class status extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: "zmd-plugin-status",
      dsc: "终末地状态/更新日志",
      event: "message",
      priority: 5000,
      rule: [
        { reg: "^#?(?:终末地|zmd)(?:状态|统计|status)$", fnc: "status" },
        { reg: "^#?(?:终末地|zmd)(?:更新日志|更新记录|log)$", fnc: "log" },
      ],
    })
  }

  async status() {
    const e = this.e
    const bound = await getBoundStats()
    const today = await getTodayCounts()
    const yesterday = await getYesterdayCounts()

    const lines = [
      `${GAME_TITLE} 状态`,
      `UID总数: ${bound.uidCount}（用户 ${bound.userCount} / 账号 ${bound.accountCount}）`,
      `今日签到: 成功 ${today.success} | 已签 ${today.signed} | 失败 ${today.fail}`,
      `昨日签到: 成功 ${yesterday.success} | 已签 ${yesterday.signed} | 失败 ${yesterday.fail}`,
      `缓存: card.cacheSec=${Number(cfg.card?.cacheSec) || 0}s`,
      `公告推送: ${cfg.ann?.enableTask ? "开启" : "关闭"} cron=${cfg.ann?.cron || ""}`,
    ].join("\n")

    await e.reply(lines, true)
    return true
  }

  async log() {
    const e = this.e
    const logs = getUpdateLogs({ cwd: pluginRoot, maxItems: 18, maxGit: 120 })
    if (!logs.length) {
      await e.reply(`${GAME_TITLE} 获取更新日志失败（可能未在 git 仓库内）`, true)
      return true
    }

    const lines = [
      `${GAME_TITLE} 更新日志（最近）`,
      ...logs.map((x, idx) => `${idx + 1}. ${x.emoji} ${x.text}`.trim()),
    ].join("\n")

    await e.reply(lines, true)
    return true
  }
}
