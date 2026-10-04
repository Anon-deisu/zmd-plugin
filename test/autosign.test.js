import assert from "node:assert/strict"
import test, { beforeEach, mock } from "node:test"

const unexpected = () => assert.fail("Unexpected external operation")
const cfg = {
  autoSign: { enableTask: true, concurrency: 2, minIntervalSec: 0, maxIntervalSec: 0 },
  fz: { autoSign: { enableTask: true, concurrency: 2, minIntervalSec: 0, maxIntervalSec: 0 } },
}
let values
let sets
let calls
let responses
let bindingErrors
let logs
let rendered

mock.module("../model/config.js", { defaultExport: cfg, namedExports: { configSave: unexpected } })
mock.module("node-fetch", { defaultExport: unexpected })
mock.module("../../../lib/plugins/plugin.js", {
  defaultExport: class Plugin {
    constructor(options) { Object.assign(this, options) }
  },
})
mock.module("../model/render.js", {
  namedExports: { render: async (template, data) => { rendered.push({ template, data }); return "test-image" } },
})

async function sign(game, cred, uid) {
  calls.push({ game, cred, uid })
  const response = responses.get(uid)
  if (response instanceof Error) throw response
  return response ?? { code: 0, data: {} }
}

mock.module("../model/skland/client.js", {
  namedExports: {
    attendance: (cred, uid) => sign("endfield", cred, uid),
    attendanceArknights: (cred, uid) => sign("arknights", cred, uid),
    getBinding: async cred => {
      if (bindingErrors.has(cred)) throw new Error("test binding failure")
      const uid = `ak-${cred}`
      return { code: 0, data: { list: [{ appCode: "arknights", defaultUid: uid, bindingList: [{ uid, nickName: uid }] }] } }
    },
    refreshToken: unexpected,
    request: unexpected,
    getUserInfo: unexpected,
    getCardDetail: unexpected,
    getScanId: unexpected,
    getScanStatus: unexpected,
    getTokenByScanCode: unexpected,
    getCredInfoByToken: unexpected,
  },
})

const { enduid } = await import("../apps/enduid.js")
const { fz } = await import("../apps/fz.js")
const { getUserData, setActiveAccount, upsertAccount } = await import("../model/store.js")

function putUser(userId, accounts, active = 0) {
  values.set(`Yz:EndUID:User:${userId}`, JSON.stringify({ accounts, active, autoSign: true }))
}

function instance(Plugin, userId = "10002") {
  const replies = []
  const e = { user_id: userId, reply: async message => { replies.push(message) } }
  const app = new Plugin(e)
  app.e = e
  return { app, replies }
}

beforeEach(() => {
  values = new Map()
  sets = new Map([
    ["Yz:EndUID:Users", new Set(["10001", "10002"])],
    ["Yz:EndUID:AutoSignUsers", new Set(["10001", "10002"])],
    ["Yz:EndUID:FzAutoSignUsers", new Set(["10001", "10002"])],
  ])
  calls = []
  responses = new Map()
  bindingErrors = new Set()
  logs = []
  rendered = []
  cfg.autoSign.enableTask = true
  cfg.fz.autoSign.enableTask = true
  putUser("10001", [{ uid: "100001", cred: "alpha", nickname: "Alpha" }])
  putUser("10002", [
    { uid: "100002", cred: "bravo", nickname: "Bravo" },
    { uid: "100003", cred: "charlie", nickname: "Charlie" },
  ], 1)

  global.redis = {
    get: async key => values.get(key) ?? null,
    set: async (key, value) => values.set(key, value),
    sMembers: async key => [...(sets.get(key) || [])],
    sAdd: async (key, value) => sets.get(key).add(value),
    sRem: async (key, value) => sets.get(key).delete(value),
    scan: async () => ({ cursor: 0, keys: [] }),
    hIncrBy: async () => {},
    expire: async () => {},
  }
  global.logger = {
    info: message => logs.push(message),
    warn: message => logs.push(message),
    error: message => logs.push(message),
  }
})

