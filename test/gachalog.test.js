import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test, { mock } from "node:test"

const fetchMock = mock.fn(() => assert.fail("Unexpected network request"))
mock.module("node-fetch", { defaultExport: fetchMock })
mock.module("../model/config.js", { defaultExport: { skland: { ua: { ios: "test-agent" } } } })
mock.module("../model/alias.js", { namedExports: { loadAliasMap: async () => ({}) } })
mock.module("../model/card.js", {
  namedExports: { getCardDetailForUser: async () => ({ ok: false }), getLocalCardDetailByRoleId: async () => null },
})
mock.module("../model/wiki/fetch.js", { namedExports: { ensureListData: async () => null } })

const { __gachalogTest, updateGachaLogsForUser, importGachaLogsFromU8TokenForUser, getGachaLogViewForRoleId } = await import("../model/gachalog.js")

const SPECIAL = "E_CharacterGachaPoolType_Special"
const JOINT = "E_CharacterGachaPoolType_Joint"
// Official WebView maps operator.type.rerun (重构寻访) to this record API type.
const RERUN = "E_CharacterGachaPoolType_Rerun"

function makePull(seq, overrides = {}) {
  return {
    poolId: "special_test",
    poolName: "测试特许寻访",
    charId: `char_${seq}`,
    charName: `角色${seq}`,
    rarity: 4,
    isFree: false,
    gachaTs: seq * 1000,
    seqId: String(seq),
    sourcePoolType: SPECIAL,
    ...overrides,
  }
}

test("大保底只标记未提前获得 UP 时的第 120 个付费抽", () => {
  const pulls = Array.from({ length: 240 }, (_, index) => makePull(index + 1))
  pulls[69] = makePull(70, { charId: "char_off", charName: "常驻六星", rarity: 6 })
  pulls[119] = makePull(120, { charId: "char_up", charName: "当期UP", rarity: 6 })
  pulls[239] = makePull(240, { charId: "char_up", charName: "当期UP", rarity: 6 })

  const result = __gachalogTest.analyzeFeaturedGuarantee(pulls, {
    featuredIds: ["char_up"],
  })

  assert.equal(result.get(pulls[69]).isFeatured, false)
  assert.equal(result.get(pulls[119]).isBigGuarantee, true)
  assert.equal(result.get(pulls[239]).isBigGuarantee, false)
})

test("十连内六星按整批结算且第 120 抽后不残留垫抽", () => {
  const pulls = []
  let offSix = null
  let upSix = null

  for (let batch = 1; batch <= 13; batch++) {
    const isFree = batch === 4
    for (let index = 0; index < 10; index++) {
      const seq = (batch - 1) * 10 + index + 1
      let overrides = { gachaTs: batch * 1000, isFree }
      if (batch === 6 && index === 3) {
        overrides = { ...overrides, charId: "char_off", charName: "常驻六星", rarity: 6 }
      } else if (batch === 13 && index === 1) {
        overrides = { ...overrides, charId: "char_up", charName: "当期UP", rarity: 6 }
      }
      const pull = makePull(seq, overrides)
      pulls.push(pull)
      if (batch === 6 && index === 3) offSix = pull
      if (batch === 13 && index === 1) upSix = pull
    }
  }

  const guarantee = __gachalogTest.analyzeFeaturedGuarantee(pulls, {
    featuredIds: ["char_up"],
  })
  const costs = __gachalogTest.buildSixCostByPoolId(pulls)
  const [pool] = __gachalogTest.buildPoolsByPoolId(pulls)

  assert.equal(costs.get(offSix), 50)
  assert.equal(costs.get(upSix), 70)
  assert.equal(pool.pity, 0)
  assert.equal(guarantee.get(upSix).paidCount, 120)
  assert.equal(guarantee.get(upSix).isBigGuarantee, true)
})

test("提前获得 UP 后第 120 抽不再误判大保底", () => {
  const pulls = Array.from({ length: 120 }, (_, index) => makePull(index + 1))
  pulls[29] = makePull(30, { charId: "char_up", charName: "当期UP", rarity: 6 })
  pulls[119] = makePull(120, { charId: "char_up", charName: "当期UP", rarity: 6 })

  const result = __gachalogTest.analyzeFeaturedGuarantee(pulls, {
    featuredIds: ["char_up"],
  })

  assert.equal(result.get(pulls[29]).isBigGuarantee, false)
  assert.equal(result.get(pulls[119]).isBigGuarantee, false)
})

