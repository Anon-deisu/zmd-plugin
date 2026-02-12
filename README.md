# zmd-plugin（TRSS-Yunzai）

终末地（Endfield）/ 森空岛（Skland）相关功能的 `TRSS-Yunzai` 插件。

- 命令前缀：`#zmd`（也可用 `#终末地`）
- 配置文件：`config/zmd-plugin.yaml`
- 反馈/交流群：`1084459856`（指令：`#反馈`）

## 功能一览

- 账号：私聊扫码登录 / 手动绑定 `cred` 或 `token` / 仅绑定 UID（面板查询）
- 查询：每日、卡片、面板、基建/飞船、公告
- 抽卡记录：更新/查看/导入/导出/删除（支持 `@用户` 与 UID 查询）
- 图鉴：biligame wiki 的角色/武器列表、卡池信息、图鉴查询
- 其他：状态统计、更新日志、环境诊断

## 快速开始

1) 安装插件并安装依赖（见下方）
2) 重启机器人
3) 私聊登录：`#zmd登录`（或仅面板：`#zmd绑定<UID>`）
4) 刷新数据：`#zmd刷新`
5) 常用查询：
   - `#zmd每日`
   - `#zmd卡片`
   - `#<角色>面板`（例如 `#管理员面板`）

## 安装

### 方式一：Git 安装（推荐）

在 TRSS-Yunzai 根目录执行：

```bash
git clone https://github.com/Anon-deisu/zmd-plugin plugins/zmd-plugin
```

后续更新：

```bash
cd plugins/zmd-plugin
git pull
```

### 方式二：手动安装

1) 下载/解压本仓库到 TRSS-Yunzai 的 `plugins/` 下（建议目录名为 `zmd-plugin`）
2) 在 TRSS-Yunzai 根目录安装依赖（如已安装可忽略）：

```bash
pnpm add qrcode node-fetch
```

3) 重启机器人

## 角色数据接口（Friend API：统一后端 / 本地）

面板中的“生命/攻击/防御/暴击、装备词条、武器基质词条”等详细数据来自 Friend API。

本插件保留两种获取方式（同一个上游，数据结构一致）：

- 统一后端（默认）：通过统一后端提供的 `/api/friend/*` 接口获取
- 本地接口：通过你本地部署的 Friend API（例如 `http://127.0.0.1:18080`）获取

说明：

- 未配置 Friend API 时：已登录账号仍可使用基础面板（Skland 卡片数据），但“仅 UID 绑定面板”可能不可用。
- Friend API 通常只返回“名片展示位”角色列表，UID-only 面板查询也可能只查到展示位角色。

### 查看 / 切换数据源

- 查看当前配置：`#数据源`
- 切换（仅 master）：
  - `#数据源切换`（在 本地 / 统一后端 间切换）
  - `#数据源切换 本地`
  - `#数据源切换 统一后端`
  - `#数据源切换 自动`（优先本地，未配置时回退统一后端）

### 配置统一后端

- 设置地址（仅 master）：`#统一后端地址 <url>`
  - 默认地址：`https://end-api.shallow.ink`
- 设置 Bearer（仅 master，建议私聊）：`#统一后端token <token>`

也可以直接编辑 `config/zmd-plugin.yaml`：

```yaml
friendApi:
  source: auto
  unifiedBaseUrl: "https://end-api.shallow.ink"
  unifiedBearer: "your_token"
```

### 配置本地接口

- 设置地址（仅 master）：`#本地数据地址 <url>`
- 设置 Bearer（仅 master，建议私聊）：`#本地数据token <token>`

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

- `#zmd登录`（仅私聊）
- `#zmd绑定<cred|token>`（支持 `cred=...` / `token=...` 前缀；仅私聊）
- `#zmd绑定<UID>`（无需登录：仅用于角色面板查询）
- `#zmd查看`
- `#zmd切换<序号|UID>`
- `#zmd删除<序号|UID>`

### 查询

- `#zmd每日<@用户>`
- `#zmd刷新`
- `#zmd卡片<@用户>`
- `#<角色>面板<@用户>`（推荐，例如 `#管理员面板`）
- `#zmd面板<角色>`（兼容旧用法）
- `#zmd基建<@用户>`

