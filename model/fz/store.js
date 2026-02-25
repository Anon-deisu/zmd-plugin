/**
 * 明日方舟（#fz）模块的 Redis 存储。
 *
 * 与终末地（#zmd）的自动签到集合分开，避免互相影响。
 */

const KEY_FZ_AUTOSIGN_USERS = "Yz:EndUID:FzAutoSignUsers"

export async function setFzAutoSign(userId, enabled) {
  const id = String(userId ?? "").trim()
  if (!id) throw new Error("missing userId")

  if (enabled) await redis.sAdd(KEY_FZ_AUTOSIGN_USERS, id)
  else await redis.sRem(KEY_FZ_AUTOSIGN_USERS, id)

  return { ok: true }
}

export async function listFzAutoSignUsers() {
  try {
    return (await redis.sMembers(KEY_FZ_AUTOSIGN_USERS)) || []
  } catch {
    return []
  }
}