test("免费抽与寻访档案事件不占用 120 抽计数", () => {
  const pulls = Array.from({ length: 119 }, (_, index) => makePull(index + 1))
  pulls.splice(60, 0, makePull(1000, { isFree: true }))
  pulls.splice(80, 0, {
    kind: "gift_intel_book",
    poolId: "special_test",
    poolName: "测试特许寻访",
    gachaTs: 1001 * 1000,
    seqId: "1001",
  })
  pulls.push(makePull(120, { charId: "char_up", charName: "当期UP", rarity: 6, gachaTs: 2000 * 1000 }))

  const filtered = __gachalogTest.filterPullRecords(pulls)
  const result = __gachalogTest.analyzeFeaturedGuarantee(filtered, {
    featuredIds: ["char_up"],
  })

  assert.equal(filtered.some(item => item.kind === "gift_intel_book"), false)
  assert.equal(result.get(pulls.at(-1)).paidCount, 120)
  assert.equal(result.get(pulls.at(-1)).isBigGuarantee, true)
})

test("只有名称时必须有可验证的 UP 名称才参与判定", () => {
  const pulls = Array.from({ length: 120 }, (_, index) => makePull(index + 1))
  const up = makePull(120, { charId: "", charName: "当期UP", rarity: 6 })
  pulls[119] = up

  const idOnly = __gachalogTest.analyzeFeaturedGuarantee(pulls, {
    featuredIds: ["char_up"],
  }).get(up)
  const withName = __gachalogTest.analyzeFeaturedGuarantee(pulls, {
    featuredIds: ["char_up"],
    featuredNames: ["当期UP"],
  }).get(up)

  assert.equal(idOnly.isFeaturedKnown, false)
  assert.equal(idOnly.isBigGuarantee, false)
  assert.equal(withName.isFeatured, true)
  assert.equal(withName.isBigGuarantee, true)
})

test("第 120 抽前存在身份未知的六星时不武断标记大保底", () => {
  const pulls = Array.from({ length: 120 }, (_, index) => makePull(index + 1))
  pulls[29] = makePull(30, { charId: "", charName: "未知六星", rarity: 6 })
  pulls[119] = makePull(120, { charId: "char_up", charName: "当期UP", rarity: 6 })

  const result = __gachalogTest.analyzeFeaturedGuarantee(pulls, {
    featuredIds: ["char_up"],
  })

  assert.equal(result.get(pulls[29]).isFeaturedKnown, false)
  assert.equal(result.get(pulls[119]).isBigGuarantee, false)
})

test("联合池只有部分名称映射时未匹配名称保持未知", () => {
  const item = makePull(1, { charId: "", charName: "联合UP乙", rarity: 6 })
  const result = __gachalogTest.analyzeFeaturedGuarantee([item], {
    featuredIds: ["char_up_a", "char_up_b"],
    featuredNames: ["联合UP甲"],
  }).get(item)

  assert.equal(result.isFeaturedKnown, false)
})

test("不完整记录出现后不再声称精确命中第 120 抽", () => {
  const pulls = Array.from({ length: 120 }, (_, index) => makePull(index + 1))
  pulls[9] = makePull(10, { seqId: "" })
  pulls[119] = makePull(120, { charId: "char_up", charName: "当期UP", rarity: 6 })

  const result = __gachalogTest.analyzeFeaturedGuarantee(pulls, {
    featuredIds: ["char_up"],
  })

  assert.equal(result.get(pulls[119]).isBigGuarantee, false)
})

test("官方卡池内容使用稳定角色 ID 解析 UP", () => {
  const metadata = __gachalogTest.mapContentPoolMetadata(
    { poolId: "special_test", poolName: "旧名称", sourcePoolType: SPECIAL },
    {
      code: 0,
      data: {
        pool: {
          pool_gacha_type: "char",
          pool_name: "测试特许寻访",
          pool_type: "special",
          up6_name: "当期UP",
          all: [
            { id: "char_up", name: "当期UP", rarity: 6 },
            { id: "char_off", name: "常驻六星", rarity: 6 },
          ],
          rotate_list: [
            { name: "当期UP", image: "https://example.com/char_up.png" },
          ],
        },
      },
    },
  )

  assert.deepEqual(metadata.featuredIds, ["char_up"])
  assert.deepEqual(metadata.featuredNames, ["当期UP"])
  assert.equal(metadata.poolName, "测试特许寻访")
  assert.deepEqual(metadata.charImagesById, {
    char_up: "https://example.com/char_up.png",
  })
  assert.equal(metadata.metadataVersion, 2)
})

test("角色图片解析支持 content 的通用 image 字段", () => {
  assert.equal(
    __gachalogTest.pickCharAvatarUrl({ image: "https://example.com/new-char.png" }),
    "https://example.com/new-char.png",
  )
})

