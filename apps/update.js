import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import plugin from "../../../lib/plugins/plugin.js"

import { PLUGIN_DIRNAME, PLUGIN_ID } from "../model/pluginMeta.js"

const GAME_TITLE = "[终末地]"

let UpdatePlugin = null

async function loadOtherUpdate() {
  if (UpdatePlugin) return UpdatePlugin
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    const otherUpdatePath = path.join(currentDir, "..", "..", "other", "update.js")
    const mod = await import(pathToFileURL(otherUpdatePath).href)
    UpdatePlugin = mod?.update ?? mod?.default
  } catch (e) {
    logger?.warn?.(`[${PLUGIN_ID}] 未找到 plugins/other/update.js，插件更新命令不可用`)
  }
  return UpdatePlugin
}

export class update extends plugin {
  constructor() {
    super({
      name: `${PLUGIN_ID}-update`,
      dsc: "终末地插件更新",
      event: "message",
      priority: 50,
      rule: [
        {
          reg: "^#?(?:终末地|zmd)(?:插件)?更新插件$",
          fnc: "run",
          permission: "master",
        },
        {
          reg: "^#?(?:终末地|zmd)(?:插件)?强制更新插件$",
          fnc: "force",
          permission: "master",
        },
      ],
    })
  }

  async run() {
    return this._doUpdate({ force: false })
  }

  async force() {
    return this._doUpdate({ force: true })
  }

  async _doUpdate({ force } = {}) {
    if (!this.e?.isMaster) return false

    const Update = await loadOtherUpdate()
    if (!Update) {
      await this.e.reply(`${GAME_TITLE} 未找到系统更新模块（plugins/other/update.js），请手动更新插件`, true)
      return true
    }

    // Delegate to TRSS built-in update plugin.
    // It updates by plugin directory name (not PLUGIN_ID), which stays correct even if user renamed this plugin folder.
    this.e.msg = `#${force ? "强制" : ""}更新${PLUGIN_DIRNAME}`

    const up = new Update()
    up.e = this.e
    up.reply = this.reply.bind(this)
    return up.update()
  }
}
