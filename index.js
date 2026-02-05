/**
 * 插件加载入口。
 *
 * TRSS-Yunzai 通过 `export { apps }` 获取插件模块列表。
 * 这里按“当前文件所在目录”的 `apps/` 扫描并动态 import，避免把
 * `plugins/<目录名>` 写死导致插件目录改名后无法加载。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appsDir = path.join(__dirname, "apps")

// `strategy.js` 体积较大/包含更多 IO，这里刻意不纳入自动加载。
const files = fs.readdirSync(appsDir).filter(file => file.endsWith(".js") && file !== "strategy.js")

// 逐个动态导入：某个 app 报错时不影响其它模块加载。
let ret = []
files.forEach(file => ret.push(import(`./apps/${file}`)))
ret = await Promise.allSettled(ret)

let apps = {}
for (let i in files) {
  const name = files[i].replace(".js", "")
  if (ret[i].status !== "fulfilled") {
    logger.error(`载入插件错误：${logger.red(`zmd-plugin/${name}`)}`)
    logger.error(ret[i].reason)
    continue
  }
  apps[name] = ret[i].value[Object.keys(ret[i].value)[0]]
}

export { apps }
