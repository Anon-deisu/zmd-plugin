/**
 * 别名指令入口。
 *
 * 负责解析聊天指令并调用 model/alias.js。
 * 别名数据存储在 Redis（见 model/store.js）。
 */
import plugin from "../../../lib/plugins/plugin.js"

import cfg from "../model/config.js"
import { addAlias, deleteAlias, getAliasList, resolveAliasEntry } from "../model/alias.js"
import { patchTempSessionReply } from "../model/reply.js"

const GAME_TITLE = "[终末地]"

export class alias extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: "zmd-plugin-alias",
      dsc: "终末地角色别名",
      event: "message",
      priority: 5000,
      rule: [
        { reg: "^#?(?:终末地|zmd)别名\\s*(.*)$", fnc: "list" },
        { reg: "^#?(?:终末地|zmd)添加别名\\s+(.+)$", fnc: "add" },
        { reg: "^#?(?:终末地|zmd)删除别名\\s+(.+)$", fnc: "del" },
      ],
    })
  }

  async list() {
    const e = this.e
    const query = e.msg.replace(/^#?(?:终末地|zmd)别名/i, "").trim()
    if (!query) {
      await e.reply(`${GAME_TITLE} 用法：${cfg.cmd?.prefix || "#zmd"}别名 <角色>`, true)
      return true
    }

    const resolved = await resolveAliasEntry(query)
    if (!resolved) {
      await e.reply(`${GAME_TITLE} 未找到角色「${query}」，可先 ${cfg.cmd?.prefix || "#zmd"}刷新`, true)
      return true
    }

    const list = [resolved.key, ...getAliasList(resolved.entry)]
      .map(s => String(s || "").trim())
      .filter(Boolean)

    await e.reply(`${GAME_TITLE} 「${resolved.entry?.name || resolved.key}」别名：\n${list.join(" / ")}`, true)
    return true
  }

  async add() {
    const e = this.e
    const rest = e.msg.replace(/^#?(?:终末地|zmd)添加别名/i, "").trim()
    const parts = rest.split(/\s+/).filter(Boolean)
    const charQuery = parts[0] || ""
    const aliasText = parts.slice(1).join(" ")
    if (!charQuery || !aliasText) {
      await e.reply(`${GAME_TITLE} 用法：${cfg.cmd?.prefix || "#zmd"}添加别名 <角色> <别名>`, true)
      return true
    }

    const res = await addAlias(charQuery, aliasText)
    await e.reply(`${GAME_TITLE} ${res.ok ? "✅" : "❌"} ${res.message}`, true)
    return true
  }

  async del() {
    const e = this.e
    const rest = e.msg.replace(/^#?(?:终末地|zmd)删除别名/i, "").trim()
    const parts = rest.split(/\s+/).filter(Boolean)
    const charQuery = parts[0] || ""
    const aliasText = parts.slice(1).join(" ")
    if (!charQuery || !aliasText) {
      await e.reply(`${GAME_TITLE} 用法：${cfg.cmd?.prefix || "#zmd"}删除别名 <角色> <别名>`, true)
      return true
    }

    const res = await deleteAlias(charQuery, aliasText)
    await e.reply(`${GAME_TITLE} ${res.ok ? "✅" : "❌"} ${res.message}`, true)
    return true
  }
}
