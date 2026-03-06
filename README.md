<div align="center">

<h1>zmd-plugin（TRSS-Yunzai）</h1>

<p>
  适用于 <code>TRSS-Yunzai</code> 的终末地（Endfield）/ 森空岛（Skland）插件。<br/>
  提供登录绑定、每日查询、卡片 / 面板、基建、公告、抽卡记录、Wiki 图鉴，以及 <code>#fz</code> 明日方舟功能。
</p>

<p>
  <a href="https://github.com/Anon-deisu/zmd-plugin/stargazers"><img src="https://img.shields.io/github/stars/Anon-deisu/zmd-plugin?style=flat-square&logo=github" alt="GitHub Stars" /></a>
  <a href="https://github.com/Anon-deisu/zmd-plugin/network"><img src="https://img.shields.io/github/forks/Anon-deisu/zmd-plugin?style=flat-square&logo=github" alt="GitHub Forks" /></a>
  <a href="https://github.com/Anon-deisu/zmd-plugin/commits/main"><img src="https://img.shields.io/github/last-commit/Anon-deisu/zmd-plugin?style=flat-square&logo=github" alt="GitHub Last Commit" /></a>
  <a href="https://github.com/Anon-deisu/zmd-plugin/releases"><img src="https://img.shields.io/github/v/release/Anon-deisu/zmd-plugin?style=flat-square&logo=github" alt="GitHub Release" /></a>
  <a href="https://github.com/Anon-deisu/zmd-plugin"><img src="https://img.shields.io/github/license/Anon-deisu/zmd-plugin?style=flat-square" alt="GitHub License" /></a>
</p>

<p>
  <a href="https://star-history.com/#Anon-deisu/zmd-plugin&Date">
    <img src="https://api.star-history.com/svg?repos=Anon-deisu/zmd-plugin&type=Date" alt="Star History Chart" />
  </a>
</p>

</div>

| 项目 | 说明 |
| --- | --- |
| 主命令前缀 | `#zmd` / `#终末地` |
| 方舟命令前缀 | `#fz` |
| 配置文件 | `config/zmd-plugin.yaml` |
| 反馈 / 交流群 | `1084459856`（指令：`#反馈`） |

## 目录

- 功能概览
- 快速开始
- 安装
- 角色数据接口（统一后端 / 本地）
- 指令速查
- 配置说明
- 数据与隐私
- 常见问题
- 免责声明
- 仓库与参考

## 功能概览

### 终末地能力

- 账号：私聊扫码登录 / 手动绑定 `cred` 或 `token` / 仅绑定 UID（面板查询）
- 查询：每日、卡片、面板、基建 / 飞船、公告
- 抽卡记录：更新 / 全量更新 / 查看 / 导入 / 导出 / 删除
- 图鉴：角色列表、武器列表、卡池、角色 / 武器图鉴、技能 / 天赋 / 潜能分项查询

### 明日方舟能力（`#fz`）

- 森空岛签到 / 全部签到 / 自动签到
- 抽卡记录工具链：更新、全量更新、导入、导出、删除、查看
- 抽卡记录按 `限定 / 常驻 / 中坚` 聚合展示

### 辅助能力

- 统一后端 / 本地 Friend API 切换
- 公告订阅与定时推送
- 状态统计、更新日志、环境诊断

## 快速开始

如果你只想最快跑起来，按下面顺序即可：

1. 安装插件并补齐依赖
2. 重启机器人
3. 私聊执行 `#zmd登录` 绑定账号
4. 执行 `#zmd刷新` 同步卡片数据
5. 开始使用常用命令：
   - `#zmd每日`
   - `#zmd卡片`
   - `#管理员面板`
   - `#zmd抽卡记录`
6. 查看完整帮助：`#zmd帮助`

## 安装

### 方式一：Git 安装（推荐）

在 `TRSS-Yunzai` 根目录执行：

```bash
git clone https://github.com/Anon-deisu/zmd-plugin plugins/zmd-plugin
```

后续更新：

```bash
cd plugins/zmd-plugin
git pull
```

机器人内更新（仅 master）：

- `#zmd更新插件`
- `#zmd强制更新插件`

### 方式二：手动安装

1. 下载 / 解压本仓库到 `TRSS-Yunzai/plugins/` 下
2. 建议目录名使用：`zmd-plugin`
3. 在 `TRSS-Yunzai` 根目录安装依赖：

```bash
pnpm add qrcode node-fetch yaml puppeteer
```

4. 重启机器人

## 角色数据接口（统一后端 / 本地）

面板中的这些详细数据依赖角色数据接口：

- 生命 / 攻击 / 防御 / 暴击
- 装备词条
- 武器基质词条
- UID-only 面板补完数据