test("同键的新接口记录可以修正旧记录的六星字段", () => {
  const oldRecord = makePull(1, { rarity: 5, charName: "错误名称" })
  const corrected = makePull(1, { rarity: 6, charName: "正确六星" })

  const { merged, newCount } = __gachalogTest.mergeRecords([oldRecord], [corrected])

  assert.equal(newCount, 0)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].rarity, 6)
  assert.equal(merged[0].charName, "正确六星")
})

test("同键导入记录不能把已有六星降级", () => {
  const six = makePull(1, { rarity: 6, charName: "正确六星" })
  const stale = makePull(1, { rarity: 4, charName: "错误四星" })

  const { merged } = __gachalogTest.mergeRecords([six], [stale])

  assert.equal(merged.length, 1)
  assert.equal(merged[0].rarity, 6)
  assert.equal(merged[0].charName, "正确六星")
})

test("合并时清理旧缓存重复键并保留信息更完整的六星", () => {
  const oldRecord = makePull(1, { rarity: 5 })
  const corrected = makePull(1, { rarity: 6, charName: "正确六星" })

  const { merged } = __gachalogTest.mergeRecords([oldRecord, corrected], [])

  assert.equal(merged.length, 1)
  assert.equal(merged[0].rarity, 6)
  assert.equal(merged[0].charName, "正确六星")
})

test("缺少 seqId 的同时间记录不做猜测性去重", () => {
  const four = makePull(1, { seqId: "", rarity: 4 })
  const six = makePull(1, { seqId: "", rarity: 6, charId: "char_six" })

  const { merged } = __gachalogTest.mergeRecords([four], [six])

  assert.equal(merged.length, 2)
  assert.equal(merged.some(item => item.rarity === 6), true)
})

test("分页声明仍有数据却返回空页时拒绝覆盖本地记录", () => {
  assert.throws(
    () => __gachalogTest.assertRecordPageProgress([], true),
    /分页返回空列表/,
  )
  assert.doesNotThrow(() => __gachalogTest.assertRecordPageProgress([], false))
  assert.throws(
    () => __gachalogTest.assertRecordPageProgress([makePull(10)], true, 10),
    /游标未推进/,
  )
  assert.throws(
    () => __gachalogTest.assertRecordPageProgress([makePull(20)], true, 10),
    /游标未推进/,
  )
})

test("六星列表不受 24 条上限和免费十抽摘要挤占", () => {
  const pulls = Array.from({ length: 25 }, (_, index) => makePull(index + 1, { rarity: 6 }))
  const [pool] = __gachalogTest.buildPoolsByPoolId(pulls)
  const sixLogs = pool.sixList.map(item => ({
    logType: "six",
    key: __gachalogTest.getItemKey(item),
    ts: item.gachaTs,
  }))
  const freeLogs = [{ logType: "free", key: "free", ts: 500 }]

  const logs = __gachalogTest.combineGachaLogs(sixLogs, freeLogs)

  assert.equal(pool.sixList.length, 25)
  assert.equal(logs.filter(item => item.logType === "six").length, 25)
  assert.equal(logs.some(item => item.logType === "free"), true)
})

test("全量刷新按记录键补齐且不删除接口未返回的旧记录", () => {
  const oldSpecialSix = makePull(1, { rarity: 6 })
  const oldJointSix = makePull(2, {
    poolId: "joint_old",
    rarity: 6,
    sourcePoolType: JOINT,
  })
  const newJoint = makePull(3, {
    poolId: "joint_new",
    sourcePoolType: JOINT,
  })

  const merged = __gachalogTest.mergeFullCharacterRecords(
    [oldSpecialSix, oldJointSix],
    new Map([
      [SPECIAL, []],
      [JOINT, [newJoint]],
    ]),
  )

  assert.equal(merged.some(item => item.poolId === "special_test" && item.rarity === 6), true)
  assert.equal(merged.some(item => item.poolId === "joint_old"), true)
  assert.equal(merged.some(item => item.poolId === "joint_new"), true)
})

function makeRerunPull(seq, overrides = {}) {
  return makePull(seq, {
    poolId: "revisit_fixture",
    poolName: "复刻测试寻访",
    sourcePoolType: RERUN,
    ...overrides,
  })
}

function rerunContent() {
  return {
    code: 0,
    data: {
      pool: {
        pool_type: "rerun",
        pool_name: "复刻测试寻访",
        up6_name: "复刻UP",
        all: [
          { id: "char_rerun_up", name: "复刻UP", rarity: 6 },
          { id: "char_rerun_off", name: "常驻六星", rarity: 6 },
        ],
      },
    },
  }
}

