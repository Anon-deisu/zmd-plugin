import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test, { before, after, mock } from "node:test"
import template from "art-template"
import puppeteer from "puppeteer"

mock.module("../../../lib/puppeteer/puppeteer.js", {
  defaultExport: { screenshot: async (_id, data) => data },
})
mock.module("../model/sideBackground.js", {
  namedExports: {
    pickRandomSideBackgroundRel: () => "",
    listSideBackgroundFiles: () => assert.fail("Unexpected background lookup"),
    saveSideBackgroundImage: () => assert.fail("Unexpected background write"),
  },
})
mock.module("../model/config.js", {
  defaultExport: {},
  namedExports: { configSave: () => assert.fail("Unexpected config write") },
})
mock.module("node-fetch", { defaultExport: () => assert.fail("Unexpected network request") })
mock.module("../../../lib/plugins/plugin.js", {
  defaultExport: class Plugin {
    constructor(options) {
      Object.assign(this, options)
    }
  },
})
mock.module("../model/card.js", {
  namedExports: {
    getCardDetailForUser: async () => ({ ok: false }),
    getLocalCardDetailByRoleId: () => assert.fail("Unexpected card lookup"),
  },
})
const { render } = await import("../model/render.js")
const { enduid } = await import("../apps/enduid.js")
const root = fileURLToPath(new URL("../", import.meta.url))
const resources = pathToFileURL(path.join(root, "resources") + path.sep).href
const output = path.resolve(root, "temp/render-tests", process.env.RENDER_CASE_LABEL || "current")
const avatar = `${resources}help/ICON.png`
const illustration = `${resources}state/img/default_bg.jpg`
const longName = "这是一个用于检查换行的很长很长的管理员昵称"
const longMessage = `获取绑定信息失败：${"请求超时请重新登录验证账号。".repeat(5)} RequestTrace_${"abcdef".repeat(12)}`
const time = "2026-10-05 14:30:00"
const items = Array.from({ length: 8 }, (_, i) => ({
  uid: String(100000001 + i),
  name: i === 4 ? longName : ["管理员", "黎风", "伊冯", "洁尔佩塔"][i % 4],
  status: ["success", "signed", "fail", "skip"][i % 4],
  msg:
    i === 2
      ? longMessage
      : ["签到完成", "今日已签到", "登录凭据已失效", "仅UID绑定（不支持签到）"][i % 4],
}))
const signData = {
  title: "终末地 · 全部签到",
  subtitle: "账号签到结果",
  time,
  total: 8,
  success: 2,
  signed: 2,
  fail: 2,
  skip: 2,
  items,
  truncated: false,
}
const metric = {
  cur: 120,
  total: 240,
  percent: 50,
  color: "#187468",
  recoveryText: "今日 20:30",
  recoveryHint: "6 小时后回满",
  recovery_text: "6 小时后回满",
  urgent: false,
}
const chars = Array.from({ length: 7 }, (_, i) => ({
  name: i === 2 ? longName : "管理员",
  avatar,
  rarityColor: i % 2 ? "#487ea1" : "#b27721",
  level: 90,
  potentialLevel: i,
  profession: "近卫",
  property: "物理",
}))
const activities = ["character", "weapon", "activity"].map((type, i) => ({
  id: String(i),
  type,
  status: ["ongoing", "ending", "upcoming"][i],
  statusLabel: ["进行中", "即将结束", "即将开启"][i],
  typeLabel: ["角色寻访", "武器申领", "限时活动"][i],
  title:
    i === 1 ? "仅持续很短时间且拥有超长名称的活动标题" : ["灼烧的锋刃", "", "四号谷地探索计划"][i],
  label: "10-05 12:00 - 10-19 04:00",
  subLabel: "距离结束还有 6 天 14 小时",
  style: `left:${i * 30}%;width:${i === 1 ? 1.4 : 35}%;`,
  smallMode: i === 1,
  face: avatar,
  icon: avatar,
  bannerUrl: illustration,
  localIconPath: "",
}))
const calendarData = {
  title: "终末地 · 活动日历",
  subtitle: "最近 7 天 / 未来 14 天",
  updateTime: time,
  nowTime: time,
  summary: { total: 3, active: 2, upcoming: 1, regular: 1 },
  dayCount: 21,
  nowLeft: 33.333,
  dateList: [
    {
      month: 10,
      date: Array.from({ length: 21 }, (_, i) => i + 1),
      today: Array.from({ length: 21 }, (_, i) => i === 7),
      week: Array.from({ length: 21 }, (_, i) => i % 7),
    },
  ],
  weekName: ["日", "一", "二", "三", "四", "五", "六"],
  lanes: activities.map(item => [item]),
  flatList: activities,
  notes: ["#zmd订阅活动提醒", "#zmd取消订阅活动提醒"],
  emptyHint: "当前没有进行中或即将开放的活动",
}
const fixtures = [
  [
    "enduid/info",
    "long",
    {
      title: "环境检查",
      subtitle: "运行环境与依赖",
      time,
      kv: [
        { k: "运行状态", v: "正常" },
        { k: "Node.js", v: "v22.21.1" },
        { k: "资源路径", v: `C:/example/${"long-directory/".repeat(12)}` },
      ],
      notes: [longMessage],
    },
  ],
  ["enduid/all_sign", "normal", signData],
  ["fz/all_sign", "normal", { ...signData, title: "明日方舟 · 全部签到" }],
  [
    "enduid/all_sign",
    "long",
    {
      ...signData,
      total: 46,
      items: Array.from({ length: 40 }, (_, i) => ({
        ...items[i % items.length],
        uid: String(100000001 + i),
      })),
      truncated: true,
      shown: 40,
      remain: 6,
    },
  ],
  [
    "fz/all_sign",
    "empty",
    { ...signData, total: 0, success: 0, signed: 0, fail: 0, skip: 0, items: [] },
  ],
  [
    "enduid/daily",
    "normal",
    {
      time,
      name: longName,
      uid: "100000001",
      level: 60,
      worldLevel: 6,
      stamina: metric,
      bp: { ...metric, cur: 42 },
      activation: { ...metric, cur: 100, total: 100, percent: 100 },
    },
  ],
  [
    "enduid/daily_pro",
    "normal",
    {
      pile_url: illustration,
      bg_url: illustration,
      avatar_url: avatar,
      user_name: longName,
      uid: "100000001",
      user_level: 60,
      world_level: 6,
      stamina_icon_url: avatar,
      bp_icon_url: avatar,
      liveness_icon_url: avatar,
      stamina: metric,
      battle_pass: { ...metric, cur: 42 },
      liveness: { ...metric, cur: 100, total: 100, percent: 100 },
    },
  ],
  [
    "enduid/card",
    "normal",
    {
      name: longName,
      uid: "100000001",
      avatarUrl: avatar,
      createTime: "2026-01-22",
      mainMission: "第一章：驶向遥远的星辰与尚未探索的四号谷地",
      level: 60,
      worldLevel: 6,
      charNum: 32,
      weaponNum: 67,
      docNum: 121,
      achieveCount: 288,
      domainLevel: 10,
      puzzleTotal: 165,
      trchestTotal: 680,
      pieceTotal: 250,
      blackboxTotal: 48,
      chars,
    },
  ],
  [
    "enduid/build",
    "normal",
    {
      userName: longName,
      userUid: "100000001",
      userAvatarUrl: avatar,
      level: 60,
      worldLevel: 6,
      charNum: 32,
      weaponNum: 67,
      docNum: 121,
      time,
      rooms: Array.from({ length: 5 }, (_, i) => ({
        type: i + 1,
        level: 4,
        chars: chars.slice(0, 3),
      })),
      domains: ["四号谷地", "武陵"].map(name => ({
        name,
        level: 10,
        totalPuzzle: 65,
        totalTrchest: 120,
        totalPiece: 45,
        totalBlackbox: 12,
        settlements: [
          {
            name: "拥有很长很长名称的聚落",
            level: 8,
            remainMoney: 99999999,
            officers: chars.slice(0, 2),
          },
        ],
      })),
    },
  ],
  [
    "enduid/build",
    "empty",
    {
      userName: "管理员",
      userUid: "100000001",
      userAvatarUrl: "",
      level: 1,
      worldLevel: 1,
      charNum: 0,
      weaponNum: 0,
      docNum: 0,
      rooms: [],
      domains: [],
    },
  ],
  ["enduid/calendar", "calendar", { ...calendarData, displayMode: "calendar" }],
  ["enduid/calendar", "list", { ...calendarData, displayMode: "list" }],
  [
    "enduid/calendar",
    "empty",
    { ...calendarData, displayMode: "calendar", lanes: [], flatList: [] },
  ],
]
for (const isMaster of [false, true]) {
  let helpData
  const e = {
    user_id: "10001",
    isMaster,
    reply: async data => {
      helpData = data
    },
  }
  const app = new enduid(e)
  app.e = e
  await app.help()
  const { title, subtitle, prefix, sections } = helpData
  fixtures.push([
    "help/index",
    isMaster ? "master" : "normal",
    { title, subtitle, prefix, sections, avatar, time },
  ])
}
let browser