### 不配置 API 会怎样？

- 已登录账号：仍可使用基础卡片 / 面板能力
- 仅绑定 UID 的账号：面板功能可能不可用或信息不完整
- Friend API 通常只返回名片展示位角色，因此 UID-only 面板也可能只能查到展示位角色

### 当前支持的数据源

- 统一后端（默认）：通过统一后端提供的 `/api/friend/*` 接口获取
- 本地接口：通过本地部署的 Friend API 获取，例如 `http://127.0.0.1:18080`
- 统一后端官网登录 / 获取凭证：`https://end.shallow.ink/`

### 查看 / 切换数据源

- 查看当前配置：`#数据源`
- 切换（仅 master）：
  - `#数据源切换`
  - `#数据源切换 本地`
  - `#数据源切换 统一后端`
  - `#数据源切换 自动`

### 配置统一后端

| 操作 | 命令 |
| --- | --- |
| 设置地址 | `#统一后端地址 <url>` |
| 设置 Bearer | `#统一后端token <token>` |
| 设置 API Key | `#统一后端apikey <key>` |
| 设置 Framework Token | `#统一后端frameworktoken <token>` |
| 设置匿名令牌 | `#统一后端匿名token <token>` |

补充说明：

- 默认地址：`https://end-api.shallow.ink`
- 建议私聊设置鉴权信息
- `#统一后端token` 会自动识别部分前缀：
  - `ef_...` 可能按 `API Key` 处理
  - `qr_...` 可能按 `Framework Token` 处理
- 为减少歧义，推荐优先使用明确命令：`#统一后端apikey` / `#统一后端frameworktoken`

配置示例：

```yaml
friendApi:
  source: auto
  unifiedBaseUrl: "https://end-api.shallow.ink"
  # 以下鉴权任选其一：
  # unifiedBearer: "your_bearer"
  unifiedApiKey: "ef_xxx"
  # unifiedFrameworkToken: "qr_xxx"
  # unifiedAnonymousToken: "your_anon_token"
```

### 配置本地接口

| 操作 | 命令 |
| --- | --- |
| 设置地址 | `#本地数据地址 <url>` |
| 设置 Bearer | `#本地数据token <token>` |

配置示例：

```yaml
friendApi:
  source: local
  baseUrl: "http://127.0.0.1:18080"
  bearer: "your_token"
```

## 指令速查

默认前缀：`#zmd`

### 账号

- `#zmd登录`：扫码登录，仅私聊
- `#zmd绑定<cred|token>`：手动绑定账号，仅私聊
- `#zmd绑定<UID>`：无需登录，仅用于角色面板查询
- `#zmd查看`：查看已绑定账号
- `#zmd切换<序号|UID>`：切换当前活跃账号
- `#zmd删除<序号|UID>`：删除绑定账号

### 查询

- `#zmd每日<@用户>`
- `#zmd刷新`
- `#zmd卡片<@用户>`
- `#<角色>面板<@用户>`：推荐用法，例如 `#管理员面板`
- `#zmd面板<角色>`：兼容旧用法
- `#zmd基建<@用户>`

### 终末地抽卡记录

- 更新：`#zmd更新抽卡记录<UID/@他人>`
- 全量：`#zmd全量更新抽卡记录<UID/@他人>`
- 查看：`#zmd抽卡记录<UID/@他人>`
- 角色池：`#zmd角色记录<UID/@他人>`
- 武器池：`#zmd武器记录<UID/@他人>`
- 导入：`#zmd导入抽卡记录<u8_token/链接/JSON文件>`
- 导出：`#zmd导出抽卡记录`
- 删除：`#zmd删除抽卡记录`
- 图标补全：`#zmd更新武器图标<UID>`（可加 `强制`；`全部` 仅 master）

### 公告

- `#zmd公告<id>`：不填 `id` 时显示列表
- `#zmd订阅公告`
- `#zmd取消订阅公告`
- `#zmd清理公告缓存`：仅清理内存缓存，不影响订阅 / 已读，仅 master

### Wiki 图鉴

- `#zmd角色列表`
- `#zmd武器列表`
- `#zmd卡池`
- `#zmd<名称>图鉴`
- `#zmd<名称>介绍`
- `#zmd<名称>技能`
- `#zmd<名称>天赋`
- `#zmd<名称>潜能`
- `#zmd<名称>专武`
- `#zmd<名称>武器`

### 签到 / 其他

- `#zmd签到`
- `#zmd开启自动签到` / `#zmd关闭自动签到`
- `#zmd全部签到`（仅 master）
- `#zmd状态`
- `#zmd更新日志`
- `#zmd环境`
- `#zmd更新插件`（仅 master）
- `#zmd强制更新插件`（仅 master）
- `#反馈`