test("重构寻访 content 类型和 UP 角色使用官方映射", () => {
  const metadata = __gachalogTest.mapContentPoolMetadata(
    { poolId: "revisit_fixture", sourcePoolType: SPECIAL }, rerunContent(),
  )
  assert.equal(metadata.sourcePoolType, RERUN)
  assert.deepEqual(metadata.featuredIds, ["char_rerun_up"])
  assert.deepEqual(metadata.featuredNames, ["复刻UP"])
})

test("重构寻访的信物赠礼不计入抽数和六星出货", () => {
  const pull = makeRerunPull(1, { rarity: 6 })
  const gift = makeRerunPull(2, { kind: "gift_operator_token", rarity: 6 })
  assert.deepEqual(__gachalogTest.filterPullRecords([pull, gift]), [pull])
})

function mockGachaSync(t, { failLastPage = false, rerun = false, failRerun = false } = {}) {
  const roleId = "100000001"
  const weaponPull = (seq, overrides = {}) => makePull(seq, { poolId: "weapon_test", ...overrides })
  let cache = {
    info: { uid: roleId },
    charList: [makePull(100), makePull(70), makePull(1, { rarity: 6 })],
    weaponList: [weaponPull(50)],
    poolMetadata: {
      special_test: {
        poolId: "special_test",
        featuredIds: ["char_100"],
        source: "content",
        metadataVersion: 2,
      },
    },
  }
  const account = { uid: roleId, cred: "test-cred", token: "test-token", recordUid: "test-record-uid" }
  const previousRedis = global.redis
  global.redis = {
    sMembers: async () => [],
    get: async key => {
      assert.equal(key, "Yz:EndUID:User:10001")
      return JSON.stringify({ accounts: [account], active: 0, autoSign: false })
    },
  }
  t.after(() => { global.redis = previousRedis })

  t.mock.method(fs, "readFile", async file => {
    assert.equal(path.basename(file), `${roleId}.json`)
    return JSON.stringify(cache)
  })
  t.mock.method(fs, "mkdir", async dir => {
    assert.equal(path.basename(dir), "gachalog")
  })
  const write = t.mock.method(fs, "writeFile", async (file, content) => {
    assert.equal(path.basename(file), `${roleId}.json`)
    cache = JSON.parse(content)
  })
  const requestedPages = []
  fetchMock.mock.mockImplementation(async input => {
    const url = new URL(input)
    let data
    if (url.pathname.endsWith("/grant") || url.pathname.endsWith("/u8_token_by_uid")) {
      data = { status: 0, data: { token: "test-u8-token" } }
    } else if (url.pathname.endsWith("/binding_list")) {
      data = { status: 0, data: { list: [{ bindingList: [{ uid: account.recordUid, roles: [{ roleId }] }] }] } }
    } else if (url.pathname === "/api/record/char") {
      const poolType = url.searchParams.get("pool_type")
      const cursor = url.searchParams.get("seq_id") || "0"
      requestedPages.push(`${poolType}:${cursor}`)
      const pages = {
        0: { list: [makePull(120), makePull(110)], hasMore: true },
        110: { list: [makePull(100, { rarity: 6 }), makePull(99, { rarity: 6, gachaTs: 100000 }), makePull(70)], hasMore: true },
        70: { list: [makePull(60, { rarity: 6 })], hasMore: false },
      }
      if (failLastPage && poolType === SPECIAL && cursor === "70") {
        return new Response("unavailable", { status: 503 })
      }
      const rerunPages = {
        0: { list: [
          makeRerunPull(3, { sourcePoolType: undefined }),
          makeRerunPull(2, { sourcePoolType: undefined, rarity: 6, charId: "char_rerun_off", charName: "常驻六星", isFree: true }),
        ], hasMore: true },
        2: { list: [
          makeRerunPull(1, { sourcePoolType: undefined, rarity: 6, charId: "char_rerun_off", charName: "常驻六星" }),
          makeRerunPull(0, { sourcePoolType: undefined, kind: "gift_operator_token", rarity: 6 }),
        ], hasMore: false },
      }
      if (failRerun && poolType === RERUN && cursor === "2") {
        return new Response("unavailable", { status: 503 })
      }
      const page = poolType === SPECIAL ? pages[cursor] : rerun && poolType === RERUN ? rerunPages[cursor] : { list: [], hasMore: false }
      data = { code: 0, data: page }
    } else if (url.pathname === "/api/record/weapon") {
      data = { code: 0, data: { list: [weaponPull(50, { rarity: 6 }), weaponPull(49, { rarity: 6 })], hasMore: false } }
    } else if (url.pathname === "/api/content" && url.searchParams.get("pool_id") === "revisit_fixture") {
      data = rerunContent()
    } else {
      assert.fail(`Unexpected request: ${url.pathname}`)
    }
    return new Response(JSON.stringify(data))
  })

  return { getCache: () => cache, write, requestedPages }
}