for (const [label, Plugin, game, subscriptionKey, taskConfig] of [
  ["终末地", enduid, "endfield", "Yz:EndUID:AutoSignUsers", cfg.autoSign],
  ["明日方舟", fz, "arknights", "Yz:EndUID:FzAutoSignUsers", cfg.fz.autoSign],
]) {
  const expectedUids = game === "endfield" ? ["100001", "100002", "100003"] : ["ak-alpha", "ak-bravo", "ak-charlie"]

  test(`${label}新增第二个绑定并重复开启后自动签到保留全部账号`, async () => {
    putUser("10002", [{ uid: "100002", cred: "bravo", nickname: "Bravo" }])
    const { app } = instance(Plugin)
    await app.autoSignOn()
    await upsertAccount("10002", { uid: "100003", cred: "charlie", nickname: "Charlie" })
    await app.autoSignOn()
    await app.task.fnc()

    assert.deepEqual(calls.map(call => call.uid).sort(), expectedUids)
    assert.ok(calls.every(call => call.game === game))
    assert.equal(sets.get(subscriptionKey).size, 2)
    const data = await getUserData("10002")
    assert.equal(data.active, 1)
    assert.equal(data.accounts.length, 2)
    assert.ok(logs.some(message => /成功 3 \| 已签 0 \| 失败 0 \| 跳过 0/.test(message)))
  })

  test(`${label}全部签到回执按账号统计而非按 QQ 用户统计`, async () => {
    const { app } = instance(Plugin)
    await app.allSign()

    assert.deepEqual(calls.map(call => call.uid).sort(), expectedUids)
    assert.equal(rendered[0].data.total, 3)
    assert.equal(rendered[0].data.success, 3)
    assert.deepEqual(rendered[0].data.items.map(item => item.uid).sort(), expectedUids)
    assert.equal((await getUserData("10002")).active, 1)
  })

  test(`${label}跳过当前 UID-only 账号且单账号失败不阻断其他账号`, async () => {
    const data = await getUserData("10002")
    putUser("10002", [...data.accounts, { uid: "100004", uidOnly: true }], 2)
    putUser("10003", [])
    sets.get("Yz:EndUID:Users").add("10003")
    responses.set(expectedUids[0], new Error("test attendance failure"))
    responses.set(expectedUids[1], { code: 10001 })

    const { app } = instance(Plugin)
    await app.allSign()

    assert.deepEqual(calls.map(call => call.uid).sort(), expectedUids)
    const { success, signed, fail, skip, total } = rendered[0].data
    assert.deepEqual({ success, signed, fail, skip, total }, { success: 1, signed: 1, fail: 1, skip: 2, total: 5 })
    assert.equal((await getUserData("10002")).active, 2)
  })

  test(`${label}当前仅绑定 UID 时仍可为其他有效绑定开启自动签到`, async () => {
    const data = await getUserData("10002")
    putUser("10002", [...data.accounts, { uid: "100004", uidOnly: true }], 2)
    sets.get(subscriptionKey).delete("10002")
    const { app, replies } = instance(Plugin)
    await app.autoSignOn()

    assert.equal(sets.get(subscriptionKey).has("10002"), true)
    assert.match(replies.at(-1), /已开启自动签到/)
    assert.equal((await getUserData("10002")).active, 2)
  })

  test(`${label}手动签到仍只处理当前选中的账号`, async () => {
    await setActiveAccount("10002", "1")
    const { app } = instance(Plugin)
    await app.sign()

    assert.deepEqual(calls.map(call => call.uid), [expectedUids[1]])
    assert.equal((await getUserData("10002")).active, 0)
  })

  test(`${label}自动签到只处理订阅用户且遵守任务开关`, async () => {
    sets.get(subscriptionKey).delete("10002")
    const { app } = instance(Plugin)
    await app.task.fnc()
    assert.deepEqual(calls.map(call => call.uid), [expectedUids[0]])

    taskConfig.enableTask = false
    await app.task.fnc()
    assert.equal(calls.length, 1)
  })
}

test("明日方舟单个森空岛绑定失效后仍处理其他已绑定账号", async () => {
  bindingErrors.add("bravo")
  const { app } = instance(fz)
  await app.allSign()

  assert.deepEqual(calls.map(call => call.uid).sort(), ["ak-alpha", "ak-charlie"])
  assert.equal(rendered[0].data.skip, 1)
  assert.equal(rendered[0].data.total, 3)
  assert.equal((await getUserData("10002")).active, 1)
})