### 抽卡记录

- 更新：`#zmd更新抽卡记录<UID/@他人>` / `#zmd全量更新抽卡记录<UID/@他人>`
- 查看：`#zmd抽卡记录<UID/@他人>` / `#zmd角色记录<UID/@他人>` / `#zmd武器记录<UID/@他人>`
- 导入：`#zmd导入抽卡记录<u8_token/链接/JSON文件>`
- 导出：`#zmd导出抽卡记录`
- 删除：`#zmd删除抽卡记录`
- 图标：`#zmd更新武器图标<UID>`（可选：强制；全部仅 master）

### 公告

- `#zmd公告<id>`（不填 id 为列表）
- `#zmd订阅公告`
- `#zmd取消订阅公告`
- `#zmd清理公告缓存`（仅 master）

### 图鉴

- `#zmd角色列表` / `#zmd武器列表`
- `#zmd卡池`
- `#zmd<名称>图鉴`（后缀可用：`介绍/技能/天赋/潜能/专武/武器`）

### 签到 / 其他

- `#zmd签到`
- `#zmd开启自动签到` / `#zmd关闭自动签到`
- `#zmd全部签到`（仅 master）
- `#zmd状态` / `#zmd更新日志`
- `#zmd环境`（诊断 smsdk/qrcode 等依赖）
- `#zmd更新插件`（仅 master）
- `#zmd强制更新插件`（仅 master）
- `#反馈`

## 配置说明（常用项）

首次加载会自动生成：`config/zmd-plugin.yaml`

- `cmd.prefix`：仅用于帮助提示，不参与命令正则匹配（默认 `#zmd`）
- `card.cacheSec` / `card.staleCacheSec`：卡片详情缓存（用于「卡片/面板/基建」）
- `friendApi.source`：`auto/local/unified`
- `friendApi.baseUrl` / `friendApi.bearer`：本地 Friend API 配置
- `friendApi.unifiedBaseUrl` / `friendApi.unifiedBearer`：统一后端配置

修改配置后建议重启机器人。

## 数据与隐私

- 账号绑定信息主要存储在 Redis。
- 本插件运行时会在以下目录生成缓存/临时文件（用于加速与容错；删除后会自动重新生成）：
  - `data/zmd-plugin/gachalog/`：抽卡记录缓存 JSON（按 UID 命名）
  - `data/zmd-plugin/wiki/`：wiki 列表/页面缓存
  - `data/zmd-plugin/card/`：卡片详情持久化缓存（按 QQ+UID 命名）
  - `data/zmd-plugin/friendApi/`：Friend API 的 roleId/detail/computed 持久化缓存
  - `temp/zmd-plugin/`：二维码等临时文件
- 图标缓存（运行时生成）：
  - `plugins/zmd-plugin/resources/endfield/itemiconbig/`
  - `plugins/zmd-plugin/resources/endfield/charicon/`

## 常见问题

1) 提示缺少依赖 `qrcode` / `node-fetch`
   - 在 TRSS-Yunzai 根目录执行：`pnpm add qrcode node-fetch`，然后重启。

2) `#<角色>面板` 与其他插件冲突
   - 仍可使用旧用法：`#zmd面板<角色>`。

3) UID-only 绑定后查不到想看的角色
   - Friend API 通常只提供“名片展示位”角色列表；请先把目标角色放到名片展示位。

## 免责声明

本项目为非官方项目，与 鹰角网络 (Hypergryph) 及其旗下组织/团体/工作室没有任何关联。游戏图片与数据版权归各自权利人所有。

本插件按“现状”提供，不保证可用性、稳定性或数据准确性；使用过程中造成的任何数据损失、功能异常或经济损失均由用户自行承担。

## 仓库

- 主仓库：`https://github.com/Anon-deisu/zmd-plugin`

## 参考

- EndUID：`https://github.com/Loping151/EndUID`（主要逻辑实现参考）
- BeyondUID：`https://github.com/baiqwerdvd/BeyondUID/tree/master`（抽卡获取/记录逻辑参考）
- biligame wiki：`https://wiki.biligame.com/zmd/`（wiki 信息获取）

如你计划分发，请注意相关上游仓库的许可证要求。