for (const [label, sync] of [
  ["普通更新", () => updateGachaLogsForUser("10001")],
  ["全量更新", () => updateGachaLogsForUser("10001", { full: true })],
  ["u8 token 导入", () => importGachaLogsFromU8TokenForUser("10001", "test-u8-token")],
]) {
  test(`${label}补齐旧游标后的出货记录并修正六星且重复同步不增重`, async t => {
    const { getCache, requestedPages } = mockGachaSync(t)
    const result = await sync()

    assert.equal(result.ok, true, result.message)
    assert.equal(result.newCharCount, 4)
    assert.equal(result.newWeaponCount, 1)
    assert.equal(getCache().charList.length, 7)
    assert.equal(getCache().charList.find(item => item.seqId === "100").rarity, 6)
    assert.equal(getCache().charList.filter(item => item.rarity === 6).length, 4)
    assert.equal(getCache().weaponList.filter(item => item.rarity === 6).length, 2)
    assert.ok(requestedPages.includes(`${SPECIAL}:70`))
    assert.ok(requestedPages.some(page => page.startsWith(`${JOINT}:`)))

    const repeated = await sync()
    assert.equal(repeated.ok, true, repeated.message)
    assert.equal(repeated.newCharCount, 0)
    assert.equal(repeated.newWeaponCount, 0)
    assert.equal(getCache().charList.length, 7)
    assert.equal(getCache().weaponList.length, 2)
  })

  test(`${label}请求重构寻访分页并将付费与免费六星写入缓存和展示数据`, async t => {
    const { getCache, requestedPages } = mockGachaSync(t, { rerun: true })
    const result = await sync()
    assert.equal(result.ok, true, result.message)
    assert.ok(requestedPages.includes(`${RERUN}:0`), "must request the official Rerun pool type")
    assert.ok(requestedPages.includes(`${RERUN}:2`), "must finish Rerun pagination")

    const pulls = getCache().charList.filter(item => item.poolId === "revisit_fixture")
    assert.equal(pulls.length, 3)
    assert.ok(pulls.every(item => item.sourcePoolType === RERUN))
    assert.equal(pulls.filter(item => item.rarity === 6).length, 2)
    assert.equal(getCache().poolMetadata.revisit_fixture.sourcePoolType, RERUN)

    const view = await getGachaLogViewForRoleId("100000001", { allowUnbound: true, poolKind: "char" })
    assert.equal(view.ok, true, view.message)
    const pool = view.view.gacha.pools.find(item => item.poolId === "revisit_fixture")
    assert.equal(pool.title, "复刻测试寻访")
    assert.equal(pool.sourcePoolType, RERUN)
    assert.equal(pool.stats.total, 3)
    assert.equal(pool.stats.free, 1)
    assert.equal(pool.stats.six, 2)
    assert.equal(pool.pity, 1)
    assert.equal(pool.logs.filter(log => log.logType === "six").length, 2)
    assert.equal(pool.logs.find(log => log.logType === "six" && !log.isFree).tag, "歪")
    assert.equal(pool.logs.find(log => log.logType === "six" && log.isFree).tag, "")
    assert.equal(view.view.gacha.pools.find(item => item.poolId === "special_test").stats.total, 7)

    const again = await sync()
    assert.equal(again.ok, true, again.message)
    assert.equal(again.newCharCount, 0)
    assert.equal(getCache().charList.filter(item => item.poolId === "revisit_fixture").length, 3)
  })
}

test("旧游标之后分页请求失败时不写入不完整缓存", async t => {
  const { getCache, write } = mockGachaSync(t, { failLastPage: true })
  const result = await updateGachaLogsForUser("10001")

  assert.equal(result.ok, false)
  assert.match(result.message, /HTTP 503/)
  assert.equal(write.mock.callCount(), 0)
  assert.equal(getCache().charList.length, 3)
})

test("重构寻访中途失败不能被遗漏后仍报告同步成功", async t => {
  const { write } = mockGachaSync(t, { rerun: true, failRerun: true })
  const result = await updateGachaLogsForUser("10001")
  assert.equal(result.ok, false)
  assert.match(result.message, /HTTP 503/)
  assert.equal(write.mock.callCount(), 0)
})
