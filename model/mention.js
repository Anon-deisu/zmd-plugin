function normalizeId(value) {
  const v = value == null ? "" : String(value).trim()
  return v
}

function isValidMentionId(id, selfId) {
  const v = normalizeId(id)
  if (!v) return false
  if (v === "all") return false
  if (selfId && v === selfId) return false
  return true
}

/**
 * 从消息中提取被 @ 的用户ID（忽略 @全体 与 @机器人本身）。
 * @returns {string|null}
 */
export function extractMentionUserId(e) {
  const selfId = normalizeId(e?.self_id)

  const direct = normalizeId(e?.at)
  if (isValidMentionId(direct, selfId)) return direct

  const message = Array.isArray(e?.message) ? e.message : []
  for (const seg of message) {
    if (!seg || seg.type !== "at") continue
    const qq = seg.qq ?? seg.user_id ?? seg.id
    if (isValidMentionId(qq, selfId)) return normalizeId(qq)
  }

  const msg = normalizeId(e?.msg)
  if (msg) {
    const cqAt = msg.match(/\[CQ:at,qq=(\d+)\]/i)
    if (cqAt?.[1] && isValidMentionId(cqAt[1], selfId)) return cqAt[1]

    const obAt = msg.match(/<at\s+qq=["']?(\d+)["']?\s*\/?>/i)
    if (obAt?.[1] && isValidMentionId(obAt[1], selfId)) return obAt[1]

    const atNum = msg.match(/@(\d{5,})\b/)
    if (atNum?.[1] && isValidMentionId(atNum[1], selfId)) return atNum[1]
  }

  return null
}

/**
 * 获取本次查询应使用的 user_id：优先取被 @ 的用户，否则取发送者。
 */
export function getQueryUserId(e) {
  const mentioned = extractMentionUserId(e)
  if (mentioned) {
    const n = Number(mentioned)
    return Number.isFinite(n) ? n : mentioned
  }
  return e?.user_id
}

/**
 * 将消息拼为纯文本（默认会丢弃 @ 段，避免干扰参数解析）。
 */
export function getMessageText(e, { stripAt = true } = {}) {
  const message = Array.isArray(e?.message) ? e.message : null
  if (!message) return normalizeId(e?.msg)

  const parts = []
  for (const seg of message) {
    if (!seg) continue
    if (stripAt && seg.type === "at") continue
    if (seg.type === "text" && seg.text != null) parts.push(String(seg.text))
  }
  const text = parts.join("")
  return text ? text : normalizeId(e?.msg)
}

