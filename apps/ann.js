import plugin from "../../../lib/plugins/plugin.js"

import cfg from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import {
  clearAnnMemoryCache,
  fetchAnnDetail,
  fetchAnnList,
  runAnnPushTask,
  subscribeAnnGroup,
  unsubscribeAnnGroup,
} from "../model/ann.js"

const GAME_TITLE = "[终末地]"

function formatDateFromTs(ts) {
  const t = Number(ts) || 0
  if (t <= 0) return ""
  const d = new Date(t > 10_000_000_000 ? t : t * 1000)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

export class ann extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: "enduid-ann",
      dsc: "终末地公告",
      event: "message",
      priority: 5000,
      rule: [
        { reg: "^#?(?:终末地|zmd)公告(?:列表)?$", fnc: "list" },
        { reg: "^#?(?:终末地|zmd)公告\\s+(.+)$", fnc: "detail" },
        { reg: "^#?(?:终末地|zmd)订阅公告$", fnc: "sub" },
        { reg: "^#?(?:终末地|zmd)取消订阅公告$", fnc: "unsub" },
        { reg: "^#?(?:终末地|zmd)(?:清理公告缓存|公告清理缓存)$", fnc: "clearCache", permission: "master" },
      ],
      task: {
        name: "EndUID公告推送",
        cron: String(cfg.ann?.cron || "0 */15 * * * *"),
        fnc: runAnnPushTask,
      },
    })
  }

  async list() {
    const e = this.e
    const pageSize = Math.max(1, Number(cfg.ann?.pageSize) || 18)
    const list = await fetchAnnList({ pageSize, useCache: true })
    if (!list.length) {
      await e.reply(`${GAME_TITLE} 获取公告列表失败（可能需要 puppeteer/网络）`, true)
      return true
    }

    const lines = [
      `${GAME_TITLE} 公告列表（${list.length}）`,
      ...list.map((x, idx) => {
        const date = x.createdAtTs ? formatDateFromTs(x.createdAtTs) : ""
        return `${idx + 1}. (${x.id})${date ? ` [${date}]` : ""} ${x.title || ""}`.trim()
      }),
      `${GAME_TITLE} 查看：${cfg.cmd?.prefix || "#zmd"}公告 <id>`,
    ].join("\n")

    await e.reply(lines, true)
    return true
  }

  async detail() {
    const e = this.e
    const id = e.msg.replace(/^#?(?:终末地|zmd)公告\s*/i, "").trim()
    if (!id) {
      await e.reply(`${GAME_TITLE} 用法：${cfg.cmd?.prefix || "#zmd"}公告 <id>`, true)
      return true
    }

    const detail = await fetchAnnDetail(id, { useCache: true })
    if (!detail) {
      await e.reply(`${GAME_TITLE} 获取公告详情失败：${id}`, true)
      return true
    }

    const text = (detail.textContent || [])
      .map(s => String(s || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim()

    const date = detail.createdAtTs ? formatDateFromTs(detail.createdAtTs) : ""
    const header = [
      `${GAME_TITLE} 公告`,
      `标题: ${detail.title || id}`,
      date ? `日期: ${date}` : "",
      detail.userName ? `作者: ${detail.userName}${detail.userIpLocation ? `（${detail.userIpLocation}）` : ""}` : "",
      `链接: https://www.skland.com/article?id=${encodeURIComponent(id)}`,
      "",
    ]
      .filter(Boolean)
      .join("\n")

    const maxText = 1200
    const body =
      text.length > maxText ? `${text.slice(0, maxText)}\n...（内容较长，已截断）` : text || "（无文本内容）"

    await e.reply(`${header}${body}`, true)

    const imgs = (detail.images || []).map(x => x.url).filter(Boolean).slice(0, 5)
    for (const url of imgs) {
      try {
        await e.reply(segment.image(url), true)
      } catch {}
    }

    const vids = (detail.videos || []).map(x => x.url).filter(Boolean).slice(0, 3)
    if (vids.length) {
      await e.reply([`${GAME_TITLE} 视频链接：`, ...vids.map(u => `- ${u}`)].join("\n"), true)
    }

    return true
  }

  async sub() {
    const e = this.e
    if (!e.isGroup) {
      await e.reply(`${GAME_TITLE} 请在群聊中订阅公告`, true)
      return true
    }
    await subscribeAnnGroup(e.group_id)
    await e.reply(`${GAME_TITLE} 已订阅公告推送`, true)
    return true
  }

  async unsub() {
    const e = this.e
    if (!e.isGroup) {
      await e.reply(`${GAME_TITLE} 请在群聊中取消订阅公告`, true)
      return true
    }
    await unsubscribeAnnGroup(e.group_id)
    await e.reply(`${GAME_TITLE} 已取消订阅公告推送`, true)
    return true
  }

  async clearCache() {
    const e = this.e
    await clearAnnMemoryCache()
    await e.reply(`${GAME_TITLE} 已清理公告内存缓存`, true)
    return true
  }
}
