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

import cfg, { configSave } from "../model/config.js"
import { patchTempSessionReply } from "../model/reply.js"
import { render as renderImg } from "../model/render.js"
import { getCardDetailForUser } from "../model/card.js"
import { updateGachaLogsForUser } from "../model/gachalog.js"
import { getQueryUserId } from "../model/mention.js"
import { recordFail, recordSuccess } from "../model/signStats.js"
import { getFriendApiHealth, getFriendApiRuntimeConfig } from "../model/friendApi.js"
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
  upsertUidOnlyAccount,
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

function compactLogValue(value, max = 800) {
  let text = ""
  if (typeof value === "string") text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  text = text.replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function formatThrowable(err) {
  if (err instanceof Error) return err.message || err.name || "Error"
  if (typeof err === "string") return err
  if (err && typeof err === "object") return compactLogValue(err)
  return String(err || "未知错误")
}

function logThrowable(action, err) {
  const msg = formatThrowable(err)
  const detail = err instanceof Error ? err.stack || err.message : msg
  logger.error(`${GAME_TITLE} ${action}：${detail}`)
  return msg
}

function looksLikeObjectString(text) {
  return /^\[object\s+[^\]]+\]$/.test(String(text || "").trim())
}

function isGroupQrLoginEnabled() {
  return cfg.security?.allowQrLoginInGroup === true
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
  const data = res?.data && typeof res.data === "object" ? res.data : {}

  const items = []

  // Endfield attendance response usually provides awardIds + resourceInfoMap.
  const awardIds = Array.isArray(data.awardIds) ? data.awardIds : []
  const resourceInfoMap = data.resourceInfoMap && typeof data.resourceInfoMap === "object" ? data.resourceInfoMap : {}
  for (const award of awardIds) {
    const id = String(award?.id ?? award?.resourceId ?? award?.resource_id ?? "").trim()
    const info = (id && (resourceInfoMap[id] || resourceInfoMap[String(id)])) || {}
    const name = String(info?.name || award?.name || award?.resource?.name || award?.resourceName || award?.resource_id || id || "未知").trim()
    const count = award?.count ?? info?.count ?? 0
    items.push({ name, count })
  }

  // Fallback for other attendance APIs that return data.awards / data.rewards.
  const awards = Array.isArray(data.awards) ? data.awards : Array.isArray(data.rewards) ? data.rewards : []
  for (const award of awards) {
    const name = String(award?.resource?.name || award?.name || award?.resourceName || award?.resource?.id || award?.resource_id || "未知").trim()
    const count = award?.count ?? award?.num ?? 0
    items.push({ name, count })
  }

  const uniq = []
  const seen = new Set()
  for (const item of items) {
    const name = String(item?.name || "").trim()
    const count = item?.count ?? 0
    const key = `${name}|${count}`
    if (!name || seen.has(key)) continue
    seen.add(key)
    uniq.push({ name, count })
  }

  if (!uniq.length) return "（暂无奖励信息）"
  return uniq.map(item => `- ${item.name} × ${item.count}`).join("\n")
}

