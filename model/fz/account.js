/**
 * 明日方舟（#fz）账号解析：
 * - 复用 #zmd 绑定的 Skland cred/token
 * - 通过 Skland binding 接口提取“明日方舟”的默认 UID 与昵称
 */

import { getActiveAccount } from "../store.js"
import { getBinding } from "../skland/client.js"

const GAME_TITLE = "[明日方舟]"

function pickFirst(list) {
  return Array.isArray(list) && list.length ? list[0] : null
}

export async function getFzAccountForUser(userId) {
  const { account } = await getActiveAccount(userId)
  if (!account) {
    return { ok: false, message: `${GAME_TITLE} 未绑定森空岛账号，请先私聊 #zmd登录 / #zmd绑定` }
  }
  if (!account.cred) {
    if (account.uidOnly) {
      return { ok: false, message: `${GAME_TITLE} 当前账号仅绑定UID（仅面板），不支持签到/抽卡记录` }
    }
    return { ok: false, message: `${GAME_TITLE} 未绑定森空岛账号，请先私聊 #zmd登录 / #zmd绑定` }
  }

  let binding
  try {
    binding = await getBinding(account.cred)
  } catch (err) {
    return { ok: false, message: `${GAME_TITLE} 获取绑定信息失败：${err?.message || err}` }
  }
  if (!binding || binding.code !== 0) {
    return { ok: false, message: `${GAME_TITLE} 获取绑定信息失败：请检查 cred 是否有效` }
  }

  const list = Array.isArray(binding?.data?.list) ? binding.data.list : []
  const item = list.find(it => String(it?.appCode || "") === "arknights") || null
  if (!item) {
    return { ok: false, message: `${GAME_TITLE} 未找到明日方舟账号绑定信息（请确认已在森空岛绑定明日方舟）` }
  }

  const bindList = Array.isArray(item?.bindingList) ? item.bindingList : []
  const firstBind = pickFirst(bindList)

  const akUidRaw = item?.defaultUid ?? item?.default_uid ?? firstBind?.uid ?? item?.uid
  const akUid = akUidRaw != null ? String(akUidRaw).trim() : ""

  const nickname = String(firstBind?.nickName || firstBind?.nickname || item?.nickName || item?.nickname || "博士").trim()
  const channelName = String(firstBind?.channelName || item?.channelName || "").trim()

  if (!akUid) {
    return { ok: false, message: `${GAME_TITLE} 绑定信息缺少 UID，建议私聊 #zmd登录 重新绑定` }
  }

  return {
    ok: true,
    cred: String(account.cred),
    token: String(account.token || ""),
    deviceToken: String(account.deviceToken || ""),
    akUid,
    nickname,
    channelName,
  }
}
