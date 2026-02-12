# zmd-plugin（TRSS-Yunzai）

终末地（Endfield）/ 森空岛（Skland）相关功能的 `TRSS-Yunzai` 插件。

- 命令前缀：`#zmd`（也可用 `#终末地`）
- 配置文件：`config/zmd-plugin.yaml`（首次加载自动生成；支持从旧的 `config/enduid-yunzai.yaml` 合并迁移）
- 反馈/交流群：1084459856（指令：`#反馈`）

## 近期更新（2026-02）

- 面板：可选接入“角色数据接口（Friend API）”补全面板数值/装备词条/武器基质词条
- 账号：新增 `#zmd绑定<UID>`（仅面板绑定，无需登录）
- 帮助：指令示例精简；非主人不会看到 master 专用功能

## 功能

- 账号：私聊扫码登录 / 手动绑定 `cred` 或 `token` / 仅面板绑定 UID
- 查询：每日、卡片、面板、基建/飞船、公告
- 抽卡记录：更新/查看/导入/导出/删除
  - 支持 `@用户` 查看
  - 支持按游戏 UID 查询/更新
- 图鉴/列表：biligame wiki 的角色/武器列表、卡池信息、图鉴查询
- 其他：状态统计、更新日志

## 兼容性（须知）

此插件主要在 `TRSS-Yunzai + NapCat OneBotv11` 环境下完成验证；其他适配器/协议建议自行测试，欢迎反馈兼容性问题。

## 快速开始

1) 安装插件并安装依赖（见下方）
2) 重启机器人
3) 私聊登录：`#zmd登录`
4) 刷新数据：`#zmd刷新`
5) 常用查询：
   - `#zmd每日`
   - `#zmd卡片`
   - `#<角色>面板`（例如 `#管理员面板`）
6) 抽卡记录：`#zmd更新抽卡记录` -> `#zmd抽卡记录`

如果你不想登录、只想查面板：可用 `#zmd绑定<UID>`（见下方说明）。

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

## 配置

首次加载会自动生成：`config/zmd-plugin.yaml`

常用配置项：

- `cmd.prefix`：仅用于帮助提示，不参与命令正则匹配（默认 `#zmd`）
- `gacha.toolUrl`：抽卡工具下载链接（`#zmd抽卡工具` 会回复该链接）
- `gacha.autoSyncAfterLogin`：登录绑定成功后是否自动同步一次抽卡记录
- `card.cacheSec`：卡片详情缓存秒数（影响「卡片/面板/基建」）
- `ann.enableTask` / `ann.cron`：公告推送任务开关与定时
- `autoSign.enableTask` / `autoSign.cron`：自动签到任务开关与定时
- `security.noShowSecretInGroup`：群聊不回显 `cred/token`（默认开启）
- `friendApi.baseUrl`：本地角色数据接口地址（用于补全面板数据；见下方“角色数据接口”）
- `card.staleCacheSec`：卡片详情缓存秒数

修改配置后建议重启机器人。

## 角色数据接口（Friend API，仅本地实现）

面板中的“生命/攻击/防御/暴击、装备词条、武器基质词条”等详细数据来自一个可选的本地 HTTP 服务

重要说明：

- 这是**仅本地实现**的接口
- 插件仓库**不提供**该接口实现

配置示例（`config/zmd-plugin.yaml`）：

```yaml
friendApi:
  enable: true
  baseUrl: "http://127.0.0.1:18080"
  timeoutMs: 8000
  retries: 1
```

接口能力（插件会用到的典型路径）：

- `GET /health`
- `GET /friend/detail?role_id=...`（获取名片展示位角色列表）
- `GET /friend/search?uid=...`（将游戏 UID 映射到 Friend API 的 role_id）
- `GET /friend/char?role_id=...&template_id=...`（获取单角色面板/装备词条/武器词条等）

注：Friend API 通常只返回“名片展示位”角色（数量有限），因此 UID-only 面板查询也仅能查到展示位角色；如需查其他角色，需要你在服务端侧提供更完整的角色列表/检索能力。

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
- `#zmd上传背景图`（仅 master，发送命令时附图）

## 数据与隐私

- 账号绑定信息主要存储在 Redis；本插件目录会写入的本地文件：
  - `plugins/<插件目录>/data/gachalog/`：抽卡记录 JSON
  - `plugins/<插件目录>/data/wiki/`：wiki 列表/页面缓存
  - `temp/zmd-plugin/`：扫码二维码临时 PNG（渲染/排查用）
  - `plugins/<插件目录>/resources/endfield/itemiconbig/`：抽卡武器图标缓存（可用 `#zmd更新武器图标` 补全）
  - `plugins/<插件目录>/resources/side/`：渲染背景图库（可用 `#zmd上传背景图` 增加背景图）

## 常见问题

1) 提示缺少依赖 `qrcode` / `node-fetch`
   - 在 TRSS-Yunzai 根目录执行：`pnpm add qrcode node-fetch`，然后重启。
2) `#<角色>面板` 与其他插件冲突
   - 仍可使用旧用法：`#zmd面板<角色>`。

3) UID-only 绑定后查不到想看的角色
   - Friend API 通常只提供“名片展示位”角色列表，数量有限；请先把目标角色放到名片展示位，或使用模板ID查询。

## 免责声明

本项目为非官方项目，与 鹰角网络 (Hypergryph) 及其旗下组织/团体/工作室没有任何关联。游戏图片与数据版权归各自权利人所有。

本插件按“现状”提供，不保证可用性、稳定性或数据准确性；使用过程中造成的任何数据损失、功能异常或经济损失均由用户自行承担。

使用本插件/项目需遵守所在地法律法规、游戏/平台服务条款及知识产权要求；如有合规/安全疑虑，请立即停止使用并卸载。

本项目仅供学习使用，请勿用于商业用途。使用本插件视为同意提供用户凭据，用户凭据仅用于查询游戏数据。使用本插件造成的任何数据滥用行为与作者无关。

## 仓库

- 主仓库：`https://github.com/Anon-deisu/zmd-plugin`

## 参考

- EndUID：`https://github.com/Loping151/EndUID`（主要逻辑实现参考）
- BeyondUID：`https://github.com/baiqwerdvd/BeyondUID/tree/master`（抽卡获取/记录逻辑参考）
- biligame wiki：`https://wiki.biligame.com/zmd/`（wiki 信息获取）

如你计划分发，请注意相关上游仓库的许可证要求。