### 明日方舟（`#fz`）

说明：复用本插件的森空岛绑定（`#zmd登录` / `#zmd绑定`），命令前缀固定为 `#fz`。

- `#fz签到`
- `#fz全部签到`（仅 master）
- `#fz开启自动签到` / `#fz关闭自动签到`
- `#fz更新抽卡记录` / `#fz更新抽卡记录 @用户`
- `#fz全量更新抽卡记录` / `#fz全量更新抽卡记录 @用户`
- `#fz抽卡记录` / `#fz抽卡记录 @用户`
- `#fz导入抽卡记录`：发送 JSON 文件 / 粘贴 JSON / 文件链接
- `#fz导出抽卡记录`
- `#fz删除抽卡记录`

## 配置说明

首次加载后会自动生成：`config/zmd-plugin.yaml`

| 配置项 | 说明 |
| --- | --- |
| `cmd.prefix` | 仅用于帮助提示，不参与命令正则匹配 |
| `card.cacheSec` / `card.staleCacheSec` | 卡片详情缓存 |
| `friendApi.source` | `auto / local / unified` |
| `friendApi.baseUrl` / `friendApi.bearer` | 本地 API 配置 |
| `friendApi.anonymousToken` / `friendApi.apiKey` / `friendApi.frameworkToken` | 本地 API 其他鉴权（可选） |
| `friendApi.unifiedBaseUrl` | 统一后端地址 |
| `friendApi.unifiedBearer` / `friendApi.unifiedApiKey` / `friendApi.unifiedFrameworkToken` / `friendApi.unifiedAnonymousToken` | 统一后端鉴权（可选） |
| `fz.autoSign.*` | 明日方舟自动签到任务配置 |

修改配置后建议重启机器人。

## 数据与隐私

### 存储说明

- 账号绑定信息主要存储在 Redis
- 本插件运行时会写入缓存 / 临时文件，用于加速、容错和渲染
- 删除这些缓存后，后续使用时会自动重新生成

### 本地目录

| 路径 | 用途 |
| --- | --- |
| `data/zmd-plugin/gachalog/` | 终末地抽卡记录缓存 JSON |
| `data/zmd-plugin/fz/gachalog/` | 明日方舟抽卡记录缓存 JSON |
| `data/zmd-plugin/wiki/` | Wiki 列表 / 页面缓存 |
| `data/zmd-plugin/card/` | 卡片详情持久化缓存 |
| `data/zmd-plugin/friendApi/` | Friend API 的 roleId / detail / computed 缓存 |
| `temp/zmd-plugin/` | 二维码等临时文件 |
| `plugins/zmd-plugin/resources/endfield/itemiconbig/` | 武器图标缓存 |
| `plugins/zmd-plugin/resources/endfield/charicon/` | 角色图标缓存 |

## 常见问题

### 1. 提示缺少依赖 `qrcode` / `node-fetch` / `yaml` / `puppeteer`

在 `TRSS-Yunzai` 根目录执行：

```bash
pnpm add qrcode node-fetch yaml puppeteer
```

然后重启机器人。

### 2. `#<角色>面板` 与其他插件冲突

仍可使用旧用法：`#zmd面板<角色>`。

### 3. UID-only 绑定后查不到想看的角色

Friend API 通常只提供“名片展示位”角色列表。请先把目标角色放到名片展示位，再查询面板。

### 4. 统一后端提示 401 / 无法获取数据

- 统一后端可能要求不同鉴权方式：`Bearer / API Key / Framework Token / 匿名令牌`
- 推荐按后端要求分别设置：
  - `#统一后端apikey <key>`
  - `#统一后端frameworktoken <token>`
  - `#统一后端token <token>`

## 免责声明

本项目为非官方项目，与鹰角网络（Hypergryph）及其旗下组织 / 团体 / 工作室没有任何关联。游戏图片与数据版权归各自权利人所有。

本插件按“现状”提供，不保证可用性、稳定性或数据准确性；使用过程中造成的任何数据损失、功能异常或经济损失均由用户自行承担。

## 仓库与参考

### 仓库

- 主仓库：`https://github.com/Anon-deisu/zmd-plugin`

### 参考项目

- EndUID：`https://github.com/Loping151/EndUID`
- BeyondUID：`https://github.com/baiqwerdvd/BeyondUID/tree/master`
- miao-plugin：`https://github.com/yoimiya-kokomi/miao-plugin`
- endfield-plugin：`https://github.com/Entropy-Increase-Team/endfield-plugin`
- arknights-plugin：`https://github.com/gxy12345/arknights-plugin`
- biligame wiki：`https://wiki.biligame.com/zmd/`

如你计划分发，请注意相关上游仓库的许可证要求。
