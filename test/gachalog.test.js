import assert from "node:assert/strict"
import test from "node:test"

import { __gachalogTest } from "../model/gachalog.js"

const SPECIAL = "E_CharacterGachaPoolType_Special"
const JOINT = "E_CharacterGachaPoolType_Joint"

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
