import fs from "node:fs"
import path from "node:path"

import plugin from "../../../lib/plugins/plugin.js"

import cfg, { configSave } from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import { downloadEndfieldIconsForUser } from "../model/resource.js"

const GAME_TITLE = "[终末地]"
const PLUGIN_NAME = "enduid-yunzai"

function getCmdPrefixHint() {
  return String(cfg.cmd?.prefix || "#zmd")
}

function normalizeBaseUrl(baseUrl) {
  const s = String(baseUrl || "").trim()
  if (!s) return ""
  return s.replace(/\/+$/, "")
}

export class resource extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: "enduid-resource",
      dsc: "终末地资源下载/更新",
      event: "message",
      priority: 5000,
      rule: [
        { reg: "^#?(?:终末地|zmd)资源(?:下载|更新|强制更新)(?:\\s+.+)?$", fnc: "download" },
        { reg: "^#?(?:终末地|zmd)资源设置\\s+.+$", fnc: "setBaseUrl" },
        { reg: "^#?(?:终末地|zmd)资源状态$", fnc: "status" },
      ],
    })
  }

  async setBaseUrl() {
    const e = this.e
    const url = normalizeBaseUrl(e.msg.replace(/^#?(?:终末地|zmd)资源设置/i, "").trim())
    if (!url) {
      await e.reply(`${GAME_TITLE} 用法：${getCmdPrefixHint()}资源设置 <资源镜像URL>`, true)
      return true
    }
    if (!/^https?:\/\//i.test(url)) {
      await e.reply(`${GAME_TITLE} 资源镜像URL需以 http(s):// 开头`, true)
      return true
    }

    cfg.resource ??= {}
    cfg.resource.baseUrl = url
    try {
      await configSave?.()
      await e.reply(`${GAME_TITLE} ✅ 已设置资源镜像：${url}`, true)
      return true
    } catch (err) {
      await e.reply(`${GAME_TITLE} ❌ 保存配置失败：${err?.message || err}`, true)
      return true
    }
  }

  async download() {
    const e = this.e
    const msg = String(e.msg || "")
    const isForce = msg.includes("强制")

    const argUrl = normalizeBaseUrl(msg.replace(/^#?(?:终末地|zmd)资源(?:下载|更新|强制更新)/i, "").trim())
    const baseUrl = normalizeBaseUrl(argUrl || cfg.resource?.baseUrl || "")

    if (!baseUrl) {
      await e.reply(
        [
          `${GAME_TITLE} 缺少资源镜像地址`,
          `1) 先设置：${getCmdPrefixHint()}资源设置 <资源镜像URL>`,
          `2) 或直接：${getCmdPrefixHint()}资源下载 <资源镜像URL>`,
          "说明：资源镜像URL可填仓库根目录或 resource 目录（会自动尝试 resource/ 与 BeyondUID/resource/）",
        ].join("\n"),
        true,
      )
      return true
    }

    await e.reply(`${GAME_TITLE} 正在${isForce ? "强制更新" : "下载"}资源，请稍等…`, true)

    const res = await downloadEndfieldIconsForUser(e.user_id, {
      baseUrl,
      force: isForce,
      timeoutMs: Number(cfg.resource?.timeoutMs) || 20000,
      concurrency: Number(cfg.resource?.concurrency) || 6,
      minWeaponRarity: Number(cfg.resource?.minWeaponRarity) || 5,
      downloadChar: true,
      minCharRarity: 6,
    })

    if (!res.ok) {
      await e.reply(`${GAME_TITLE} ❌ ${res.message || "资源下载失败"}`, true)
      return true
    }

    const lines = [
      `${GAME_TITLE} ✅ 资源处理完成`,
      `镜像：${res.baseUrl}`,
      `目标：${res.total} 个`,
      `下载：${res.downloaded} 个`,
      `失败：${res.failed} 个`,
    ]
    if (res.failed && Array.isArray(res.fails) && res.fails.length) {
      lines.push("失败示例：")
      for (const f of res.fails) lines.push(`- ${f.item?.type || "?"}:${f.item?.id || "?"} (${f.err || "err"})`)
    }

    await e.reply(lines.join("\n"), true)
    return true
  }

  async status() {
    const e = this.e
    const resDir = path.join(process.cwd(), "plugins", PLUGIN_NAME, "resources", "endfield")
    const weaponDir = path.join(resDir, "itemiconbig")
    const charDir = path.join(resDir, "charicon")

    function countPng(dir) {
      try {
        if (!fs.existsSync(dir)) return 0
        return fs.readdirSync(dir).filter(f => String(f).toLowerCase().endsWith(".png")).length
      } catch {
        return 0
      }
    }

    const weaponCount = countPng(weaponDir)
    const charCount = countPng(charDir)
    await e.reply(
      [
        `${GAME_TITLE} 资源状态`,
        `weapon icons: ${weaponCount}`,
        `char icons: ${charCount}`,
        `镜像：${cfg.resource?.baseUrl || "(未设置)"}`,
      ].join("\n"),
      true,
    )
    return true
  }
}
