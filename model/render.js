import path from "node:path"

import puppeteer from "../../../lib/puppeteer/puppeteer.js"

const PLUGIN_NAME = "enduid-yunzai"

function scaleAttr(pct = 1) {
  const n = Number(pct)
  const scale = Number.isFinite(n) ? n : 1
  const clamped = Math.min(2, Math.max(0.5, scale))
  return `style="transform:scale(${clamped});transform-origin:0 0;"`
}

export async function render(tplPath, params = {}, { scale = 1, quality = 100 } = {}) {
  const [app, tpl] = String(tplPath || "").split("/")
  if (!app || !tpl) throw new Error(`Invalid tplPath: ${tplPath}`)

  const layoutDir = path.join(process.cwd(), "plugins", PLUGIN_NAME, "resources", "common", "layout")
  const defaultLayout = path.join(layoutDir, "default.html")
  const miaoLayout = path.join(layoutDir, "miao.html")
  // name = `${PLUGIN_NAME}/${app}/${tpl}` -> temp/html/<plugin>/<app>/<tpl>/... (5层目录)
  const resPath = `../../../../../plugins/${PLUGIN_NAME}/resources/`

  const imgType = String(params.imgType || "").trim()

  const data = {
    ...params,
    _plugin: PLUGIN_NAME,
    saveId: params.saveId || params.save_id || tpl,
    tplFile: `./plugins/${PLUGIN_NAME}/resources/${app}/${tpl}.html`,
    _res_path: resPath,
    defaultLayout,
    miaoLayout,
    pageGotoParams: {
      waitUntil: "networkidle0",
    },
    sys: {
      scale: scaleAttr(scale),
      copyright: params.copyright || `Created By EndUID-Yunzai`,
    },
    quality,
    imgType: imgType || undefined,
  }

  return await puppeteer.screenshot(`${PLUGIN_NAME}/${app}/${tpl}`, data)
}
