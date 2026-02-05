/**
 * 账号辅助工具。
 *
 * 这类函数用于“补全/缓存”账号信息（例如获取 sklandUserId 并写回 Redis），
 * 以减少重复网络请求。
 */
import { upsertAccount } from "./store.js"
import { getUserInfo } from "./skland/client.js"

export async function ensureSklandUserId(cred, account, userId) {
  if (account?.sklandUserId) return String(account.sklandUserId)
  const info = await getUserInfo(cred)
  const id = info?.data?.user?.id
  if (!id) return ""
  account.sklandUserId = String(id)
  await upsertAccount(userId, account)
  return String(account.sklandUserId)
}
