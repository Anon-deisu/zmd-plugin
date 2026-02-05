import path from "node:path"

import puppeteer from "../../../lib/puppeteer/puppeteer.js"

import { PLUGIN_ID, PLUGIN_RESOURCES_DIR, pluginResourcesRelPath } from "./pluginMeta.js"

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
  // name = `${PLUGIN_ID}/${app}/${tpl}` -> temp/html/<plugin>/<app>/<tpl>/... (5层目录)
  const resPath = pluginResourcesRelPath("")

  const imgType = String(params.imgType || "").trim()

  const data = {
    ...params,
    _plugin: PLUGIN_ID,
    saveId: params.saveId || params.save_id || tpl,
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
