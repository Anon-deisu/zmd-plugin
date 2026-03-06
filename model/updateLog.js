/**
 * 更新日志提取器。
 *
 * 读取 `git log` 的提交标题，仅保留以 emoji 开头的条目，
 * 生成用于 `apps/status.js` 展示的简短更新列表。
 */
import { spawnSync } from "node:child_process"

function extractLeadingEmoji(message) {
  const s = String(message || "").trim()
  if (!s) return { emoji: "", text: "" }
  const m = s.match(/^((?:\p{Extended_Pictographic}\uFE0F?){1,4})\s*(.*)$/u)
  if (!m) return { emoji: "", text: s }
  return { emoji: m[1] || "", text: (m[2] || "").trim() }
}

function extractConventionalCommit(message) {
  const s = String(message || "").trim()
  if (!s) return { emoji: "", text: "" }

  const m = s.match(/^([a-z]+)(\([^)]+\))?(!)?:\s*(.+)$/i)
  if (!m) return { emoji: "", text: "" }

  const type = String(m[1] || "").toLowerCase()
  const scope = String(m[2] || "")
  const bang = String(m[3] || "")
  const subject = String(m[4] || "").trim()
  const emojiMap = {
    feat: "✨",
    fix: "🐛",
    refactor: "♻️",
    perf: "⚡",
    docs: "📝",
    style: "🎨",
    test: "✅",
    chore: "🔧",
    ci: "🤖",
    build: "📦",
    revert: "⏪",
  }
  const emoji = emojiMap[type] || ""
  if (!emoji || !subject) return { emoji: "", text: "" }

  return {
    emoji,
    text: `${type}${scope}${bang}: ${subject}`,
  }
}

export function getUpdateLogs({ cwd, maxItems = 18, maxGit = 100 } = {}) {
  const out = []
  try {
    const r = spawnSync("git", ["log", `--pretty=format:%s`, `-${Number(maxGit) || 100}`], {
      cwd,
      encoding: "utf-8",
      windowsHide: true,
    })
    if (r.status !== 0) return out
    const lines = String(r.stdout || "")
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
    for (const line of lines) {
      const emojiItem = extractLeadingEmoji(line)
      const conventionalItem = emojiItem.emoji ? { emoji: "", text: "" } : extractConventionalCommit(line)
      const { emoji, text } = emojiItem.emoji ? emojiItem : conventionalItem
      if (!emoji) continue
      let t = text.replaceAll("`", "")
      if (t.length > 96) t = `${t.slice(0, 95)}…`
      out.push({ emoji, text: t })
      if (out.length >= maxItems) break
    }
  } catch {}
  return out
}
