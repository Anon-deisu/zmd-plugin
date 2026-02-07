/**
 * HTML 模板渲染器。
 *
 * 封装 TRSS-Yunzai 的 puppeteer 截图渲染：
 * - 解析模板/布局的绝对路径
 * - 注入 `_res_path` 供模板引用插件 resources 静态资源
 */
import path from "node:path"

import puppeteer from "../../../lib/puppeteer/puppeteer.js"

import { PLUGIN_ID, PLUGIN_RESOURCES_DIR, pluginResourcesRelPath } from "./pluginMeta.js"
import { pickRandomSideBackgroundRel } from "./sideBackground.js"

function scaleAttr(pct = 1) {
  const n = Number(pct)
  const scale = Number.isFinite(n) ? n : 1
  const clamped = Math.min(2, Math.max(0.5, scale))
  return `style="transform:scale(${clamped});transform-origin:0 0;"`
}

export async function render(tplPath, params = {}, { scale = 1, quality = 100 } = {}) {
  const [app, tpl] = String(tplPath || "").split("/")
  if (!app || !tpl) throw new Error(`Invalid tplPath: ${tplPath}`)

  const layoutDir = path.join(PLUGIN_RESOURCES_DIR, "common", "layout")
  const defaultLayout = path.join(layoutDir, "default.html")
  const skinLayout = path.join(layoutDir, "skin.html")
  // name = `${PLUGIN_ID}/${app}/${tpl}` -> temp/html/<plugin>/<app>/<tpl>/...（用于组织渲染缓存目录）
  // `_res_path` 在模板中作为“相对资源前缀”：从 temp/html/... 回退到 plugins/<dir>/resources/。
  const resPath = pluginResourcesRelPath("")

  const imgType = String(params.imgType || "").trim()
  const bgImage = pickRandomSideBackgroundRel()

  const data = {
    ...params,
    bgImage,
    _plugin: PLUGIN_ID,
    saveId: params.saveId || params.save_id || tpl,
    // 绝对文件路径：puppeteer 渲染器会读取该模板文件。
    tplFile: path.join(PLUGIN_RESOURCES_DIR, app, `${tpl}.html`),
    _res_path: resPath,
    defaultLayout,
    skinLayout,
    pageGotoParams: {
      waitUntil: "networkidle0",
    },
    sys: {
      scale: scaleAttr(scale),
      copyright: params.copyright || `Created By ${PLUGIN_ID}`,
    },
    quality,
    imgType: imgType || undefined,
  }

  return await puppeteer.screenshot(`${PLUGIN_ID}/${app}/${tpl}`, data)
}
