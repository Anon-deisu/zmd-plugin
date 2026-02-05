/**
 * 插件元信息与路径工具。
 *
 * 统一维护插件标识（用于 config/temp 命名空间），并提供基于插件根目录的
 * 资源/数据路径，避免写死 plugins/<目录名>。
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

// 稳定插件标识：用于配置文件名、temp 目录名等。
export const PLUGIN_ID = "zmd-plugin"

// 旧版配置名：用于迁移/兼容。
export const LEGACY_CONFIG_ID = "enduid-yunzai"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 插件根目录的绝对路径。
export const PLUGIN_ROOT = path.resolve(__dirname, "..")

// TRSS-Yunzai 的 ./plugins/ 下的目录名（用户可能会改名）。
export const PLUGIN_DIRNAME = path.basename(PLUGIN_ROOT)

export const PLUGIN_RESOURCES_DIR = path.join(PLUGIN_ROOT, "resources")
export const PLUGIN_DATA_DIR = path.join(PLUGIN_ROOT, "data")

// 渲染模板中使用的资源相对路径（从 temp/html/<plugin>/<app>/<tpl>/... 回退到 plugins/<dir>/resources/）。
export function pluginResourcesRelPath(rel = "") {
  const s = String(rel || "").replace(/^\/+/, "")
  return `../../../../../plugins/${PLUGIN_DIRNAME}/resources/${s}`
}
