import { spawnSync } from "node:child_process"

function extractLeadingEmoji(message) {
  const s = String(message || "").trim()
  if (!s) return { emoji: "", text: "" }
  const m = s.match(/^((?:\p{Extended_Pictographic}\uFE0F?){1,4})\s*(.*)$/u)
  if (!m) return { emoji: "", text: s }
  return { emoji: m[1] || "", text: (m[2] || "").trim() }
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
      const { emoji, text } = extractLeadingEmoji(line)
      if (!emoji) continue
      let t = text.replaceAll("`", "")
      if (t.includes(")")) t = `${t.split(")")[0]})`
      out.push({ emoji, text: t })
      if (out.length >= maxItems) break
    }
  } catch {}
  return out
}