before(async () => {
  await fs.mkdir(output, { recursive: true })
  browser = await puppeteer.launch({
    headless: true,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
  })
})
after(async () => {
  await browser?.close()
})

for (const [tpl, name, params] of fixtures) {
  test(`${tpl} ${name} 实际渲染无缺图、文字溢出或远程字体请求`, async () => {
    const data = await render(tpl, params)
    data._res_path = resources
    const html = template(data.tplFile, data)
    const filename = `${tpl.replaceAll("/", "-")}-${name}`
    const htmlPath = path.join(output, `${filename}.html`)
    await fs.writeFile(htmlPath, html)
    const page = await browser.newPage()
    try {
      const failures = []
      await page.setViewport({ width: 1800, height: 1100, deviceScaleFactor: 1 })
      await page.setRequestInterception(true)
      page.on("request", request => {
        if (/^https?:/.test(request.url())) {
          failures.push(request.url())
          void request.abort()
        } else void request.continue()
      })
      page.on("pageerror", error => failures.push(error.message))
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle0" })
      await page.evaluate(() => document.fonts.ready)
      const container = await page.$("#container")
      await container.screenshot({ path: path.join(output, `${filename}.png`) })
      for (const width of [1800, 390]) {
        await page.setViewport({ width, height: 1100, deviceScaleFactor: 1 })
        const result = await page.evaluate(() => {
          const root = document.querySelector("#container").getBoundingClientRect()
          const elements = [...document.querySelectorAll("#container *")].filter(
            el => el.getClientRects().length,
          )
          const overlaps = []
          for (const group of document.querySelectorAll(
            ".report-header, .report-masthead, .resource-heading, .sign-row, .help-heading, .activity-item, .profile-header, .room-heading, .domain-heading",
          )) {
            const children = [...group.children].filter(el => el.getClientRects().length)
            for (let i = 0; i < children.length; i++) {
              for (let j = i + 1; j < children.length; j++) {
                const a = children[i].getBoundingClientRect()
                const b = children[j].getBoundingClientRect()
                if (
                  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
                ) {
                  overlaps.push(
                    `${group.className}: ${children[i].className} / ${children[j].className}`,
                  )
                }
              }
            }
          }
          return {
            fontLoaded: document.fonts.check("16px ReportSans"),
            width: root.width,
            height: root.height,
            overlaps,
            brokenImages: elements
              .filter(el => el.tagName === "IMG" && !el.naturalWidth)
              .map(el => el.getAttribute("src")),
            overflow: elements
              .filter(el => {
                const rect = el.getBoundingClientRect()
                const style = getComputedStyle(el)
                return (
                  rect.left < root.left - 1 ||
                  rect.right > root.right + 1 ||
                  rect.bottom > root.bottom + 1 ||
                  (el.clientWidth > 0 &&
                    el.scrollWidth > el.clientWidth + 1 &&
                    style.overflowX === "visible") ||
                  (el.clientHeight > 0 &&
                    el.scrollHeight > el.clientHeight + 1 &&
                    style.overflowY === "visible")
                )
              })
              .map(el => `${el.tagName}.${el.className}`),
          }
        })
        assert.equal(data.reportTheme, true)
        assert.equal(result.fontLoaded, true)
        assert.ok(result.width > 700 && result.height > 200)
        assert.deepEqual(failures, [])
        assert.deepEqual(result.brokenImages, [])
        assert.deepEqual(result.overflow, [])
        assert.deepEqual(result.overlaps, [])
      }
    } finally {
      await page.close()
    }
  })
}

test("角色面板及两种抽卡模板不启用新主题", async () => {
  for (const tpl of ["enduid/panel", "enduid/gachalog", "fz/gachalog"]) {
    const data = await render(tpl, { bodyClass: "original-style" })
    assert.equal(data.reportTheme, false)
    assert.equal(data.bodyClass, "original-style")
  }
})

test("插件直接依赖 qrcode 可生成有效的 420 像素 PNG", async () => {
  const { default: QRCode } = await import("qrcode")
  const png = await QRCode.toBuffer("zmd-plugin dependency check", { type: "png", width: 420 })
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
  assert.equal(png.readUInt32BE(16), 420)
  assert.equal(png.readUInt32BE(20), 420)
})
