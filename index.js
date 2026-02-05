import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appsDir = path.join(__dirname, "apps")

const files = fs.readdirSync(appsDir).filter(file => file.endsWith(".js") && file !== "strategy.js")

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
