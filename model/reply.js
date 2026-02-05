/**
 * 临时会话回复修复。
 *
 * OneBotv11 的私聊临时会话（sub_type=group）可能携带 group_id，
 * 某些 TRSS 适配器会把 e.reply() 错路由到群聊。
 *
 * patchTempSessionReply() 会重写 e.reply，使其强制走私聊发送。
 */
function isTempSession(e) {
  return Boolean(e && e.message_type === "private" && e.group_id)
}

async function sendPrivateMsg(e, msg) {
  if (!e || !msg) return false

  if (e.friend?.sendMsg) return await e.friend.sendMsg(msg)
  if (Bot?.pickUser && e.user_id) return await Bot.pickUser(e.user_id).sendMsg(msg)
  if (Bot?.sendFriendMsg && e.self_id && e.user_id) return await Bot.sendFriendMsg(e.self_id, e.user_id, msg)
  return false
}

export function patchTempSessionReply(e) {
  if (!e || e.__enduid_temp_reply_patched) return
  if (!isTempSession(e)) return
  e.__enduid_temp_reply_patched = true

  e.reply = async (msg = "", quote = false, data = {}) => {
    if (!msg) return false

    let { recallMsg = 0, at = "" } = data || {}

    const seg = global.segment

    if (at && seg?.at) {
      if (at === true) at = e.user_id
      if (Array.isArray(msg)) msg.unshift(seg.at(at), "\n")
      else msg = [seg.at(at), "\n", msg]
    }

    if (quote && e.message_id && seg?.reply) {
      if (Array.isArray(msg)) msg.unshift(seg.reply(e.message_id))
      else msg = [seg.reply(e.message_id), msg]
    }

    let res
    try {
      res = await sendPrivateMsg(e, msg)
    } catch (err) {
      Bot.makeLog("error", ["发送消息错误", msg, err], e?.self_id)
      res = { error: [err] }
    }

    if (recallMsg > 0 && res?.message_id) {
      if (e.friend?.recallMsg)
        setTimeout(() => {
          e.friend.recallMsg(res.message_id)
          if (e.message_id) e.friend.recallMsg(e.message_id)
        }, recallMsg * 1000)
    }

    return res
  }
}