function isAlreadySigned(res) {
  return res?.code === 10001 || !!(res?.data && (res.data.already_signed || res.data.alreadySigned))
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

function pickBindingRole(bindingEntry) {
  const bind = bindingEntry && typeof bindingEntry === "object" ? bindingEntry : {}
  const roles = Array.isArray(bind.roles) ? bind.roles.filter(role => role && typeof role === "object") : []

  const explicitDefault = bind.defaultRole && typeof bind.defaultRole === "object" ? bind.defaultRole : null
  if (explicitDefault?.roleId) return { role: explicitDefault, score: 120 }

  const flagged = roles.find(role => role?.isDefault || role?.default || role?.selected || role?.is_selected)
  if (flagged?.roleId) return { role: flagged, score: 100 }

  const first = roles.find(role => role?.roleId)
  if (first?.roleId) return { role: first, score: 80 }

  return { role: null, score: 0 }
}

function pickBestEndfieldBinding(bindingItems) {
  const items = Array.isArray(bindingItems) ? bindingItems : []
  const candidates = []

  for (const item of items) {
    if (item?.appCode !== "endfield") continue
    const bindList = Array.isArray(item?.bindingList) ? item.bindingList : []
    const itemDefaultUid = String(item?.defaultUid ?? item?.default_uid ?? "").trim()

    for (const bind of bindList) {
      const { role, score } = pickBindingRole(bind)
      const roleId = String(role?.roleId || "").trim()
      if (!roleId) continue

      const recordUid = String(bind?.uid ?? itemDefaultUid ?? "").trim()
      candidates.push({
        score: score + (recordUid ? 10 : 0) + (itemDefaultUid && recordUid === itemDefaultUid ? 20 : 0),
        uid: roleId,
        nickname: String(role?.nickname || bind?.nickName || bind?.nickname || "终末地角色").trim(),
        channelName: String(bind?.channelName || item?.channelName || "官服").trim(),
        recordUid,
        serverId: String(role?.serverId || bind?.serverId || item?.serverId || "1").trim() || "1",
      })
    }
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]
}

async function bindByCred(cred, userId, { usedToken, sklandUserId, deviceToken } = {}) {
  const res = await getBinding(cred)
  if (!res || res.code !== 0 || res.message !== "OK") {
    return { ok: false, message: `${GAME_TITLE} 绑定失败：请检查 cred 是否正确` }
  }

  const bindingList = Array.isArray(res?.data?.list) ? res.data.list : []
  const picked = pickBestEndfieldBinding(bindingList)

  const endfieldUid = String(picked?.uid || "")
  const nickname = String(picked?.nickname || "")
  const channelName = String(picked?.channelName || "")
  const recordUid = String(picked?.recordUid || "")
  const serverId = String(picked?.serverId || "1") || "1"

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
  if (autoSignRunning) {
    logger.warn(`[${PLUGIN_ID}] 自动签到跳过：已有任务正在执行`)
    return
  }
  autoSignRunning = true

  try {
    const users = await listAutoSignUsers()
    if (!users.length) {
      logger.info(`[${PLUGIN_ID}] 自动签到跳过：没有已开启的用户`)
      return
    }

    const concurrency = Math.max(1, Number(cfg.autoSign?.concurrency) || 3)
    const minInterval = Math.max(0, Number(cfg.autoSign?.minIntervalSec) || 0)
    const maxInterval = Math.max(minInterval, Number(cfg.autoSign?.maxIntervalSec) || minInterval)

    const results = []

    async function runOne(userId) {
      const { account } = await getActiveAccount(userId)
      if (!account?.cred || !account?.uid) return { status: "skip", text: `${userId}: 未绑定` }

      try {
        const res = await attendance(account.cred, account.uid)
        if (!res) {
          await recordFail(1)
          return { status: "fail", text: `${userId}: 请求失败` }
        }
        if (isAlreadySigned(res)) {
          return { status: "signed", text: `${userId}: ☑️ 已签 ${account.nickname || account.uid}` }
        }
        if (res.code === 0) {
          await recordSuccess(1)
          return { status: "success", text: `${userId}: ✅ ${account.nickname || account.uid}` }
        }

        await recordFail(1)
        return { status: "fail", text: `${userId}: ❌ ${account.nickname || account.uid} ${res.message || res.code}` }
      } catch (err) {
        await recordFail(1)
        return { status: "fail", text: `${userId}: 异常 ${err?.message || err}` }
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

    const count = status => results.filter(item => item.status === status).length
    const success = count("success")
    const signed = count("signed")
    const fail = count("fail")
    const skip = count("skip")
    logger.info(`[${PLUGIN_ID}] 自动签到完成：成功 ${success} | 已签 ${signed} | 失败 ${fail} | 跳过 ${skip}`)
    if (fail || skip) {
      const details = results
        .filter(item => item.status === "fail" || item.status === "skip")
        .map(item => item.text)
        .join(" | ")
      logger.warn(`[${PLUGIN_ID}] 自动签到异常明细：${details}`)
    }

    const notify = String(cfg.autoSign?.notifyUserId || "").trim()
    if (notify) {
      try {
        await Bot.pickFriend(notify).sendMsg(
          [`${GAME_TITLE} 自动签到结果：`, ...results.map(item => item.text)].join("\n"),
        )
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
        // Feedback entry is intentionally global (#反馈) for convenience.
        { reg: "^#\\s*反馈\\s*$", fnc: "feedback" },
        { reg: "^#?(?:终末地|zmd|ZMD)反馈\\s*$", fnc: "feedback" },

        // Role-data source (Friend API) switching.
        { reg: "^#?(?:终末地|zmd|ZMD)?\\s*(?:数据源|数据源状态|数据源查看)\\s*$", fnc: "dataSourceStatus" },
        { reg: "^#?(?:终末地|zmd|ZMD)?\\s*(?:数据源切换|切换数据源)\\s*(.*)$", fnc: "dataSourceSwitch", permission: "master" },
        { reg: "^#?(?:终末地|zmd|ZMD)?\\s*(?:统一后端|后端)(?:地址|url|URL)\\s*(.+)$", fnc: "setUnifiedBackendUrl", permission: "master" },
        {
          reg: "^#?(?:终末地|zmd|ZMD)?\\s*(?:统一后端|后端)(?:token|Token|TOKEN|令牌|密钥|bearer|Bearer)\\s*(.+)$",
          fnc: "setUnifiedBackendToken",
          permission: "master",
        },
        {
          reg: "^#?(?:终末地|zmd|ZMD)?\\s*(?:统一后端|后端)(?:apikey|api_key|apiKey|APIKEY|API密钥|API秘钥)\\s*(.+)$",
          fnc: "setUnifiedBackendApiKey",
          permission: "master",
        },
        {
          reg: "^#?(?:终末地|zmd|ZMD)?\\s*(?:统一后端|后端)(?:frameworktoken|framework_token|framework|框架token|框架令牌)\\s*(.+)$",
          fnc: "setUnifiedBackendFrameworkToken",
          permission: "master",
        },
        {
          reg: "^#?(?:终末地|zmd|ZMD)?\\s*(?:统一后端|后端)(?:匿名token|匿名Token|匿名令牌|匿名密钥|anonymous|anon)\\s*(.+)$",
          fnc: "setUnifiedBackendAnonymousToken",
          permission: "master",
        },
        { reg: "^#?(?:终末地|zmd|ZMD)?\\s*(?:本地数据|本地后端)(?:地址|url|URL)\\s*(.+)$", fnc: "setLocalBackendUrl", permission: "master" },
        {
          reg: "^#?(?:终末地|zmd|ZMD)?\\s*(?:本地数据|本地后端)(?:token|Token|TOKEN|令牌|密钥|bearer|Bearer)\\s*(.+)$",
          fnc: "setLocalBackendToken",
          permission: "master",
        },

        { reg: "^#?(?:终末地|zmd)(?:登录|login|dl)$", fnc: "login" },
        {
          reg: "^#?(?:终末地|zmd)(?:群聊扫码登录\\s*(?:开启|关闭|on|off)?|(?:开启|关闭)群聊扫码登录)$",
          fnc: "setGroupQrLogin",
          permission: "master",
        },
        { reg: "^#?(?:终末地|zmd)(?:绑定|bind)\\s*(.+)$", fnc: "bind" },
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
    })

    // Miao-Yunzai 会重建 super({ task })，需在 super() 后保留完整任务对象。
    this.task = {
      name: `${PLUGIN_ID}自动签到`,
      cron: String(cfg.autoSign?.cron || "0 5 4 * * *"),
      fnc: runAutoSignAll,
    }
  }

  async help() {
    const e = this.e
    const p = cfg.cmd?.prefix || "#zmd"
    const fz = "#fz"

    const isMaster = !!e.isMaster
    const groupQrLoginEnabled = isGroupQrLoginEnabled()
    const qrLoginDesc = groupQrLoginEnabled ? "支持群聊扫码，二维码发送到当前群" : "仅私聊扫码登录并绑定"

    const sections = [
      {
        title: "账号",
        desc: "绑定/切换终末地账号",
        items: [
          { name: "登录", cmd: `${p}登录`, desc: qrLoginDesc },
          { name: "绑定", cmd: `${p}绑定<cred|token>`, desc: "私聊，支持 cred= / token= 前缀" },
          { name: "绑定UID", cmd: `${p}绑定<UID>`, desc: "无需登录，仅用于角色面板查询" },
          { name: "查看", cmd: `${p}查看`, desc: "查看已绑定账号" },
          { name: "切换", cmd: `${p}切换<序号|UID>`, desc: "切换当前账号" },
          { name: "删除", cmd: `${p}删除<序号|UID>`, desc: "删除绑定" },
        ],
      },
      {
        title: "查询",
        desc: "每日/卡片/面板等查询",
        items: [
          { name: "每日", cmd: `${p}每日<@用户>`, desc: "体力/回满/通行证/活跃" },
          { name: "刷新", cmd: `${p}刷新`, desc: "刷新卡片/面板数据" },
          { name: "卡片", cmd: `${p}卡片<@用户>`, desc: "终末地卡片总览" },
          { name: "面板", cmd: `#<角色>面板<@用户>`, desc: "角色面板" },
          { name: "基建", cmd: `${p}基建<@用户>`, desc: "地区建设/飞船信息" },
          { name: "活动日历", cmd: `${p}日历`, desc: "查看当前/近期卡池活动" },
          { name: "公告", cmd: `${p}公告<id>`, desc: "查看公告列表/详情（不填 id 为列表）" },
          { name: "抽卡记录", cmd: `${p}抽卡记录<UID/@他人>`, desc: "查看抽卡记录" },
          { name: "角色记录", cmd: `${p}角色记录<UID/@他人>`, desc: "只看角色池" },
          { name: "武器记录", cmd: `${p}武器记录<UID/@他人>`, desc: "只看武器池" },
          { name: "更新抽卡记录", cmd: `${p}更新抽卡记录<UID/@他人>`, desc: "拉取并保存抽卡记录" },
          { name: "全量更新抽卡记录", cmd: `${p}全量更新抽卡记录<UID/@他人>`, desc: "全量重拉并覆盖本地缓存" },
          { name: "更新武器图标", cmd: `${p}更新武器图标<UID>`, desc: "从 wiki 补全抽卡武器图标缓存（可选：强制）" },
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
        desc: "公告与活动提醒",
        items: [
          { name: "订阅公告", cmd: `${p}订阅公告`, desc: "" },
          { name: "取消订阅", cmd: `${p}取消订阅公告`, desc: "" },
          { name: "活动提醒", cmd: `${p}订阅活动提醒`, desc: "群聊/私聊订阅活动开始与结束提醒" },
          { name: "取消提醒", cmd: `${p}取消订阅活动提醒`, desc: "" },
          { name: "提醒列表", cmd: `${p}活动提醒列表`, desc: "查看当前会话的活动提醒状态" },
          { name: "清理缓存", cmd: `${p}清理公告缓存`, desc: "清理公告内存缓存（不影响订阅/已读）", badge: "MASTER" },
        ],
      },
      {
        title: "图鉴",
        desc: "biligame wiki：列表/卡池/图鉴查询",
        items: [
          { name: "角色列表", cmd: `${p}角色列表`, desc: "" },
          { name: "武器列表", cmd: `${p}武器列表`, desc: "" },
          { name: "卡池信息", cmd: `${p}卡池`, desc: "" },
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
        title: "明日方舟",
        desc: "森空岛功能（复用 #zmd 绑定）",
        items: [
          { name: "签到", cmd: `${fz}签到`, desc: "" },
          { name: "活动", cmd: `${fz}活动`, desc: "查看进行中/近期活动" },
          { name: "自动签到", cmd: `${fz}开启自动签到 / ${fz}关闭自动签到`, desc: "" },
          { name: "全部签到", cmd: `${fz}全部签到`, desc: "执行全部签到任务", badge: "MASTER" },
          { name: "抽卡记录", cmd: `${fz}更新 / 全量 / 导入 / 导出 / 删除 / 查看抽卡记录`, desc: "限定/常驻/中坚聚合，支持 @用户" },
          { name: "抽卡分析", cmd: `${fz}抽卡分析 / ${fz}卡池分析 <卡池名>`, desc: "查看整体统计与指定卡池分析" },
        ],
      },
      {
        title: "其他",
        desc: "状态/日志/环境",
        items: [
          { name: "状态", cmd: `${p}状态`, desc: "" },
          { name: "更新日志", cmd: `${p}更新日志`, desc: "" },
          { name: "环境", cmd: `${p}环境`, desc: "诊断 smsdk/qrcode 依赖" },
          { name: "更新插件", cmd: "#zmd更新插件", desc: "拉取最新代码", badge: "MASTER" },
          { name: "强制更新", cmd: "#zmd强制更新插件", desc: "遇到冲突/偏离时使用", badge: "MASTER" },
          { name: "数据源", cmd: "#数据源", desc: "查看角色数据接口来源" },
          { name: "切换数据源", cmd: "#数据源切换", desc: "切换统一后端/本地", badge: "MASTER" },
          { name: "后端地址", cmd: "#统一后端地址 <url>", desc: "设置统一后端地址", badge: "MASTER" },
          { name: "后端Token", cmd: "#统一后端token <token>", desc: "设置统一后端 Bearer", badge: "MASTER" },
          { name: "后端ApiKey", cmd: "#统一后端apikey <key>", desc: "设置统一后端 API Key", badge: "MASTER" },
          { name: "框架Token", cmd: "#统一后端frameworktoken <token>", desc: "设置统一后端 Framework Token", badge: "MASTER" },
          { name: "匿名Token", cmd: "#统一后端匿名token <token>", desc: "设置统一后端匿名令牌", badge: "MASTER" },
          { name: "本地地址", cmd: "#本地数据地址 <url>", desc: "设置本地 Friend API 地址", badge: "MASTER" },
          { name: "本地Token", cmd: "#本地数据token <token>", desc: "设置本地 Friend API Bearer", badge: "MASTER" },
          {
            name: "群聊扫码",
            cmd: `${p}群聊扫码登录 开启 / ${p}群聊扫码登录 关闭`,
            desc: `${groupQrLoginEnabled ? "当前已开启" : "当前已关闭"}，仅主人可设置`,
            badge: "MASTER",
          },
          { name: "反馈", cmd: "#反馈", desc: "联系作者 1493218095 / 加群 1084459856" },
          { name: "上传背景图", cmd: `${p}上传背景图`, desc: "上传到本地图库（随机渲染背景）", badge: "MASTER" },
        ],
      },
    ]

    const visibleSections = sections
      .map(s => ({
        ...s,
        items: Array.isArray(s.items) ? s.items.filter(it => isMaster || it?.badge !== "MASTER") : [],
      }))
      .filter(s => Array.isArray(s.items) && s.items.length)

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
          subtitle: "",
          avatar,
          prefix: p,
          time: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`,
          sections: visibleSections,
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
      logger.error(`${GAME_TITLE} 帮助菜单图片渲染失败：${err?.message || err}`)
    }

    const lines = [
      `${GAME_TITLE} 帮助`,
      ``,
      `【账号】`,
      `- ${p}登录（${qrLoginDesc}）`,
      `- ${p}绑定<cred|token>（私聊）`,
      `- ${p}绑定<UID>（无需登录，仅用于角色面板查询）`,
      `- ${p}查看`,
      `- ${p}切换<序号|UID>`,
      `- ${p}删除<序号|UID>`,
      ``,
      `【查询】`,
      `- ${p}每日<@用户>`,
      `- ${p}刷新`,
      `- ${p}卡片<@用户>`,
      `- #<角色>面板<@用户>`,
      `- ${p}基建<@用户>`,
      `- ${p}日历`,
      `- ${p}公告<id>`,
      `- ${p}抽卡记录<UID/@他人>`,
      `- ${p}角色记录<UID/@他人>`,
      `- ${p}武器记录<UID/@他人>`,
      `- ${p}更新抽卡记录<UID/@他人>`,
      `- ${p}全量更新抽卡记录<UID/@他人>`,
      `- ${p}更新武器图标<UID>（可选：强制）`,
      ``,
      `【别名】`,
      `- ${p}别名<角色>`,
      `- ${p}添加别名<角色><别名>`,
      `- ${p}删除别名<角色><别名>`,
      ``,
      `【推送】`,
      `- ${p}订阅公告`,
      `- ${p}取消订阅公告`,
      `- ${p}订阅活动提醒`,
      `- ${p}取消订阅活动提醒`,
      `- ${p}活动提醒列表`,
      isMaster ? `- ${p}清理公告缓存（仅 master）` : "",
      ``,
      `【图鉴】`,
      `- ${p}角色列表`,
      `- ${p}武器列表`,
      `- ${p}卡池`,
      `- ${p}<名称>图鉴（也可查：介绍/技能/天赋/潜能/专武/武器）`,
      ``,
      `【签到】`,
      `- ${p}签到`,
      `- ${p}开启自动签到 / ${p}关闭自动签到`,
      isMaster ? `- ${p}全部签到（仅 master）` : "",
      ``,
      `【明日方舟】`,
      `- ${fz}签到`,
      `- ${fz}活动`,
      `- ${fz}开启自动签到 / ${fz}关闭自动签到`,
      isMaster ? `- ${fz}全部签到（仅 master）` : "",
      `- ${fz}更新抽卡记录 / ${fz}全量更新抽卡记录 / ${fz}抽卡记录`,
      `- ${fz}抽卡分析 / ${fz}卡池分析 <卡池名>`,
      `- ${fz}导入抽卡记录 / ${fz}导出抽卡记录 / ${fz}删除抽卡记录`,
      ``,
      `【其他】`,
      `- ${p}状态`,
      `- ${p}更新日志`,
      `- ${p}环境`,
      isMaster ? `- #zmd更新插件（仅 master）` : "",
      isMaster ? `- #zmd强制更新插件（仅 master）` : "",
      `- #数据源`,
      isMaster ? `- #数据源切换（仅 master）` : "",
      isMaster ? `- #统一后端地址 <url>（仅 master）` : "",
      isMaster ? `- #统一后端token <token>（仅 master，建议私聊；支持 Bearer / ef_ / qr_）` : "",
      isMaster ? `- #统一后端apikey <key>（仅 master，建议私聊）` : "",
      isMaster ? `- #统一后端frameworktoken <token>（仅 master，建议私聊）` : "",
      isMaster ? `- #统一后端匿名token <token>（仅 master，建议私聊）` : "",
      isMaster ? `- ${p}群聊扫码登录 开启/关闭（仅 master）` : "",
      `- #反馈（联系作者 1493218095 / 加群 1084459856）`,
      isMaster ? `- ${p}上传背景图（仅 master）` : "",
    ]
      .filter(Boolean)
      .join("\n")

    await e.reply(lines, true)
    return true
  }

  async feedback() {
    const e = this.e
    const lines = [
      `${GAME_TITLE} 反馈与交流`,
      `- 反馈联系作者：1493218095`,
      `- 交流群：1084459856`,
      `建议带上：触发指令 + UID/角色 + 截图/日志 + 时间`,
    ].join("\n")
    await e.reply(lines, true)
    return true
  }

  async dataSourceStatus() {
    const e = this.e

    const runtime = getFriendApiRuntimeConfig()
    const localUrl = String(runtime.localBaseUrl || "").trim()
    const unifiedUrl = String(runtime.unifiedBaseUrl || "").trim()

    const localBearerSet = !!String(cfg.friendApi?.bearer || cfg.friendApi?.bearerToken || cfg.friendApi?.bearerKey || "").trim()
    const unifiedBearerSet = !!String(cfg.friendApi?.unifiedBearer || cfg.friendApi?.unifiedBearerToken || cfg.friendApi?.unifiedBearerKey || "").trim()
    const effectiveBearerSet = !!String(runtime.bearer || "").trim()

    const localApiKeySet = !!String(cfg.friendApi?.apiKey || cfg.friendApi?.api_key || "").trim()
    const unifiedApiKeySet = !!String(cfg.friendApi?.unifiedApiKey || cfg.friendApi?.unified_api_key || "").trim()
    const effectiveApiKeySet = !!String(runtime.apiKey || "").trim()

    const localFrameworkSet = !!String(cfg.friendApi?.frameworkToken || cfg.friendApi?.framework_token || "").trim()
    const unifiedFrameworkSet = !!String(cfg.friendApi?.unifiedFrameworkToken || cfg.friendApi?.unified_framework_token || "").trim()
    const effectiveFrameworkSet = !!String(runtime.frameworkToken || "").trim()

    const localAnonSet = !!String(cfg.friendApi?.anonymousToken || cfg.friendApi?.anonymous_token || "").trim()
    const unifiedAnonSet = !!String(cfg.friendApi?.unifiedAnonymousToken || cfg.friendApi?.unified_anonymous_token || "").trim()
    const effectiveAnonSet = !!String(runtime.anonymousToken || "").trim()

    let health = "(未检查)"
    try {
      const res = await getFriendApiHealth({ timeoutMs: 1500 })
      health = res.ok ? "ok" : `fail:${res.message || ""}`
    } catch (err) {
      health = `fail:${err?.message || err}`
    }

    const modeLabel = runtime.mode === "unified" ? "统一后端" : "本地"

    const kv = [
      { k: "enable", v: runtime.enabled ? "true" : "false" },
      { k: "source", v: `${runtime.sourceSetting}（当前使用：${modeLabel}）` },
      { k: "当前 baseUrl", v: runtime.baseUrl ? runtime.baseUrl : "(未配置)" },
      { k: "本地 baseUrl", v: localUrl || "(未配置)" },
      { k: "统一后端 baseUrl", v: unifiedUrl || "(未配置)" },
      { k: "Bearer", v: `本地 ${localBearerSet ? "已配置" : "未配置"} | 统一 ${unifiedBearerSet ? "已配置" : "未配置"} | 当前 ${effectiveBearerSet ? "已配置" : "未配置"}` },
      { k: "API Key", v: `本地 ${localApiKeySet ? "已配置" : "未配置"} | 统一 ${unifiedApiKeySet ? "已配置" : "未配置"} | 当前 ${effectiveApiKeySet ? "已配置" : "未配置"}` },
      { k: "Framework", v: `本地 ${localFrameworkSet ? "已配置" : "未配置"} | 统一 ${unifiedFrameworkSet ? "已配置" : "未配置"} | 当前 ${effectiveFrameworkSet ? "已配置" : "未配置"}` },
      { k: "Anonymous", v: `本地 ${localAnonSet ? "已配置" : "未配置"} | 统一 ${unifiedAnonSet ? "已配置" : "未配置"} | 当前 ${effectiveAnonSet ? "已配置" : "未配置"}` },
      { k: "health", v: health },
    ]

    const notes = [
      "切换：#数据源切换 本地 / 统一后端 / 自动（仅 master）",
      "设置统一后端：#统一后端地址 <url> / #统一后端token <token>（建议私聊）",
      "（推荐）API Key：#统一后端apikey <key>（建议私聊，常见前缀 ef_）",
      "（可选）Framework Token：#统一后端frameworktoken <token>（建议私聊）",
      "（可选）匿名鉴权：#统一后端匿名token <token>（建议私聊）",
      "设置本地接口：#本地数据地址 <url> / #本地数据token <token>（建议私聊）",
    ]

    try {
      const t = new Date()
      const yyyy = t.getFullYear()
      const mm = String(t.getMonth() + 1).padStart(2, "0")
      const dd = String(t.getDate()).padStart(2, "0")
      const hh = String(t.getHours()).padStart(2, "0")
      const mi = String(t.getMinutes()).padStart(2, "0")
      const ss = String(t.getSeconds()).padStart(2, "0")

      const img = await renderImg(
        "enduid/info",
        {
          title: `${GAME_TITLE} 数据源`,
          subtitle: "角色面板数值/装备词条的来源（Friend API）",
          time: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`,
          kv,
          notes,
          imgType: "png",
          copyright: `${GAME_TITLE}zmd-plugin & yuyu-bot`,
        },
        { scale: 1, quality: 100 },
      )
      if (img) {
        await e.reply(img, true)
        return true
      }
    } catch (err) {
      logger.error(`${GAME_TITLE} 数据源图片渲染失败：${err?.message || err}`)
    }

    const lines = [
      `${GAME_TITLE} 角色数据来源（Friend API）`,
      `- enable: ${runtime.enabled ? "true" : "false"}`,
      `- source: ${runtime.sourceSetting}（当前使用：${modeLabel}）`,
      `- 当前 baseUrl: ${runtime.baseUrl ? runtime.baseUrl : "(未配置)"}`,
      `- 本地 baseUrl: ${localUrl || "(未配置)"}`,
      `- 统一后端 baseUrl: ${unifiedUrl || "(未配置)"}`,
      `- Bearer: 本地${localBearerSet ? "已配置" : "未配置"} 统一${unifiedBearerSet ? "已配置" : "未配置"} 当前${effectiveBearerSet ? "已配置" : "未配置"}`,
      `- API Key: 本地${localApiKeySet ? "已配置" : "未配置"} 统一${unifiedApiKeySet ? "已配置" : "未配置"} 当前${effectiveApiKeySet ? "已配置" : "未配置"}`,
      `- Framework: 本地${localFrameworkSet ? "已配置" : "未配置"} 统一${unifiedFrameworkSet ? "已配置" : "未配置"} 当前${effectiveFrameworkSet ? "已配置" : "未配置"}`,
      `- Anonymous: 本地${localAnonSet ? "已配置" : "未配置"} 统一${unifiedAnonSet ? "已配置" : "未配置"} 当前${effectiveAnonSet ? "已配置" : "未配置"}`,
      `- health: ${health}`,
      `- 切换：#数据源切换 本地 / 统一后端 / 自动（仅 master）`,
    ].join("\n")

    await e.reply(lines, true)
    return true
  }

  async dataSourceSwitch() {
    const e = this.e
    const msg = String(e.msg || "").trim()
    const arg = msg
      .replace(/^#?(?:终末地|zmd|ZMD)?\s*(?:数据源切换|切换数据源)\s*/i, "")
      .trim()

    const runtime = getFriendApiRuntimeConfig()
    const curMode = runtime.mode

    const normalizeArg = raw => String(raw || "").trim().toLowerCase()
    const a = normalizeArg(arg)

    let target = ""
    if (!a) {
      target = curMode === "local" ? "unified" : "local"
    } else if (a === "auto" || a.includes("自动")) {
      target = "auto"
    } else if (a === "local" || a.includes("本地")) {
      target = "local"
    } else if (a === "unified" || a.includes("统一") || a.includes("后端") || a.includes("backend") || a.includes("remote")) {
      target = "unified"
    }

    if (!target) {
      await e.reply(
        [
          `${GAME_TITLE} 用法：`,
          `- #数据源切换（在 本地 / 统一后端 间切换）`,
          `- #数据源切换 本地`,
          `- #数据源切换 统一后端`,
          `- #数据源切换 自动`,
        ].join("\n"),
        true,
      )
      return true
    }

    try {
      cfg.friendApi ??= {}
      cfg.friendApi.source = target
      await configSave?.()
    } catch (err) {
      await e.reply(`${GAME_TITLE} 数据源切换失败：${err?.message || err}`, true)
      return true
    }

    const next = getFriendApiRuntimeConfig()
    const nextLabel = next.mode === "unified" ? "统一后端" : "本地"
    const hint =
      next.mode === "unified" &&
      !String(next.bearer || "").trim() &&
      !String(next.apiKey || "").trim() &&
      !String(next.frameworkToken || "").trim() &&
      !String(next.anonymousToken || "").trim()
        ? "\n提示：统一后端可能需要鉴权，请先私聊设置：#统一后端apikey <key>（常见 ef_）或 #统一后端token <token> 或 #统一后端匿名token <token>"
        : ""
    await e.reply(
      `${GAME_TITLE} 已切换角色数据来源：${nextLabel}（source=${next.sourceSetting}）\n当前 baseUrl: ${next.baseUrl || "(未配置)"}${hint}`,
      true,
    )
    return true
  }

  async setUnifiedBackendUrl() {
    const e = this.e
    const msg = String(e.msg || "").trim()
    let url = msg.replace(/^#?(?:终末地|zmd|ZMD)?\s*(?:统一后端|后端)(?:地址|url|URL)\s*/i, "").trim()
    url = url.replace(/\s+$/g, "").replace(/\/+$/g, "")
    if (!url) {
      await e.reply(`${GAME_TITLE} 用法：#统一后端地址 <http(s)://...>`, true)
      return true
    }
    if (!/^https?:\/\//i.test(url)) {
      await e.reply(`${GAME_TITLE} 地址格式错误：请带上 http(s):// 前缀`, true)
      return true
    }
    try {
      cfg.friendApi ??= {}
      cfg.friendApi.unifiedBaseUrl = url
      await configSave?.()
    } catch (err) {
      await e.reply(`${GAME_TITLE} 设置失败：${err?.message || err}`, true)
      return true
    }

    await e.reply(
      [
        `${GAME_TITLE} 已设置统一后端地址：${url}`,
        `提示：统一后端默认会请求 /api/friend/*（若你填写的地址已以 /api 或 /api/friend 结尾则会自动兼容）`,
      ].join("\n"),
      true,
    )
    return true
  }

  async setUnifiedBackendToken() {
    const e = this.e
    if (!e.isPrivate) {
      await e.reply(`${GAME_TITLE} 为了安全，请私聊发送：#统一后端token <token>（支持 Bearer / ef_ / qr_）`, true)
      return true
    }
    const msg = String(e.msg || "").trim()
    const tokenRaw = msg
      .replace(/^#?(?:终末地|zmd|ZMD)?\s*(?:统一后端|后端)(?:token|Token|TOKEN|令牌|密钥|bearer|Bearer)\s*/i, "")
      .trim()

    const clear = /^(?:清空|重置|reset|none|null)$/i.test(tokenRaw)
    const token = clear ? "" : tokenRaw
    if (!clear && !token) {
      await replyPrivate(
        e,
        [
          `${GAME_TITLE} 用法：`,
          `- #统一后端token <token>（Bearer / ef_ / qr_）`,
          `- #统一后端token 清空`,
          `也可用：#统一后端apikey <key> / #统一后端frameworktoken <token>`,
        ].join("\n"),
      )
      return true
    }

    let kind = "bearer"
    let value = String(token || "").trim()
    const explicitBearer = /^bearer\s+/i.test(value)
    if (!clear && !explicitBearer) {
      if (/^ef_[0-9a-zA-Z]+$/.test(value)) kind = "apiKey"
      else if (/^qr_[0-9a-zA-Z]+$/.test(value)) kind = "framework"
    }

    try {
      cfg.friendApi ??= {}

      if (clear) {
        // Clear the common unified auth fields that users may have set via this command.
        cfg.friendApi.unifiedBearer = ""
        cfg.friendApi.unifiedApiKey = ""
        cfg.friendApi.unifiedFrameworkToken = ""
      } else if (kind === "apiKey") {
        cfg.friendApi.unifiedApiKey = value
      } else if (kind === "framework") {
        cfg.friendApi.unifiedFrameworkToken = value
      } else {
        cfg.friendApi.unifiedBearer = value
      }

      await configSave?.()
    } catch (err) {
      await replyPrivate(e, `${GAME_TITLE} 设置失败：${err?.message || err}`)
      return true
    }

    if (clear) {
      await replyPrivate(e, `${GAME_TITLE} 统一后端鉴权已清空（Bearer/APIKey/Framework）`)
      return true
    }

    const label = kind === "apiKey" ? "API Key" : kind === "framework" ? "Framework Token" : "Bearer"
    const hint =
      kind === "apiKey"
        ? "（将以 X-API-Key 发送）"
        : kind === "framework"
          ? "（将以 X-Framework-Token 发送）"
          : "（将以 Authorization: Bearer 发送）"
    await replyPrivate(e, `${GAME_TITLE} 统一后端 ${label} 已设置${hint}`)
    return true
  }

  async setUnifiedBackendApiKey() {
    const e = this.e
    if (!e.isPrivate) {
      await e.reply(`${GAME_TITLE} 为了安全，请私聊发送：#统一后端apikey <key>`, true)
      return true
    }

    const msg = String(e.msg || "").trim()
    const keyRaw = msg
      .replace(/^#?(?:终末地|zmd|ZMD)?\s*(?:统一后端|后端)(?:apikey|api_key|apiKey|APIKEY|API密钥|API秘钥)\s*/i, "")
      .trim()

    const clear = /^(?:清空|重置|reset|none|null)$/i.test(keyRaw)
    const key = clear ? "" : keyRaw
    if (!clear && !key) {
      await replyPrivate(e, `${GAME_TITLE} 用法：#统一后端apikey <key>（或：#统一后端apikey 清空）`)
      return true
    }

    try {
      cfg.friendApi ??= {}
      cfg.friendApi.unifiedApiKey = key
      await configSave?.()
    } catch (err) {
      await replyPrivate(e, `${GAME_TITLE} 设置失败：${err?.message || err}`)
      return true
    }

    await replyPrivate(e, `${GAME_TITLE} 统一后端 API Key ${clear ? "已清空" : "已设置"}`)
    return true
  }

  async setUnifiedBackendFrameworkToken() {
    const e = this.e
    if (!e.isPrivate) {
      await e.reply(`${GAME_TITLE} 为了安全，请私聊发送：#统一后端frameworktoken <token>`, true)
      return true
    }

    const msg = String(e.msg || "").trim()
    const tokenRaw = msg
      .replace(/^#?(?:终末地|zmd|ZMD)?\s*(?:统一后端|后端)(?:frameworktoken|framework_token|framework|框架token|框架令牌)\s*/i, "")
      .trim()

    const clear = /^(?:清空|重置|reset|none|null)$/i.test(tokenRaw)
    const token = clear ? "" : tokenRaw
    if (!clear && !token) {
      await replyPrivate(e, `${GAME_TITLE} 用法：#统一后端frameworktoken <token>（或：#统一后端frameworktoken 清空）`)
      return true
    }

    try {
      cfg.friendApi ??= {}
      cfg.friendApi.unifiedFrameworkToken = token
      await configSave?.()
    } catch (err) {
      await replyPrivate(e, `${GAME_TITLE} 设置失败：${err?.message || err}`)
      return true
    }

    await replyPrivate(e, `${GAME_TITLE} 统一后端 Framework Token ${clear ? "已清空" : "已设置"}`)
    return true
  }

  async setUnifiedBackendAnonymousToken() {
    const e = this.e
    if (!e.isPrivate) {
      await e.reply(`${GAME_TITLE} 为了安全，请私聊发送：#统一后端匿名token <token>`, true)
      return true
    }

    const msg = String(e.msg || "").trim()
    const tokenRaw = msg
      .replace(/^#?(?:终末地|zmd|ZMD)?\s*(?:统一后端|后端)(?:匿名token|匿名Token|匿名令牌|匿名密钥|anonymous|anon)\s*/i, "")
      .trim()

    const clear = /^(?:清空|重置|reset|none|null)$/i.test(tokenRaw)
    const token = clear ? "" : tokenRaw
    if (!clear && !token) {
      await replyPrivate(e, `${GAME_TITLE} 用法：#统一后端匿名token <token>（或：#统一后端匿名token 清空）`)
      return true
    }

    try {
      cfg.friendApi ??= {}
      cfg.friendApi.unifiedAnonymousToken = token
      await configSave?.()
    } catch (err) {
      await replyPrivate(e, `${GAME_TITLE} 设置失败：${err?.message || err}`)
      return true
    }

    await replyPrivate(e, `${GAME_TITLE} 统一后端匿名令牌 ${clear ? "已清空" : "已设置"}`)
    return true
  }

  async setLocalBackendUrl() {
    const e = this.e
    const msg = String(e.msg || "").trim()
    let url = msg.replace(/^#?(?:终末地|zmd|ZMD)?\s*(?:本地数据|本地后端)(?:地址|url|URL)\s*/i, "").trim()
    url = url.replace(/\s+$/g, "").replace(/\/+$/g, "")
    if (!url) {
      await e.reply(`${GAME_TITLE} 用法：#本地数据地址 <http(s)://...>`, true)
      return true
    }
    if (!/^https?:\/\//i.test(url)) {
      await e.reply(`${GAME_TITLE} 地址格式错误：请带上 http(s):// 前缀`, true)
      return true
    }

    try {
      cfg.friendApi ??= {}
      cfg.friendApi.baseUrl = url
      await configSave?.()
    } catch (err) {
      await e.reply(`${GAME_TITLE} 设置失败：${err?.message || err}`, true)
      return true
    }

    await e.reply(`${GAME_TITLE} 已设置本地 Friend API 地址：${url}`, true)
    return true
  }

  async setLocalBackendToken() {
    const e = this.e
    if (!e.isPrivate) {
      await e.reply(`${GAME_TITLE} 为了安全，请私聊发送：#本地数据token <token>`, true)
      return true
    }
    const msg = String(e.msg || "").trim()
    const tokenRaw = msg
      .replace(/^#?(?:终末地|zmd|ZMD)?\s*(?:本地数据|本地后端)(?:token|Token|TOKEN|令牌|密钥|bearer|Bearer)\s*/i, "")
      .trim()

    const clear = /^(?:清空|重置|reset|none|null)$/i.test(tokenRaw)
    const token = clear ? "" : tokenRaw
    if (!clear && !token) {
      await replyPrivate(e, `${GAME_TITLE} 用法：#本地数据token <token>（或：#本地数据token 清空）`)
      return true
    }

    try {
      cfg.friendApi ??= {}
      cfg.friendApi.bearer = token
      await configSave?.()
    } catch (err) {
      await replyPrivate(e, `${GAME_TITLE} 设置失败：${err?.message || err}`)
      return true
    }

    await replyPrivate(e, `${GAME_TITLE} 本地 Friend API Bearer ${clear ? "已清空" : "已设置"}`)
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
    let friendApiHealth = "(disabled)"
    const friendRuntime = getFriendApiRuntimeConfig()
    try {
      if (friendRuntime.enabled && friendRuntime.baseUrl) {
        const res = await getFriendApiHealth({ timeoutMs: 1500 })
        friendApiHealth = res.ok ? "ok" : `fail:${res.message || "unknown"}`
      }
    } catch (err) {
      friendApiHealth = `fail:${err?.message || err}`
    }

    const kv = [
      { k: "node.execPath", v: String(process.execPath || "") },
      { k: "node.version", v: String(process.version || "") },
      { k: "qrcode(dep)", v: String(qrcodeDep || "") },
      { k: "smsdk.smSdkPath", v: cfg.smsdk?.smSdkPath ? String(cfg.smsdk.smSdkPath) : "(未配置)" },
      { k: "smsdk(自动探测)", v: smsdkPath ? String(smsdkPath) : "(未找到)" },
      { k: "friendApi.enable", v: cfg.friendApi?.enable === false ? "false" : "true" },
      { k: "friendApi.source", v: `${friendRuntime.sourceSetting} (mode=${friendRuntime.mode})` },
      { k: "friendApi.localBaseUrl", v: friendRuntime.localBaseUrl ? friendRuntime.localBaseUrl : "(未配置)" },
      { k: "friendApi.unifiedBaseUrl", v: friendRuntime.unifiedBaseUrl ? friendRuntime.unifiedBaseUrl : "(未配置)" },
      { k: "friendApi.baseUrl(current)", v: friendRuntime.baseUrl ? friendRuntime.baseUrl : "(未配置)" },
      { k: "friendApi.health", v: String(friendApiHealth || "") },
    ]

    try {
      const t = new Date()
      const yyyy = t.getFullYear()
      const mm = String(t.getMonth() + 1).padStart(2, "0")
      const dd = String(t.getDate()).padStart(2, "0")
      const hh = String(t.getHours()).padStart(2, "0")
      const mi = String(t.getMinutes()).padStart(2, "0")
      const ss = String(t.getSeconds()).padStart(2, "0")

      const img = await renderImg(
        "enduid/info",
        {
          title: `${GAME_TITLE} 环境诊断`,
          subtitle: "用于排查渲染/依赖/数据源配置问题（可截图反馈）",
          time: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`,
          kv,
          imgType: "png",
          copyright: `${GAME_TITLE}zmd-plugin & yuyu-bot`,
        },
        { scale: 1, quality: 100 },
      )
      if (img) {
        await e.reply(img, true)
        return true
      }
    } catch (err) {
      logger.error(`${GAME_TITLE} 环境诊断图片渲染失败：${err?.message || err}`)
    }

    const lines = [
      `${GAME_TITLE} 环境诊断：`,
      `node.execPath: ${process.execPath}`,
      `node.version: ${process.version}`,
      `qrcode(dep): ${qrcodeDep}`,
      `smsdk.smSdkPath: ${cfg.smsdk?.smSdkPath ? cfg.smsdk.smSdkPath : "(未配置)"} `,
      `smsdk(自动探测): ${smsdkPath ? smsdkPath : "(未找到)"} `,
      `friendApi.enable: ${cfg.friendApi?.enable === false ? "false" : "true"}`,
      `friendApi.source: ${friendRuntime.sourceSetting} (mode=${friendRuntime.mode})`,
      `friendApi.localBaseUrl: ${friendRuntime.localBaseUrl ? friendRuntime.localBaseUrl : "(未配置)"}`,
      `friendApi.unifiedBaseUrl: ${friendRuntime.unifiedBaseUrl ? friendRuntime.unifiedBaseUrl : "(未配置)"}`,
      `friendApi.baseUrl(current): ${friendRuntime.baseUrl ? friendRuntime.baseUrl : "(未配置)"}`,
      `friendApi.health: ${friendApiHealth}`,
    ]
    await e.reply(lines.join("\n"), true)
    return true
  }

  async bind() {
    const e = this.e
    const p = cfg.cmd?.prefix || "#zmd"
    const text = normalizeText(e.msg.replace(/^#?(?:终末地|zmd)(?:绑定|bind)/i, ""))

    // UID-only binding (panel-only). Allowed in group/private.
    let uidOnly = String(text || "").trim()
    if (/^uid[=:]/i.test(uidOnly)) uidOnly = uidOnly.slice(4)
    uidOnly = uidOnly.replace(/^\+/, "")
    if (/^\d{5,13}$/.test(uidOnly)) {
      try {
        await upsertUidOnlyAccount(e.user_id, { uid: uidOnly })
      } catch (err) {
        await e.reply(`${GAME_TITLE} UID 绑定失败：${err?.message || err}`, true)
        return true
      }

      const friendHint = (() => {
        const rt = getFriendApiRuntimeConfig()
        if (!rt.enabled || !rt.baseUrl) return "\n提示：未配置角色数据接口，面板查询可能不可用"
        if (rt.mode === "unified" && !String(rt.bearer || "").trim()) return "\n提示：统一后端未设置 Bearer，面板查询可能不可用"
        return ""
      })()
      await e.reply(`${GAME_TITLE} UID 绑定成功（仅面板）\nUID: ${uidOnly}${friendHint}`, true)
      return true
    }

    // cred/token binding must be private.
    if (!e.isPrivate) {
      await e.reply(
        `${GAME_TITLE} 为了安全，请私聊发送：${p}绑定<cred|token>\n也可直接绑定 UID：${p}绑定<UID>（仅面板）`,
        true,
      )
      return true
    }

    const { kind, value } = parseCredential(text)

    if (!kind) {
      await replyPrivate(e, `${GAME_TITLE} 参数格式错误：请发送 32 位 cred 或 24 位 token（或直接绑定 UID：${p}绑定<UID>）`)
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
    const groupQrLogin = Boolean(e.isGroup && isGroupQrLoginEnabled())
    const replyLogin = (msg, quote = false) => (groupQrLogin ? e.reply(msg, quote) : replyPrivate(e, msg))

    if (!e.isPrivate && !groupQrLogin) {
      await e.reply(`${GAME_TITLE} 为了安全，请私聊使用：${cfg.cmd?.prefix || "#zmd"}登录`, true)
      return true
    }

    let scanId = ""
    let scanUrl = ""
    try {
      const scan = await getScanId(e.user_id)
      scanId = typeof scan?.scanId === "string" ? scan.scanId.trim() : ""
      scanUrl = typeof scan?.scanUrl === "string" ? scan.scanUrl.trim() : ""
    } catch (err) {
      const msg = logThrowable("获取二维码参数失败", err)
      await replyLogin(`${GAME_TITLE} 获取二维码失败：${msg}`)
      return true
    }
    if (!scanId || looksLikeObjectString(scanId)) {
      const msg = `扫码接口返回 scanId 异常：${scanId || "empty"}`
      logger.error(`${GAME_TITLE} ${msg}`)
      await replyLogin(`${GAME_TITLE} 获取二维码失败：${msg}`)
      return true
    }
    if (looksLikeObjectString(scanUrl)) {
      const msg = `扫码接口返回 scanUrl 异常：${scanUrl}`
      logger.error(`${GAME_TITLE} ${msg}`)
      await replyLogin(`${GAME_TITLE} 获取二维码失败：${msg}`)
      return true
    }

    scanUrl = scanUrl || `hypergryph://scan_login?scanId=${encodeURIComponent(scanId)}`

    let qrPath = ""
    try {
      qrPath = await makeQrPng(scanUrl)
      await replyLogin(
        [
          `${GAME_TITLE} 请使用森空岛 App 扫码登录（二维码有效期约 1 分钟）`,
          segment.image(qrPath),
        ],
      )
    } catch (err) {
      const msg = logThrowable("生成二维码失败", err)
      await replyLogin(`${GAME_TITLE} 生成二维码失败：${msg}\n你也可以改用：${cfg.cmd?.prefix || "#zmd"}绑定 <cred>`)
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
      const msg = logThrowable("扫码状态查询失败", err)
      await replyLogin(`${GAME_TITLE} 扫码状态查询失败：${msg}`)
      return true
    }

    if (!scanCode) {
      await replyLogin(`${GAME_TITLE} 二维码已超时，请重新获取并扫码`)
      return true
    }

    let token = ""
    let deviceToken = ""
    try {
      const tokenRes = await getTokenByScanCode(scanCode, e.user_id)
      token = typeof tokenRes === "string" ? tokenRes : String(tokenRes?.token || "")
      if (tokenRes && typeof tokenRes === "object") deviceToken = String(tokenRes.deviceToken || "")
    } catch (err) {
      const msg = logThrowable("获取 token 失败", err)
      await replyLogin(`${GAME_TITLE} 获取 token 失败：${msg}`)
      return true
    }
    if (!token) {
      await replyLogin(`${GAME_TITLE} 获取 token 失败，请重试`)
      return true
    }

    let info
    try {
      info = await getCredInfoByToken(token, { userId: e.user_id })
    } catch (err) {
      const msg = logThrowable("获取 cred 失败", err)
      await replyLogin(`${GAME_TITLE} 获取 cred 失败：${msg}`)
      return true
    }
    if (info?.error === "405") {
      await replyLogin(`${GAME_TITLE} 当前服务无法使用 token 登录，请尝试使用 cred`)
      return true
    }
    if (info?.error) {
      const detail = String(info.message || info.error || "未知错误")
      logger.error(`${GAME_TITLE} 获取 cred 失败：${detail}`)
      await replyLogin(`${GAME_TITLE} 获取 cred 失败：${detail}`)
      return true
    }
    if (!info?.cred) {
      await replyLogin(`${GAME_TITLE} 获取 cred 失败，请重试`)
      return true
    }

    const bindRes = await bindByCred(info.cred, e.user_id, { usedToken: token, sklandUserId: info.sklandUserId, deviceToken })
    await replyLogin(bindRes.message)

    if (bindRes.ok && cfg.gacha?.autoSyncAfterLogin) {
      setTimeout(async () => {
        try {
          const res = await updateGachaLogsForUser(e.user_id)
          if (!res?.ok) return
          const added = (Number(res.newCharCount) || 0) + (Number(res.newWeaponCount) || 0)
          if (added <= 0) return

          await replyLogin(
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

  async setGroupQrLogin() {
    const e = this.e
    const message = String(e.msg || "").trim()
    let action = message
      .replace(/^#?(?:终末地|zmd)群聊扫码登录\s*/i, "")
      .trim()
    if (action === message) {
      action = message.replace(/^#?(?:终末地|zmd)(开启|关闭)群聊扫码登录$/i, "$1").trim()
    }

    if (!action) {
      await e.reply(
        `${GAME_TITLE} 群聊扫码登录当前${isGroupQrLoginEnabled() ? "已开启" : "已关闭"}\n用法：${cfg.cmd?.prefix || "#zmd"}群聊扫码登录 开启/关闭`,
        true,
      )
      return true
    }

    const enabled = /^(?:开启|on)$/i.test(action)
    const disabled = /^(?:关闭|off)$/i.test(action)
    if (!enabled && !disabled) {
      await e.reply(`${GAME_TITLE} 用法：${cfg.cmd?.prefix || "#zmd"}群聊扫码登录 开启/关闭`, true)
      return true
    }

    cfg.security ??= {}
    cfg.security.allowQrLoginInGroup = enabled
    await configSave?.()
    await e.reply(`${GAME_TITLE} 群聊扫码登录已${enabled ? "开启" : "关闭"}`, true)
    return true
  }

  async list() {
    const e = this.e
    const data = await getUserData(e.user_id)
    if (!data.accounts.length) {
      const p = cfg.cmd?.prefix || "#zmd"
      await e.reply(`${GAME_TITLE} 还没有绑定账号\n- 私聊：${p}绑定<cred|token>\n- 仅面板：${p}绑定<UID>`, true)
      return true
    }
    const lines = data.accounts.map((a, idx) => {
      const activeMark = idx === Number(data.active || 0) ? "（当前）" : ""
      const panelOnly = a.uidOnly ? "（仅面板）" : ""
      return `${idx + 1}. ${a.nickname || "未命名"} UID:${a.uid || "-"} S:${a.serverId || "1"} ${panelOnly}${activeMark}`.trim()
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
    await e.reply(`${GAME_TITLE} 已切换：${a.nickname || "未命名"} UID:${a.uid}${a.uidOnly ? "（仅面板）" : ""}`, true)
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
    if (!account?.uid) {
      await e.reply(`${GAME_TITLE} 未绑定账号，请先私聊：${cfg.cmd?.prefix || "#zmd"}绑定<cred|token>`, true)
      return true
    }
    if (!account?.cred) {
      if (account?.uidOnly) {
        await e.reply(`${GAME_TITLE} 当前账号仅绑定UID（仅面板），不支持签到`, true)
        return true
      }
      await e.reply(`${GAME_TITLE} 未绑定账号，请先私聊：${cfg.cmd?.prefix || "#zmd"}绑定<cred|token>`, true)
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

    if (isAlreadySigned(res)) {
      await e.reply(`${GAME_TITLE} ☑️ [${account.nickname || account.uid}] ${res?.data?.message || "今日已签到"}`, true)
      return true
    }

    if (res.code === 0) {
      await recordSuccess(1)
      await e.reply(`${GAME_TITLE} ✅ [${account.nickname || account.uid}] 签到完成\n${formatAwards(res)}`, true)
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
      let skip = 0
      const resultsAll = []

      async function runOne(userId) {
        const { account } = await getActiveAccount(userId)
        if (!account) {
          return {
            status: "skip",
            uid: "-",
            name: "未绑定",
            msg: "未绑定",
            text: "⏭️ 未绑定",
          }
        }

        const name = String(account.nickname || account.uid || "未命名")
        const uidText = account.uid ? String(account.uid) : "-"
        const label = `UID:${uidText} ${name}`

        if (!account?.cred || !account?.uid) {
          const msg = account?.uidOnly ? "仅UID绑定（不支持签到）" : "数据不完整"
          return {
            status: "skip",
            uid: uidText,
            name,
            msg,
            text: `⏭️ ${msg} ${label}`,
          }
        }

        try {
          const res = await attendance(account.cred, account.uid)
          if (!res) {
            await recordFail(1)
            return {
              status: "fail",
              uid: uidText,
              name,
              msg: "请求失败",
              text: `❌ ${label} 请求失败`,
            }
          }
          if (isAlreadySigned(res)) {
            return {
              status: "signed",
              uid: uidText,
              name,
              msg: String(res?.data?.message || "今日已签到"),
              text: `☑️ 已签 ${label}`,
            }
          }
          if (res.code === 0) {
            await recordSuccess(1)
            return {
              status: "success",
              uid: uidText,
              name,
              msg: "签到完成",
              text: `✅ ${label}`,
            }
          }

          await recordFail(1)
          const errMsg = String(res.message || res.code || "失败")
          return {
            status: "fail",
            uid: uidText,
            name,
            msg: errMsg,
            text: `❌ ${label} ${errMsg}`,
          }
        } catch (err) {
          await recordFail(1)
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

      for (let i = 0; i < users.length; i += concurrency) {
        const batch = users.slice(i, i + concurrency).map(String)
        const results = await Promise.all(batch.map(u => runOne(u)))
        for (const r of results) {
          if (r.status === "success") success++
          else if (r.status === "signed") signed++
          else if (r.status === "fail") fail++
          else if (r.status === "skip") skip++
          resultsAll.push(r)
        }
        if (i + concurrency < users.length && maxInterval > 0) {
          const waitSec =
            minInterval === maxInterval ? minInterval : minInterval + Math.random() * (maxInterval - minInterval)
          await sleep(waitSec * 1000)
        }
      }

      const maxLines = 40
      const shown = resultsAll.slice(0, maxLines)
      const remain = Math.max(0, resultsAll.length - shown.length)

      try {
        const t = new Date()
        const yyyy = t.getFullYear()
        const mm = String(t.getMonth() + 1).padStart(2, "0")
        const dd = String(t.getDate()).padStart(2, "0")
        const hh = String(t.getHours()).padStart(2, "0")
        const mi = String(t.getMinutes()).padStart(2, "0")
        const ss = String(t.getSeconds()).padStart(2, "0")

        const img = await renderImg(
          "enduid/all_sign",
          {
            title: `${GAME_TITLE} 全部签到`,
            subtitle: "终末地账号批处理执行回执",
            time: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`,
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
          { scale: 1, quality: 100 },
        )
        if (img) {
          await e.reply(img, true)
          return true
        }
      } catch (err) {
        logger.error(`${GAME_TITLE} 全部签到图片渲染失败：${err?.message || err}`)
      }

      const body = remain > 0 ? `${shown.map(r => r.text).join("\n")}\n... 还有 ${remain} 条` : shown.map(r => r.text).join("\n")
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
        { scale: 1.2, quality: 100 },
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
    const { account } = await getActiveAccount(e.user_id)
    if (!account?.uid) {
      await e.reply(`${GAME_TITLE} 还没有绑定账号，无法开启`, true)
      return true
    }
    if (!account?.cred) {
      if (account?.uidOnly) {
        await e.reply(`${GAME_TITLE} 当前账号仅绑定UID（仅面板），无法开启自动签到`, true)
        return true
      }
      await e.reply(`${GAME_TITLE} 还没有绑定账号，无法开启`, true)
      return true
    }

    await setAutoSign(e.user_id, true)
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
