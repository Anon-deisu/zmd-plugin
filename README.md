# zmd-plugin（TRSS-Yunzai）

终末地（Endfield）/ 森空岛（Skland）相关功能的 `TRSS-Yunzai` 插件。

- 命令别名：`#zmd` / `#终末地`
- 配置文件：`config/zmd-plugin.yaml`（首次加载自动生成；支持从旧的 `config/enduid-yunzai.yaml` 合并迁移）

## 功能

- 账号：私聊扫码登录 / 手动绑定 `cred` 或 `token`
- 查询：每日、卡片、面板、基建/飞船、公告
- 抽卡记录：更新/查看/导入/导出/删除
  - 支持 `@用户` 查看
  - 支持按游戏 UID 查询/更新（例如 `#zmd抽卡记录123...`）
- 图鉴/列表：biligame wiki 的角色/武器列表、卡池信息、图鉴查询
- 其他：状态统计、更新日志

## 兼容性（须知）

此插件主要在 `TRSS-Yunzai + NapCat OneBotv11` 环境下自用验证，其余适配器/协议请自行测试与排查。

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
- `smsdk.smSdkPath`：`sm.sdk.js` 文件路径（留空则自动尝试常见位置）
- `card.cacheSec`：卡片详情缓存秒数（影响「卡片/面板/基建」）
- `ann.enableTask` / `ann.cron`：公告推送任务开关与定时
- `autoSign.enableTask` / `autoSign.cron`：自动签到任务开关与定时
- `security.noShowSecretInGroup`：群聊不回显 `cred/token`（默认开启）

修改配置后建议重启机器人。

## 指令速查

默认别名：`#zmd` / `#终末地`

### 账号

- `#zmd登录`（仅私聊）
- `#zmd绑定 <cred|token>`（支持 `cred=...` / `token=...` 前缀；建议仅私聊）
- `#zmd查看`
- `#zmd切换 <序号|UID>`
- `#zmd删除 <序号|UID>`

### 查询

- `#zmd每日` / `#zmd每日 @用户`
- `#zmd卡片` / `#zmd卡片 @用户`
- `#<角色>面板` / `#<角色>面板 @用户`（推荐，例如 `#霜星面板`）
- `#zmd面板 <角色>`（旧用法，仍支持；别名：`#zmd查询` / `#zmdmb`）
- `#zmd基建`（别名：`#zmd建设` / `#zmd地区建设` / `#zmdjj`；可加参数 `详细`）

### 抽卡记录

- 更新：
  - `#zmd更新抽卡记录`（别名：`#zmd抽卡记录更新`）
  - `#zmd更新抽卡记录<UID>` / `#zmd抽卡记录更新<UID>`（更新指定 UID 的缓存记录；若该 UID 未绑定则无法自动更新）
  - `#zmd更新抽卡记录 @用户` / `#zmd抽卡记录更新 @用户`（更新被 @ 用户的当前账号记录）
  - `#zmd全量更新抽卡记录` / `#zmd全量更新抽卡记录<UID>` / `#zmd全量更新抽卡记录 @用户`（全量重拉并覆盖本地缓存；别名：`#zmd重新获取所有抽卡记录`）
- 查看：
  - `#zmd抽卡记录`
  - `#zmd抽卡记录<UID>`（查询已缓存 UID 的记录）
  - `#zmd抽卡记录 @用户`
- 导入/导出/删除：
  - `#zmd导入抽卡记录 <u8_token/链接>` 或直接发送 JSON 文件
  - `#zmd导出抽卡记录`
  - `#zmd删除抽卡记录`
- 其他：`#zmd抽卡帮助` / `#zmd抽卡工具` / `#zmd更新武器图标`

### 公告

- `#zmd公告` / `#zmd公告列表`
- `#zmd公告 <id>`
- `#zmd订阅公告` / `#zmd取消订阅公告`
- `#zmd清理公告缓存`（仅 master）

### 图鉴

- `#zmd角色列表` / `#zmd武器列表`
- `#zmd卡池`（别名：`#zmd卡池信息` / `#zmdup角色`）
- `#zmd<名称>图鉴`（后缀可用：`介绍/技能/天赋/潜能/专武/武器`）

### 签到 / 其他

- `#zmd签到`
- `#zmd开启自动签到` / `#zmd关闭自动签到`
- `#zmd全部签到`（仅 master）
- `#zmd状态` / `#zmd更新日志`
- `#zmd环境`（诊断 smsdk/qrcode 等依赖）

## 数据与隐私

- 账号绑定信息主要存储在 Redis；本插件目录会写入的本地文件（已在 `.gitignore` 排除）：
  - `plugins/<插件目录>/data/gachalog/`：抽卡记录 JSON
  - `plugins/<插件目录>/data/wiki/`：wiki 列表/页面缓存
  - `temp/zmd-plugin/`：扫码二维码临时 PNG（渲染/排查用）
  - `plugins/<插件目录>/resources/endfield/itemiconbig/`：抽卡武器图标缓存（可用 `#zmd更新武器图标` 补全）

## 常见问题

1) 提示缺少依赖 `qrcode` / `node-fetch`
   - 在 TRSS-Yunzai 根目录执行：`pnpm add qrcode node-fetch`，然后重启。
2) `#<角色>面板` 与其他插件冲突
   - 仍可使用旧用法：`#zmd面板 <角色>`。

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
