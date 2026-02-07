/**
 * 核心指令入口：绑定/登录、每日、签到、环境诊断等。
 *
 * 本文件以“编排/调用”为主：
 * - Redis 存储：model/store.js
 * - Skland 网络/签名：model/skland/*
 * - 图片渲染：model/render.js + resources/enduid/*
 */
import fs from "node:fs/promises"
import path from "node:path"
import fsSync from "node:fs"

import plugin from "../../../lib/plugins/plugin.js"
import fetch from "node-fetch"

import cfg from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import { render as renderImg } from "../model/render.js"
import { getCardDetailForUser } from "../model/card.js"
import { updateGachaLogsForUser } from "../model/gachalog.js"
import { getQueryUserId } from "../model/mention.js"
import { recordFail, recordSuccess } from "../model/signStats.js"
import {
  deleteAccount,
  getActiveAccount,
  getUserData,
  listAutoSignUsers,
  listBoundUsers,
  saveUserData,
  setActiveAccount,
  setAutoSign,
  upsertAccount,
} from "../model/store.js"
import { makeQrPng } from "../model/qrcode.js"
import {
  attendance,
  getBinding,
  getCardDetail,
  getCredInfoByToken,
  getScanId,
  getScanStatus,
  getTokenByScanCode,
  getUserInfo,
} from "../model/skland/client.js"
import { resolveSmSdkPath } from "../model/skland/deviceId.js"
import { PLUGIN_ID, PLUGIN_RESOURCES_DIR, pluginResourcesRelPath } from "../model/pluginMeta.js"
import { listSideBackgroundFiles, saveSideBackgroundImage } from "../model/sideBackground.js"

const GAME_TITLE = "[终末地]"

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function replyPrivate(e, msg) {
  if (!msg) return false
  try {
    if (!e) return false

    // 临时会话（OneBotv11: message_type=private, sub_type=group）会携带 group_id，
    // 但 e.reply 在 TRSS-Yunzai 内可能会被路由到群聊。这里显式走私聊/私信发送，避免误发到群里。
    const isTempSession = e.message_type === "private" && e.sub_type === "group" && e.group_id

    let lastErr
    const trySend = async fn => {
      try {
        const res = await fn()
        if (res === false) return false
        return res
      } catch (err) {
        lastErr = err
        return false
      }
    }

    if (e.friend?.sendMsg) {
      const res = await trySend(() => e.friend.sendMsg(msg))
      if (res !== false) return res
    }

    if (Bot?.pickUser && e.user_id) {
      const res = await trySend(() => Bot.pickUser(e.user_id).sendMsg(msg))
      if (res !== false) return res
    }

    if (e.group_id) {
      const member = e.group?.pickMember ? e.group.pickMember(e.user_id) : Bot.pickMember(e.group_id, e.user_id)
      if (member?.sendMsg) {
        const res = await trySend(() => member.sendMsg(msg))
        if (res !== false) return res
      }
    }

    if (Bot?.sendFriendMsg && e.self_id && e.user_id) {
      const res = await trySend(() => Bot.sendFriendMsg(e.self_id, e.user_id, msg))
      if (res !== false) return res
    }

    if (e.reply && !isTempSession) return await e.reply(msg, false)

    if (lastErr) logger.error(`[${PLUGIN_ID}] 私聊消息发送失败`, lastErr)
    return false
  } catch (err) {
    logger.error(`[${PLUGIN_ID}] 私聊消息发送失败`, err)
    return false
  }
}

