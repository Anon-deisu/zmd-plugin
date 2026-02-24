/**
 * 插件配置加载器。
 *
 * 首次启动时通过 TRSS 的 makeConfig() 生成 `config/zmd-plugin.yaml`。
 * 若检测到旧的 `config/enduid-yunzai.yaml` 且新配置不存在，会将旧配置
 * 合并迁移到新文件（单向迁移，保留用户设置）。
 */
import fsSync from "node:fs"
import fs from "node:fs/promises"

import YAML from "yaml"

import makeConfig from "../../../lib/plugins/config.js"

import { LEGACY_CONFIG_ID, PLUGIN_ID } from "./pluginMeta.js"

function mergeDeep(target, source) {
  const s = source && typeof source === "object" ? source : null
  if (!s) return target
  for (const [k, v] of Object.entries(s)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== "object" || Array.isArray(target[k])) target[k] = {}
      mergeDeep(target[k], v)
    } else {
      target[k] = v
    }
  }
  return target
}

const DEFAULT_CONFIG = {
  cmd: {
    /** 命令前缀（仅用于提示，不参与正则匹配） */
    prefix: "#zmd",
  },
  gacha: {
    /** 抽卡记录工具下载链接（为空则不输出） */
    toolUrl: "",
    /** 登录绑定成功后是否自动同步一次抽卡记录（仅在新增记录时提示） */
    autoSyncAfterLogin: false,
  },
  smsdk: {
    /** sm.sdk.js 文件路径（为空则自动尝试常见位置） */
    smSdkPath: "",
    timeoutMs: 15000,
    cacheSec: 3600,
  },
  skland: {
    ua: {
      ios: "Skland/1.21.0 (com.hypergryph.skland; build:102100065; iOS 17.6.0) Alamofire/5.7.1",
      android:
        "Mozilla/5.0 (Linux; Android 12; SM-S9280 Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/101.0.4951.61 Mobile Safari/537.36; SKLand/1.52.1",
      sklandApp:
        "Skland/1.52.1 (com.hypergryph.skland; build:105201003; Android 32; ) Okhttp/4.11.0",
      web: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    },
  },
  card: {
    /** 卡片详情缓存（秒），用于「卡片/面板/基建」等功能，0 为不缓存 */
    cacheSec: 600,
    /** 兜底缓存（秒）：请求失败时返回上一次成功数据，0 为禁用 */
    staleCacheSec: 86400,
  },
  friendApi: {
    /**
     * 角色数据接口来源：
     * - auto: 优先使用本地 baseUrl；未配置时回退 unifiedBaseUrl
     * - local: 强制使用 baseUrl
     * - unified: 强制使用 unifiedBaseUrl
     */
    source: "auto",

    /** 本地 Friend API 基地址（用于补全面板数值/装备词条等） */
    baseUrl: "",
    /** 可选：本地 Friend API Bearer */
    bearer: "",

    /** 可选：本地匿名令牌（对应请求头 X-Anonymous-Token） */
    anonymousToken: "",

    /** 可选：API Key（对应请求头 X-API-Key） */
    apiKey: "",

    /** 可选：Framework Token（对应请求头 X-Framework-Token） */
    frameworkToken: "",

    /** 统一后端基地址（默认指向公共后端；可改为自建） */
    unifiedBaseUrl: "https://end-api.shallow.ink",
    /** 可选：统一后端 Friend API Bearer */
    unifiedBearer: "",

    /**
     * 可选：统一后端匿名令牌（对应请求头 X-Anonymous-Token）。
     * 一些公共后端会用它替代 Bearer / API Key。
     */
    unifiedAnonymousToken: "",

    /** 可选：统一后端 API Key（对应请求头 X-API-Key） */
    unifiedApiKey: "",

    /** 可选：统一后端 Framework Token（对应请求头 X-Framework-Token，常见前缀 ef_/qr_） */
    unifiedFrameworkToken: "",

    /** 请求超时（毫秒） */
    timeoutMs: 8000,
    /** 超时/500 时重试次数（0=不重试） */
    retries: 1,
    /** 重试基础延迟（毫秒），实际会按 attempt 递增 */
    retryDelayMs: 200,
    /** 缓存（秒），减少重复请求 */
    cacheSec: 120,
    /** /friend/detail 缓存（秒） */
    detailCacheSec: 300,
    /** /friend/char 兜底缓存（秒）：请求失败时使用上一次成功数据 */
    staleCacheSec: 86400,
    /** uid -> role_id 映射缓存（秒） */
    roleIdCacheSec: 86400,
    /** 是否启用（失败会自动降级，不影响原有面板展示） */
    enable: true,
    /** 使用 /friend/char_advanced 替代 /friend/char */
    useAdvancedEndpoint: false,
  },
  ann: {
    /** 公告功能 & 定时推送开关 */
    enableTask: true,
    /** 公告推送定时（6 段 cron：秒 分 时 日 月 周） */
    cron: "0 */15 * * * *",
    /** 公告列表数量 */
    pageSize: 18,
    /** 公告列表内存缓存（秒） */
    listCacheSec: 600,
    /** fetch 失败时是否允许 puppeteer 兜底 */
    enablePuppeteerFallback: true,
  },
  autoSign: {
    enableTask: true,
    cron: "0 5 4 * * *",
    notifyUserId: "",
    concurrency: 3,
    minIntervalSec: 1,
    maxIntervalSec: 3,
  },
  security: {
    /** 群聊不回显 cred/token */
    noShowSecretInGroup: true,
  },
}

// 迁移：如果存在旧的 config/enduid-yunzai.yaml 且新配置不存在，则合并到新配置里。
const baseConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
try {
  const newCfgFile = `config/${PLUGIN_ID}.yaml`
  const oldCfgFile = `config/${LEGACY_CONFIG_ID}.yaml`
  if (!fsSync.existsSync(newCfgFile) && fsSync.existsSync(oldCfgFile)) {
    const raw = await fs.readFile(oldCfgFile, "utf8")
    const parsed = YAML.parse(raw)
    if (parsed && typeof parsed === "object") mergeDeep(baseConfig, parsed)
  }
} catch {}

const { config, configSave } = await makeConfig(PLUGIN_ID, baseConfig)

// 兼容旧配置：之前提示前缀可能是 #end，但现在命令已改为 #zmd / #终末地
try {
  const prefix = String(config?.cmd?.prefix ?? "").trim()
  if (!prefix || /^#?end$/i.test(prefix)) {
    config.cmd ??= {}
    config.cmd.prefix = "#zmd"
    await configSave?.()
  }
} catch {}

export default config
export { configSave }
