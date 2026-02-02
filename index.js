import fs from "node:fs"

const files = fs
  .readdirSync("./plugins/enduid-yunzai/apps")
  .filter(file => file.endsWith(".js") && file !== "strategy.js")

let ret = []
files.forEach(file => ret.push(import(`./apps/${file}`)))
ret = await Promise.allSettled(ret)

let apps = {}
for (let i in files) {
  const name = files[i].replace(".js", "")
  if (ret[i].status !== "fulfilled") {
    logger.error(`载入插件错误：${logger.red(`enduid-yunzai/${name}`)}`)
    logger.error(ret[i].reason)
    continue
  }
  apps[name] = ret[i].value[Object.keys(ret[i].value)[0]]
}

export { apps }