function normalizeText(text) {
  return String(text || "")
    .trim()
    .replace(/[\"\n\t ]+/g, "")
    .replace(/，/g, ",")
}

function parseCredential(text) {
  const raw = String(text || "").trim()
  const lower = raw.toLowerCase()
  for (const prefix of ["cred=", "cred:", "token=", "token:"]) {
    if (lower.startsWith(prefix)) return { kind: prefix.includes("cred") ? "cred" : "token", value: raw.slice(prefix.length) }
  }
  if (raw.length === 32) return { kind: "cred", value: raw }
  if (raw.length === 24) return { kind: "token", value: raw }
  return { kind: "", value: raw }
}

function guessImageExt({ src = "", contentType = "" } = {}) {
  const ct = String(contentType || "").toLowerCase()
  if (ct.includes("image/png")) return ".png"
  if (ct.includes("image/webp")) return ".webp"
  if (ct.includes("image/bmp")) return ".bmp"
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return ".jpg"

  const s = String(src || "").trim()
  try {
    const pathname = /^https?:\/\//i.test(s) ? new URL(s).pathname : s
    const ext = path.extname(pathname || "").toLowerCase()
    if ([".jpg", ".jpeg", ".png", ".webp", ".bmp"].includes(ext)) return ext === ".jpeg" ? ".jpg" : ext
  } catch {}

  return ".jpg"
}

function extractImageSourceFromEvent(e) {
  const fromImg = Array.isArray(e?.img) && e.img.length ? String(e.img[0] || "").trim() : ""
  if (fromImg) return fromImg

  const seg = Array.isArray(e?.message)
    ? e.message.find(m => m?.type === "image" || m?.type === "file")
    : null
  const fromSeg = String(seg?.url || seg?.file || seg?.path || "").trim()
  return fromSeg || ""
}

async function readImageBufferFromSource(src) {
  const raw = String(src || "").trim()
  if (!raw) throw new Error("missing_image_source")

  const local = raw.startsWith("file://") ? decodeURIComponent(raw.slice("file://".length)) : raw
  const isLocalPath = /^[a-zA-Z]:[\\/]/.test(local) || local.startsWith("/") || local.startsWith("\\")

  if (isLocalPath) {
    const buffer = await fs.readFile(local)
    return { buffer, extHint: guessImageExt({ src: local }) }
  }

  const resp = await fetch(raw)
  if (!resp.ok) throw new Error(`download_failed_http_${resp.status}`)
  const buffer = Buffer.from(await resp.arrayBuffer())
  const extHint = guessImageExt({ src: raw, contentType: resp.headers.get("content-type") || "" })
  return { buffer, extHint }
}

function safeInt(value, def = 0) {
  const n = Number.parseInt(`${value ?? ""}`, 10)
  return Number.isFinite(n) ? n : def
}

function clampPercent(cur, total) {
  if (!total || total <= 0) return 0
  const pct = Math.round((cur / total) * 100)
  return Math.min(100, Math.max(0, pct))
}

function pickColorByPercent(pct) {
  if (pct >= 80) return "#34d399"
  if (pct >= 40) return "#fbbf24"
  return "#fb7185"
}

function getQqAvatarUrl(userId) {
  const id = String(userId || "").trim()
  if (!id) return ""
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(id)}&s=640`
}

function circleByRate(rawRate) {
  const rate = Math.min(1, Math.max(0, Number(rawRate) || 0))
  const perimeter = 3.14 * 89
  const per = perimeter - perimeter * rate
  let color = "--low-color"
  if (rate >= 0.9) color = "--high-color"
  else if (rate >= 0.8) color = "--medium-color"
  return { per, color: `var(${color})` }
}

function pickStateBackdrop() {
  try {
    const bgDir = path.join(PLUGIN_RESOURCES_DIR, "state", "img", "bg")
    if (!fsSync.existsSync(bgDir)) throw new Error("missing_bg_dir")
    const files = fsSync
      .readdirSync(bgDir)
      .filter(f => /\.(png|jpe?g|webp)$/i.test(f))
      .filter(Boolean)
    const file = files[Math.floor(Math.random() * files.length)]
    if (file) return pluginResourcesRelPath(`state/img/bg/${file}`)
  } catch {}
  return pluginResourcesRelPath("state/img/default_bg.jpg")
}

function formatRecoveryTime({ maxTs, currentTs, staminaCur, staminaTotal }) {
  if (staminaTotal && staminaCur >= staminaTotal) return { text: "已回满", urgent: true }
  if (!maxTs || maxTs <= 0) return { text: "未在恢复", urgent: false }

  const nowTs = currentTs > 0 ? currentTs : Math.floor(Date.now() / 1000)
  const delta = maxTs - nowTs
  if (delta <= 0) return { text: "已回满", urgent: true }

  const urgent = delta < 4 * 3600
  const target = new Date(maxTs * 1000)
  const now = new Date(nowTs * 1000)

  const isSameDay =
    target.getFullYear() === now.getFullYear() && target.getMonth() === now.getMonth() && target.getDate() === now.getDate()

  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  const isTomorrow =
    target.getFullYear() === tomorrow.getFullYear() &&
    target.getMonth() === tomorrow.getMonth() &&
    target.getDate() === tomorrow.getDate()

  const hh = String(target.getHours()).padStart(2, "0")
  const mm = String(target.getMinutes()).padStart(2, "0")

  if (isSameDay) return { text: `今天 ${hh}:${mm}`, urgent }
  if (isTomorrow) return { text: `明天 ${hh}:${mm}`, urgent }

  const month = String(target.getMonth() + 1).padStart(2, "0")
  const day = String(target.getDate()).padStart(2, "0")
  return { text: `${month}.${day} ${hh}:${mm}`, urgent }
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

async function ensureSklandUserId(cred, account, userId) {
  if (account.sklandUserId) return String(account.sklandUserId)
  const info = await getUserInfo(cred)
  const id = info?.data?.user?.id
  if (!id) return ""
  account.sklandUserId = String(id)
  await upsertAccount(userId, account)
  return account.sklandUserId
}

async function bindByCred(cred, userId, { usedToken, sklandUserId, deviceToken } = {}) {
  const res = await getBinding(cred)
  if (!res || res.code !== 0 || res.message !== "OK") {
    return { ok: false, message: `${GAME_TITLE} 绑定失败：请检查 cred 是否正确` }
  }

  const bindingList = res?.data?.list || []
  let endfieldUid = ""
  let nickname = ""
  let channelName = ""
  let recordUid = ""
  let serverId = "1"

  for (const item of bindingList) {
    if (item?.appCode !== "endfield") continue
    const bindingListData = item?.bindingList || []
    const firstBind = bindingListData?.[0]
    if (!firstBind) break

    let defaultRole = firstBind?.defaultRole
    if (!defaultRole && Array.isArray(firstBind?.roles) && firstBind.roles[0]) defaultRole = firstBind.roles[0]

    if (defaultRole) {
      endfieldUid = String(defaultRole?.roleId || "")
      nickname = String(defaultRole?.nickname || firstBind?.nickName || "终末地角色")
      channelName = String(firstBind?.channelName || "官服")
      recordUid = String(firstBind?.uid || "")
      if (defaultRole?.serverId) serverId = String(defaultRole.serverId)
    }
    break
  }

  if (!endfieldUid) return { ok: false, message: `${GAME_TITLE} 未找到终末地账号绑定信息` }

  const account = {
    cred: String(cred),
    uid: endfieldUid,
    nickname,
    channelName,
    recordUid,
    serverId,
    updatedAt: Date.now(),
  }
  if (sklandUserId) account.sklandUserId = String(sklandUserId)
  if (usedToken) account.token = String(usedToken)
  if (deviceToken) account.deviceToken = String(deviceToken)

  await upsertAccount(userId, account)

  return {
    ok: true,
    message: `${GAME_TITLE} 绑定成功\n游戏昵称: ${nickname}\n服务器: ${channelName}\nUID: ${endfieldUid}`,
  }
}

let autoSignRunning = false

async function runAutoSignAll() {
  if (!cfg.autoSign?.enableTask) return
  if (autoSignRunning) return
  autoSignRunning = true

  try {
    const users = await listAutoSignUsers()
    if (!users.length) return

    const concurrency = Math.max(1, Number(cfg.autoSign?.concurrency) || 3)
    const minInterval = Math.max(0, Number(cfg.autoSign?.minIntervalSec) || 0)
    const maxInterval = Math.max(minInterval, Number(cfg.autoSign?.maxIntervalSec) || minInterval)

    const results = []

    async function runOne(userId) {
      const { account } = await getActiveAccount(userId)
      if (!account?.cred || !account?.uid) return `${userId}: 未绑定`

      try {
        const res = await attendance(account.cred, account.uid)
        if (!res) {
          await recordFail(1)
          return `${userId}: 请求失败`
        }
        if (res.code === 0) {
          await recordSuccess(1)
          return `${userId}: ✅ ${account.nickname || account.uid}`
        }
        if (res.code === 10001) return `${userId}: ☑️ 已签 ${account.nickname || account.uid}`

        await recordFail(1)
        return `${userId}: ❌ ${account.nickname || account.uid} ${res.message || res.code}`
      } catch (err) {
        await recordFail(1)
        return `${userId}: 异常 ${err?.message || err}`
      }
    }

    for (let i = 0; i < users.length; i += concurrency) {
      const batch = users.slice(i, i + concurrency)
      const batchResults = await Promise.all(batch.map(u => runOne(String(u))))
      results.push(...batchResults)
      if (i + concurrency < users.length && maxInterval > 0) {
        const waitSec =
          minInterval === maxInterval ? minInterval : minInterval + Math.random() * (maxInterval - minInterval)
        await sleep(waitSec * 1000)
      }
    }

    const notify = String(cfg.autoSign?.notifyUserId || "").trim()
    if (notify) {
      try {
        await Bot.pickFriend(notify).sendMsg([`${GAME_TITLE} 自动签到结果：`, ...results].join("\n"))
      } catch (err) {
        logger.error(`[${PLUGIN_ID}] 自动签到推送失败`, err)
      }
    }
  } finally {
    autoSignRunning = false
  }
}

export class enduid extends plugin {
  constructor(e) {
    patchTempSessionReply(e)
    super({
      name: PLUGIN_ID,
      dsc: "终末地（Skland）查询/签到/登录",
      event: "message",
      priority: 5000,
      rule: [
        { reg: "^#?(?:终末地|zmd)(?:菜单|指令|命令|功能)?$", fnc: "help" },
        { reg: "^#?(?:终末地|zmd)(?:帮助|help)$", fnc: "help" },
        { reg: "^#?(?:终末地|zmd)(?:登录|login|dl)$", fnc: "login" },
        { reg: "^#?(?:终末地|zmd)(?:绑定|bind)\\s+(.+)$", fnc: "bind" },
        { reg: "^#?(?:终末地|zmd)(?:查看|我的|list)$", fnc: "list" },
        { reg: "^#?(?:终末地|zmd)(?:切换|switch)\\s*(.*)$", fnc: "switch" },
        { reg: "^#?(?:终末地|zmd)(?:删除|解绑|del)\\s*(.*)$", fnc: "del" },
        { reg: "^#?(?:终末地|zmd)(?:签到|sign)$", fnc: "sign" },
        { reg: "^#?(?:终末地|zmd)(?:全部签到|全体签到|一键签到)$", fnc: "allSign", permission: "master" },
        { reg: "^#?(?:终末地|zmd)(?:每日|体力|mr)(?:\\s*.*)?$", fnc: "daily" },
        { reg: "^#?(?:终末地|zmd)(?:开启自动签到|自动签到开启)$", fnc: "autoSignOn" },
        { reg: "^#?(?:终末地|zmd)(?:关闭自动签到|自动签到关闭)$", fnc: "autoSignOff" },
        { reg: "^#?(?:终末地|zmd)(?:环境|env)$", fnc: "env" },
        { reg: "^#?(?:终末地|zmd)(?:上传背景图|新增背景图)(?:\\s*.*)?$", fnc: "uploadBackground", permission: "master" },
      ],
      task: {
        name: `${PLUGIN_ID}自动签到`,
        cron: String(cfg.autoSign?.cron || "0 5 4 * * *"),
        fnc: runAutoSignAll,
      },
    })
  }

  async help() {
    const e = this.e
    const p = cfg.cmd?.prefix || "#zmd"

    const sections = [
      {
        title: "账号",
        desc: "绑定/切换终末地账号",
        items: [
          { name: "登录", cmd: `${p}登录`, desc: "私聊扫码登录并绑定" },
          { name: "绑定", cmd: `${p}绑定 <cred|token>`, desc: "私聊，支持 cred= / token= 前缀" },
          { name: "查看", cmd: `${p}查看`, desc: "查看已绑定账号" },
          { name: "切换", cmd: `${p}切换 <序号|UID>`, desc: "切换当前账号" },
          { name: "删除", cmd: `${p}删除 <序号|UID>`, desc: "删除绑定" },
        ],
      },
      {
        title: "查询",
        desc: "每日/卡片/面板等查询",
        items: [
          { name: "每日", cmd: `${p}每日 @用户`, desc: "体力/回满/通行证/活跃" },
          { name: "刷新", cmd: `${p}刷新`, desc: "刷新卡片/面板数据" },
          { name: "卡片", cmd: `${p}卡片 @用户`, desc: "终末地卡片总览" },
          {
            name: "面板",
            cmd: `#<角色>面板 @用户`,
            desc: `兼容：${p}面板 @用户 <角色>（别名：${p}查询 / ${p}mb）`,
          },
          { name: "基建", cmd: `${p}基建 @用户`, desc: "地区建设/飞船信息" },
          { name: "公告", cmd: `${p}公告 / ${p}公告 <id>`, desc: "查看公告列表/详情" },
          {
            name: "抽卡记录",
            cmd: `${p}抽卡记录 / ${p}抽卡记录<UID> / ${p}抽卡记录 @用户`,
            desc: "查看抽卡记录",
          },
          {
            name: "角色抽卡记录",
            cmd: `${p}角色记录 / ${p}角色记录<UID> / ${p}角色记录 @用户`,
            desc: `兼容：${p}角色抽卡记录`,
          },
          {
            name: "武器抽卡记录",
            cmd: `${p}武器记录 / ${p}武器记录<UID> / ${p}武器记录 @用户`,
            desc: `兼容：${p}武器抽卡记录`,
          },
          {
            name: "更新抽卡记录",
            cmd: `${p}更新抽卡记录 / ${p}抽卡记录更新 / ${p}更新抽卡记录<UID> / ${p}更新抽卡记录 @用户`,
            desc: "拉取并保存抽卡记录",
          },
          {
            name: "全量更新抽卡记录",
            cmd: `${p}全量更新抽卡记录 / ${p}重新获取所有抽卡记录 / ${p}全量更新抽卡记录<UID> / ${p}全量更新抽卡记录 @用户`,
            desc: "全量重拉并覆盖本地缓存（修复池子统计异常）",
          },
          {
            name: "更新武器图标",
            cmd: `${p}更新武器图标 / ${p}更新武器图标<UID>`,
            desc: "从 wiki 补全抽卡武器图标缓存（可选：强制；全部仅 master）",
          },
        ],
      },
      {
        title: "别名",
        desc: "角色别名管理",
        items: [
          { name: "别名列表", cmd: `${p}别名 <角色>`, desc: "查看别名列表" },
          { name: "添加别名", cmd: `${p}添加别名 <角色> <别名>`, desc: "" },
          { name: "删除别名", cmd: `${p}删除别名 <角色> <别名>`, desc: "" },
        ],
      },
      {
        title: "推送",
        desc: "群聊公告推送",
        items: [
          { name: "订阅公告", cmd: `${p}订阅公告`, desc: "" },
          { name: "取消订阅", cmd: `${p}取消订阅公告`, desc: "" },
          { name: "清理缓存", cmd: `${p}清理公告缓存`, desc: "清理公告缓存文件", badge: "MASTER" },
        ],
      },
      {
        title: "图鉴",
        desc: "biligame wiki：列表/卡池/图鉴查询",
        items: [
          { name: "角色列表", cmd: `${p}角色列表`, desc: "" },
          { name: "武器列表", cmd: `${p}武器列表`, desc: "" },
          { name: "卡池信息", cmd: `${p}卡池`, desc: `别名：${p}卡池信息 / ${p}up角色` },
          { name: "查询图鉴", cmd: `${p}<名称>图鉴`, desc: "后缀可用：介绍/技能/天赋/潜能/专武/武器" },
        ],
      },
      {
        title: "签到",
        desc: "每日签到与自动签到",
        items: [
          { name: "签到", cmd: `${p}签到`, desc: "" },
          { name: "自动签到", cmd: `${p}开启自动签到 / ${p}关闭自动签到`, desc: "" },
          { name: "全部签到", cmd: `${p}全部签到`, desc: "执行全部签到任务", badge: "MASTER" },
        ],
      },
      {
        title: "其他",
        desc: "状态/日志/环境",
        items: [
          { name: "状态", cmd: `${p}状态`, desc: "" },
          { name: "更新日志", cmd: `${p}更新日志`, desc: "" },
          { name: "环境", cmd: `${p}环境`, desc: "诊断 smsdk/qrcode 依赖" },
          { name: "上传背景图", cmd: `${p}上传背景图`, desc: "上传到本地图库（随机渲染背景）", badge: "MASTER" },
        ],
      },
    ]

    try {
      const t = new Date()
      const yyyy = t.getFullYear()
      const mm = String(t.getMonth() + 1).padStart(2, "0")
      const dd = String(t.getDate()).padStart(2, "0")
      const hh = String(t.getHours()).padStart(2, "0")
      const mi = String(t.getMinutes()).padStart(2, "0")
      const ss = String(t.getSeconds()).padStart(2, "0")

      let avatar = getQqAvatarUrl(e.user_id) || ""
      try {
        const detailRes = await getCardDetailForUser(e.user_id)
        if (detailRes?.ok) {
          const base = detailRes.res?.data?.detail?.base || {}
          const gameAvatarUrl = String(base.avatarUrl || "").trim()
          if (gameAvatarUrl) avatar = gameAvatarUrl
        }
      } catch {}
      const img = await renderImg(
        "help/index",
        {
          title: `${GAME_TITLE} 指令菜单`,
          subtitle: `命令别名：#终末地xxx / #zmdxxx`,
          avatar,
          prefix: p,
          time: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`,
          sections,
          imgType: "png",
          copyright: `${GAME_TITLE} ${PLUGIN_ID}`,
        },
        { scale: 1.2, quality: 100 },
      )
      if (img) {
        await e.reply(img, true)
        return true
      }
    } catch (err) {
      logger.error(`${GAME_TITLE} 帮助菜单图片渲染失败：${err?.message || err}`)
    }

    const msg = [
      `${GAME_TITLE} 总帮助菜单`,
      `命令别名：#终末地xxx / #zmdxxx`,
      ``,
      `【账号】`,
      `- ${p}登录  （私聊扫码登录并绑定）`,
      `- ${p}绑定 <cred|token>  （私聊，支持 cred= / token= 前缀）`,
      `- ${p}查看  （查看已绑定账号）`,
      `- ${p}切换 <序号|UID>  （切换当前账号）`,
      `- ${p}删除 <序号|UID>  （删除绑定）`,
      ``,
      `【查询】`,
      `- ${p}每日 / ${p}每日 @用户  （体力/回满/通行证/活跃）`,
      `- ${p}刷新  （刷新卡片/面板数据）`,
      `- ${p}卡片 / ${p}卡片 @用户  （终末地卡片总览）`,
      `- #<角色>面板 / #<角色>面板 @用户  （面板快捷指令）`,
      `- ${p}面板 <角色> / ${p}查询 <角色> / ${p}mb <角色>`,
      `- ${p}面板 @用户 <角色> / ${p}查询 @用户 <角色> / ${p}mb @用户 <角色>`,
      `- ${p}基建 / ${p}基建 @用户  （地区建设/飞船信息）`,
      `- ${p}公告 / ${p}公告 <id>`,
      `- ${p}抽卡记录 / ${p}抽卡记录<UID> / ${p}抽卡记录 @用户  （查看抽卡记录）`,
      `- ${p}角色记录 / ${p}角色记录<UID> / ${p}角色记录 @用户  （只看角色池，兼容 ${p}角色抽卡记录）`,
      `- ${p}武器记录 / ${p}武器记录<UID> / ${p}武器记录 @用户  （只看武器池，兼容 ${p}武器抽卡记录）`,
      `- ${p}更新抽卡记录 / ${p}抽卡记录更新 / ${p}更新抽卡记录<UID> / ${p}更新抽卡记录 @用户  （刷新抽卡记录，可能耗时）`,
      `- ${p}全量更新抽卡记录 / ${p}重新获取所有抽卡记录 / ${p}全量更新抽卡记录<UID> / ${p}全量更新抽卡记录 @用户  （全量重拉并覆盖本地缓存）`,
      `- ${p}更新武器图标 / ${p}更新武器图标<UID>  （补全抽卡武器图标缓存；可加 强制；全部仅 master）`,
      ``,
      `【别名】`,
      `- ${p}别名 <角色>  （查看别名列表）`,
      `- ${p}添加别名 <角色> <别名>`,
      `- ${p}删除别名 <角色> <别名>`,
      ``,
      `【推送】`,
      `- ${p}订阅公告 / ${p}取消订阅公告  （群聊）`,
      ``,
      `【图鉴】`,
      `- ${p}角色列表 / ${p}武器列表 / ${p}卡池`,
      `- ${p}<名称>图鉴  （可用：介绍/技能/天赋/潜能/专武/武器）`,
      ``,
      `【签到】`,
      `- ${p}签到`,
      `- ${p}开启自动签到 / ${p}关闭自动签到`,
      `- ${p}全部签到  （仅 master）`,
      ``,
      `【其他】`,
      `- ${p}状态 / ${p}更新日志 / ${p}环境`,
      `- ${p}上传背景图  （仅 master，发送命令时附图）`,
    ].join("\n")

    await e.reply(msg, true)
    return true
  }

  async uploadBackground() {
    const e = this.e
    if (!e.isMaster) {
      await e.reply(`${GAME_TITLE} 仅主人可用：上传背景图`, true)
      return true
    }

    const src = extractImageSourceFromEvent(e)
    if (!src) {
      await e.reply(`${GAME_TITLE} 请发送命令并附带一张图片：#zmd上传背景图`, true)
      return true
    }

    try {
      const { buffer, extHint } = await readImageBufferFromSource(src)
      const maxBytes = 20 * 1024 * 1024
      if (!buffer?.length) throw new Error("empty_image")
      if (buffer.length > maxBytes) throw new Error("image_too_large")

      const saved = await saveSideBackgroundImage(buffer, { extHint })
      const total = listSideBackgroundFiles().length

      await e.reply(
        [
          `${GAME_TITLE} 背景图上传成功`,
          `文件：${saved.fileName}`,
          `图库：resources/side/（当前 ${total} 张）`,
          `提示：新增图片已被 .gitignore 忽略，不会误提交到 GitHub`,
        ].join("\n"),
        true,
      )
      return true
    } catch (err) {
      const msg = String(err?.message || err)
      const text =
        msg === "image_too_large"
          ? "图片过大（请小于 20MB）"
          : msg.startsWith("download_failed_http_")
            ? `下载图片失败（${msg.replace("download_failed_http_", "HTTP ")}）`
            : `上传失败：${msg}`
      await e.reply(`${GAME_TITLE} ${text}`, true)
      return true
    }
  }

  async env() {
    const e = this.e
    const smsdkPath = resolveSmSdkPath()
    let qrcodeDep = "ok"
    try {
      await import("qrcode")
    } catch (err) {
      const msg = String(err?.message || err).split("\n")[0]
      qrcodeDep = `缺少（pnpm add qrcode）：${msg}`
    }
    const lines = [
      `${GAME_TITLE} 环境诊断：`,
      `node.execPath: ${process.execPath}`,
      `node.version: ${process.version}`,
      `qrcode(dep): ${qrcodeDep}`,
      `smsdk.smSdkPath: ${cfg.smsdk?.smSdkPath ? cfg.smsdk.smSdkPath : "(未配置)"} `,
      `smsdk(自动探测): ${smsdkPath ? smsdkPath : "(未找到)"} `,
    ]
    await e.reply(lines.join("\n"), true)
    return true
  }

  async bind() {
    const e = this.e
    if (!e.isPrivate) {
      await e.reply(`${GAME_TITLE} 为了安全，请私聊发送：${cfg.cmd?.prefix || "#zmd"}绑定 <cred|token>`, true)
      return true
    }

    const text = normalizeText(e.msg.replace(/^#?(?:终末地|zmd)(?:绑定|bind)/i, ""))
    const { kind, value } = parseCredential(text)

    if (!kind) {
      await replyPrivate(e, `${GAME_TITLE} 参数格式错误：请发送 32 位 cred 或 24 位 token`)
      return true
    }

    if (kind === "token") {
      let info
      try {
        info = await getCredInfoByToken(value, { userId: e.user_id })
      } catch (err) {
        await replyPrivate(e, `${GAME_TITLE} Token 登录失败：${err?.message || err}`)
        return true
      }
      if (info?.error === "405") {
        await replyPrivate(e, `${GAME_TITLE} 当前服务无法使用 token 登录，请尝试使用 cred`)
        return true
      }
      if (!info?.cred) {
        await replyPrivate(e, `${GAME_TITLE} Token 验证失败，请检查 token 是否正确`)
        return true
      }
      let res
      try {
        res = await bindByCred(info.cred, e.user_id, { usedToken: value, sklandUserId: info.sklandUserId })
      } catch (err) {
        await replyPrivate(e, `${GAME_TITLE} 绑定失败：${err?.message || err}`)
        return true
      }
      await replyPrivate(e, res.message)
      return true
    }

    let res
    try {
      res = await bindByCred(value, e.user_id)
    } catch (err) {
      await replyPrivate(e, `${GAME_TITLE} 绑定失败：${err?.message || err}`)
      return true
    }
    await replyPrivate(e, res.message)
    return true
  }

  async login() {
    const e = this.e
    if (!e.isPrivate) {
      await e.reply(`${GAME_TITLE} 为了安全，请私聊使用：${cfg.cmd?.prefix || "#zmd"}登录`, true)
      return true
    }

    let scanId = ""
    let scanUrl = ""
    try {
      const scan = await getScanId(e.user_id)
      scanId = String(scan?.scanId || "")
      scanUrl = String(scan?.scanUrl || "")
    } catch (err) {
      await replyPrivate(e, `${GAME_TITLE} 获取二维码失败：${err?.message || err}`)
      return true
    }
    if (!scanId) {
      await replyPrivate(e, `${GAME_TITLE} 获取二维码失败，请稍后重试`)
      return true
    }

    scanUrl = scanUrl || `hypergryph://scan_login?scanId=${scanId}`

    let qrPath = ""
    try {
      qrPath = await makeQrPng(scanUrl)
      await replyPrivate(
        e,
        [
          `${GAME_TITLE} 请使用森空岛 App 扫码登录（二维码有效期约 1 分钟）`,
          segment.image(qrPath),
        ],
      )
    } catch (err) {
      await replyPrivate(e, `${GAME_TITLE} 生成二维码失败：${err?.message || err}\n你也可以改用：${cfg.cmd?.prefix || "#zmd"}绑定 <cred>`)
      return true
    } finally {
      if (qrPath) {
        fs.unlink(qrPath).catch(() => {})
      }
    }

    let scanCode = ""
    try {
      for (let i = 0; i < 50; i++) {
        await sleep(2000)
        scanCode = await getScanStatus(scanId, e.user_id)
        if (scanCode) break
      }
    } catch (err) {
      await replyPrivate(e, `${GAME_TITLE} 扫码状态查询失败：${err?.message || err}`)
      return true
    }

    if (!scanCode) {
      await replyPrivate(e, `${GAME_TITLE} 二维码已超时，请重新获取并扫码`)
      return true
    }

    let token = ""
    let deviceToken = ""
    try {
      const tokenRes = await getTokenByScanCode(scanCode, e.user_id)
      token = typeof tokenRes === "string" ? tokenRes : String(tokenRes?.token || "")
      if (tokenRes && typeof tokenRes === "object") deviceToken = String(tokenRes.deviceToken || "")
    } catch (err) {
      await replyPrivate(e, `${GAME_TITLE} 获取 token 失败：${err?.message || err}`)
      return true
    }
    if (!token) {
      await replyPrivate(e, `${GAME_TITLE} 获取 token 失败，请重试`)
      return true
    }

    let info
    try {
      info = await getCredInfoByToken(token, { userId: e.user_id })
    } catch (err) {
      await replyPrivate(e, `${GAME_TITLE} 获取 cred 失败：${err?.message || err}`)
      return true
    }
    if (info?.error === "405") {
      await replyPrivate(e, `${GAME_TITLE} 当前服务无法使用 token 登录，请尝试使用 cred`)
      return true
    }
    if (!info?.cred) {
      await replyPrivate(e, `${GAME_TITLE} 获取 cred 失败，请重试`)
      return true
    }

    const bindRes = await bindByCred(info.cred, e.user_id, { usedToken: token, sklandUserId: info.sklandUserId, deviceToken })
    await replyPrivate(e, bindRes.message)

    if (bindRes.ok && cfg.gacha?.autoSyncAfterLogin) {
      setTimeout(async () => {
        try {
          const res = await updateGachaLogsForUser(e.user_id)
          if (!res?.ok) return
          const added = (Number(res.newCharCount) || 0) + (Number(res.newWeaponCount) || 0)
          if (added <= 0) return

          await replyPrivate(
            e,
            [
              `${GAME_TITLE} 登录后已自动同步抽卡记录`,
              `新增角色记录：${res.newCharCount} 条`,
              `新增武器记录：${res.newWeaponCount} 条`,
            ].join("\n"),
          )
        } catch {}
      }, 50)
    }
    return true
  }

  async list() {
    const e = this.e
    const data = await getUserData(e.user_id)
    if (!data.accounts.length) {
      await e.reply(`${GAME_TITLE} 还没有绑定账号，请先私聊：${cfg.cmd?.prefix || "#zmd"}绑定 <cred|token>`, true)
      return true
    }
    const lines = data.accounts.map((a, idx) => {
      const activeMark = idx === Number(data.active || 0) ? "（当前）" : ""
      return `${idx + 1}. ${a.nickname || "未命名"} UID:${a.uid || "-"} S:${a.serverId || "1"} ${activeMark}`.trim()
    })
    await e.reply(`${GAME_TITLE} 已绑定账号：\n${lines.join("\n")}`, true)
    return true
  }

  async switch() {
    const e = this.e
    const raw = e.msg.replace(/^#?(?:终末地|zmd)(?:切换|switch)/i, "").trim()
    const res = await setActiveAccount(e.user_id, raw)
    if (!res.ok) {
      await e.reply(`${GAME_TITLE} 切换失败：请使用序号或 UID\n例如：${cfg.cmd?.prefix || "#zmd"}切换 1`, true)
      return true
    }
    const a = res.data.accounts[res.index]
    await e.reply(`${GAME_TITLE} 已切换：${a.nickname || "未命名"} UID:${a.uid}`, true)
    return true
  }

  async del() {
    const e = this.e
    const raw = e.msg.replace(/^#?(?:终末地|zmd)(?:删除|解绑|del)/i, "").trim()
    if (!raw) {
      await e.reply(`${GAME_TITLE} 请带上序号或 UID\n例如：${cfg.cmd?.prefix || "#zmd"}删除 1`, true)
      return true
    }
    const res = await deleteAccount(e.user_id, raw)
    if (!res.ok) {
      await e.reply(`${GAME_TITLE} 删除失败：未找到目标`, true)
      return true
    }
    await e.reply(`${GAME_TITLE} 删除成功`, true)
    return true
  }

  async sign() {
    const e = this.e
    const { account } = await getActiveAccount(e.user_id)
    if (!account?.cred || !account?.uid) {
      await e.reply(`${GAME_TITLE} 未绑定账号，请先私聊：${cfg.cmd?.prefix || "#zmd"}绑定 <cred|token>`, true)
      return true
    }

    let res
    try {
      res = await attendance(account.cred, account.uid)
    } catch (err) {
      await e.reply(`${GAME_TITLE} 签到请求失败：${err?.message || err}`, true)
      return true
    }
    if (!res) {
      await e.reply(`${GAME_TITLE} 签到请求失败`, true)
      return true
    }

    if (res.code === 0) {
      await recordSuccess(1)
      await e.reply(`${GAME_TITLE} ✅ [${account.nickname || account.uid}] 签到完成\n${formatAwards(res)}`, true)
      return true
    }
    if (res.code === 10001) {
      await e.reply(`${GAME_TITLE} ☑️ [${account.nickname || account.uid}] 今日已签到`, true)
      return true
    }
    await recordFail(1)
    await e.reply(`${GAME_TITLE} ❌ [${account.nickname || account.uid}] 签到失败：${res.message || res.code}`, true)
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

      const concurrency = Math.max(1, Number(cfg.autoSign?.concurrency) || 3)
      const minInterval = Math.max(0, Number(cfg.autoSign?.minIntervalSec) || 0)
      const maxInterval = Math.max(minInterval, Number(cfg.autoSign?.maxIntervalSec) || minInterval)

      let success = 0
      let signed = 0
      let fail = 0
      const detailLines = []

      async function runOne(userId) {
        const { account } = await getActiveAccount(userId)
        if (!account) return { status: "skip", message: `⏭️ 未绑定` }

        const name = String(account.nickname || account.uid || "未命名")
        const uidText = account.uid ? String(account.uid) : "-"
        const label = `UID:${uidText} ${name}`

        if (!account?.cred || !account?.uid) return { status: "skip", message: `⏭️ 数据不完整 ${label}` }

        try {
          const res = await attendance(account.cred, account.uid)
          if (!res) {
            await recordFail(1)
            return { status: "fail", message: `❌ ${label} 请求失败` }
          }
          if (res.code === 0) {
            await recordSuccess(1)
            return { status: "success", message: `✅ ${label}` }
          }
          if (res.code === 10001) return { status: "signed", message: `☑️ 已签 ${label}` }

          await recordFail(1)
          return { status: "fail", message: `❌ ${label} ${res.message || res.code}` }
        } catch (err) {
          await recordFail(1)
          return { status: "fail", message: `❌ ${label} 异常 ${err?.message || err}` }
        }
      }

      for (let i = 0; i < users.length; i += concurrency) {
        const batch = users.slice(i, i + concurrency).map(String)
        const results = await Promise.all(batch.map(u => runOne(u)))
        for (const r of results) {
          if (r.status === "success") success++
          else if (r.status === "signed") signed++
          else if (r.status === "fail") fail++
          detailLines.push(r.message)
        }
        if (i + concurrency < users.length && maxInterval > 0) {
          const waitSec =
            minInterval === maxInterval ? minInterval : minInterval + Math.random() * (maxInterval - minInterval)
          await sleep(waitSec * 1000)
        }
      }

      const maxLines = 40
      const body =
        detailLines.length > maxLines
          ? `${detailLines.slice(0, maxLines).join("\n")}\n... 还有 ${detailLines.length - maxLines} 条`
          : detailLines.join("\n")

      await e.reply(`${GAME_TITLE} 全部签到完成：成功 ${success} | 已签 ${signed} | 失败 ${fail}\n${body}`, true)
      return true
    } finally {
      autoSignRunning = false
    }
  }

  async daily() {
    const e = this.e
    const uid = getQueryUserId(e)
    const { account } = await getActiveAccount(uid)
    if (!account?.cred || !account?.uid) {
      await e.reply(`${GAME_TITLE} 未绑定账号，请先私聊：${cfg.cmd?.prefix || "#zmd"}绑定 <cred|token>`, true)
      return true
    }

    let userId = String(account.sklandUserId || "")
    try {
      if (!userId) userId = await ensureSklandUserId(account.cred, account, uid)
    } catch (err) {
      await e.reply(`${GAME_TITLE} 获取森空岛 userId 失败：${err?.message || err}`, true)
      return true
    }

    if (!userId) {
      const hint = [
        `${GAME_TITLE} 缺少 skland userId，且自动获取失败。`,
        `请检查 smsdk 是否可用（需要 sm.sdk.js）：${cfg.cmd?.prefix || "#zmd"}环境`,
      ].join("\n")
      await e.reply(hint, true)
      return true
    }

    let res
    try {
      res = await getCardDetail(account.cred, { uid: account.uid, serverId: account.serverId || "1", userId })
    } catch (err) {
      await e.reply(`${GAME_TITLE} 获取卡片详情失败：${err?.message || err}`, true)
      return true
    }
    if (!res) {
      await e.reply(`${GAME_TITLE} 获取卡片详情失败（请求失败）`, true)
      return true
    }
    if (res.code !== 0) {
      await e.reply(`${GAME_TITLE} 获取卡片详情失败：${res.message || res.code}`, true)
      return true
    }

    const detail = res?.data?.detail || {}
    const base = detail.base || {}
    const dungeon = detail.dungeon || {}
    const bp = detail.bpSystem || {}
    const daily = detail.dailyMission || {}

    const staminaCur = safeInt(dungeon.curStamina)
    const staminaTotal = safeInt(dungeon.maxStamina)
    const maxTs = safeInt(dungeon.maxTs)
    const currentTs = safeInt(detail.currentTs)
    const recovery = formatRecoveryTime({ maxTs, currentTs, staminaCur, staminaTotal })

    const msg = [
      `${GAME_TITLE} 每日`,
      `昵称: ${base.name || account.nickname || "-"}`,
      `UID: ${base.roleId || account.uid}`,
      `等级: ${base.level ?? "-"}  世界等级: ${base.worldLevel ?? "-"}`,
      `体力: ${staminaCur}/${staminaTotal}  回满: ${recovery.text}`,
      `通行证: ${safeInt(bp.curLevel)}/${safeInt(bp.maxLevel)}`,
      `活跃: ${safeInt(daily.dailyActivation)}/${safeInt(daily.maxDailyActivation)}`,
    ].join("\n")

    try {
      const bpCur = safeInt(bp.curLevel)
      const bpTotal = safeInt(bp.maxLevel)
      const actCur = safeInt(daily.dailyActivation)
      const actTotal = safeInt(daily.maxDailyActivation)

      const resPath = rel => pluginResourcesRelPath(rel)

      const bgUrl = resPath("enduid/texture2d/end_daily_bg.png")
      const logoUrl = resPath("enduid/texture2d/end_daily_logo.png")
      const staminaIconUrl = resPath("enduid/texture2d/end_daily_sanity.png")
      const bpIconUrl = resPath("enduid/texture2d/end_daily_pass.png")
      const livenessIconUrl = resPath("enduid/texture2d/end_daily_active.png")

      let pileUrl = ""
      try {
        const chars = Array.isArray(detail.chars) ? detail.chars : []
        const candidates = []
        for (const c of chars) {
          const url =
            c?.charData?.avatarRtUrl ||
            c?.charData?.avatar_rt_url ||
            c?.avatarRtUrl ||
            c?.avatar_rt_url
          if (url) candidates.push(String(url).trim())
        }
        const pick = candidates[Math.floor(Math.random() * candidates.length)]
        if (pick) pileUrl = pick
      } catch {}

      let avatarUrl = String(base.avatarUrl || "").trim()
      if (!avatarUrl) avatarUrl = getQqAvatarUrl(e.user_id)
      if (!avatarUrl) avatarUrl = resPath("state/img/default_avatar.jpg")

      const userName = String(base.name || account.nickname || "-").slice(0, 10)
      const roleId = String(base.roleId || account.uid || "-")

      const staminaPercent = clampPercent(staminaCur, staminaTotal)
      const bpPercent = clampPercent(bpCur, bpTotal)
      const actPercent = clampPercent(actCur, actTotal)

      const COLOR_URGENT = "#ff4d4f"
      const COLOR_YELLOW = "#FFCB3B"
      const COLOR_GREEN = "#52C41A"
      const COLOR_BLUE = "#4D9CFF"

      const staminaColor = staminaPercent > 80 ? COLOR_URGENT : COLOR_YELLOW

      const img = await renderImg(
        "enduid/daily_pro",
        {
          pile_url: pileUrl,
          bg_url: bgUrl,
          logo_url: logoUrl,
          avatar_url: avatarUrl,
          user_name: userName,
          uid: roleId,
          user_level: safeInt(base.level),
          world_level: safeInt(base.worldLevel),
          stamina_icon_url: staminaIconUrl,
          bp_icon_url: bpIconUrl,
          liveness_icon_url: livenessIconUrl,
          stamina: {
            cur: staminaCur,
            total: staminaTotal,
            percent: staminaPercent,
            color: staminaColor,
            recovery_text: recovery.text,
            urgent: recovery.urgent,
          },
          battle_pass: {
            cur: bpCur,
            total: bpTotal,
            percent: bpPercent,
            color: COLOR_BLUE,
          },
          liveness: {
            cur: actCur,
            total: actTotal,
            percent: actPercent,
            color: COLOR_GREEN,
          },
        },
        { scale: 1, quality: 90 },
      )

      if (img) {
        await e.reply(img, true)
        return true
      }
    } catch (err) {
      logger.error(`${GAME_TITLE} 每日图片渲染失败：${err?.message || err}`)
    }

    await e.reply(msg, true)
    return true
  }

  async autoSignOn() {
    const e = this.e
    const data = await setAutoSign(e.user_id, true)
    if (!data.accounts.length) {
      data.autoSign = false
      await saveUserData(e.user_id, data)
      await e.reply(`${GAME_TITLE} 还没有绑定账号，无法开启`, true)
      return true
    }
    await e.reply(`${GAME_TITLE} 已开启自动签到`, true)
    return true
  }

  async autoSignOff() {
    const e = this.e
    await setAutoSign(e.user_id, false)
    await e.reply(`${GAME_TITLE} 已关闭自动签到`, true)
    return true
  }
}
