import path from "node:path"
import { fileURLToPath } from "node:url"

// Stable plugin identifier used for config/temp naming.
export const PLUGIN_ID = "zmd-plugin"

// Legacy config name used by older versions.
export const LEGACY_CONFIG_ID = "enduid-yunzai"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Absolute path to this plugin's root directory.
export const PLUGIN_ROOT = path.resolve(__dirname, "..")

// Directory name under TRSS-Yunzai's ./plugins/ (may be renamed by users).
export const PLUGIN_DIRNAME = path.basename(PLUGIN_ROOT)

export const PLUGIN_RESOURCES_DIR = path.join(PLUGIN_ROOT, "resources")
export const PLUGIN_DATA_DIR = path.join(PLUGIN_ROOT, "data")

// Used inside renderer templates (temp/html/<plugin>/<app>/<tpl>/...).
export function pluginResourcesRelPath(rel = "") {
  const s = String(rel || "").replace(/^\/+/, "")
  return `../../../../../plugins/${PLUGIN_DIRNAME}/resources/${s}`
}
