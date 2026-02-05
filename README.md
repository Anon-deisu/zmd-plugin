# zmd-plugin（TRSS-Yunzai）

终末地（Endfield）/ 森空岛（Skland）相关功能的 `TRSS-Yunzai` 插件

## 功能

- 账号：私聊扫码登录 / 手动绑定 cred 或 token
- 查询：每日、卡片、面板、基建、公告
- 抽卡记录：更新/查看/导入/导出/删除
  - 支持 `@用户` 查看
  - 支持按游戏 UID 查询/更新（例如 `#zmd抽卡记录123...`）
- 攻略（图鉴）：biligame wiki 的角色/武器列表、卡池信息、图鉴查询

## 须知

此插件基本就是EndUID的JS复刻版，同时缝合了一点其他项目，仅保证能够在trss-yunzai+napcat OneBotv11的环境下运行，其余环境请自测自行debug，我不提供适配

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

1) 下载/解压本仓库到 TRSS-Yunzai 的 `plugins/` 下并命名为 `zmd-plugin`
2) 在 TRSS-Yunzai 根目录安装依赖（如已安装可忽略）：

```bash
pnpm add qrcode
```

3) 重启机器人

## 配置

首次加载会自动生成：`config/zmd-plugin.yaml`

常用配置：

- `cmd.prefix`：仅用于帮助提示，不参与命令正则匹配（默认 `#zmd`）
- `smsdk.smSdkPath`：`sm.sdk.js` 文件路径（留空则自动探测常见位置）
- `gacha.autoSyncAfterLogin`：登录绑定成功后是否自动同步一次抽卡记录

## 指令速查

默认别名：`#zmd` / `#终末地`

### 账号

- `#zmd登录`
- `#zmd绑定 <cred|token>`（支持 `cred=...` / `token=...`）
- `#zmd查看` / `#zmd切换 <序号|UID>` / `#zmd删除 <序号|UID>`

### 抽卡记录

- 更新：
  - `#zmd更新抽卡记录`
  - `#zmd更新抽卡记录<UID>`（仅允许更新自己已绑定的 UID）
  - `#zmd更新抽卡记录 @用户`（仅 master）
- 查看：
  - `#zmd抽卡记录`
  - `#zmd抽卡记录<UID>`（仅允许查询自己已绑定的 UID；master 可查询任意已缓存 UID）
  - `#zmd抽卡记录 @用户`
- 导入/导出/删除：
  - `#zmd导入抽卡记录 <u8_token/链接>` 或直接发送 JSON 文件
  - `#zmd导出抽卡记录`
  - `#zmd删除抽卡记录`

### 攻略（图鉴 / biligame wiki）

- `#zmd角色列表` / `#zmd武器列表`
- `#zmd卡池`（别名：`#zmd卡池信息` / `#zmdup角色`）
- `#zmd<名称>图鉴`（后缀可用：介绍/技能/天赋/潜能/专武/武器）


## 免责声明

本项目为非官方项目，与 鹰角网络 (Hypergryph) 及其旗下组织/团体/工作室没有任何关联。游戏图片与数据版权归各自权利人所有。

本插件按“现状”提供，不保证可用性、稳定性或数据准确性；使用过程中造成的任何数据损失、功能异常或经济损失均由用户自行承担。

使用本插件/项目需遵守所在地法律法规、游戏/平台服务条款及知识产权要求；如有合规/安全疑虑，请立即停止使用并卸载。

本项目仅供学习使用，请勿用于商业用途。使用本插件视为同意提供用户凭据，用户凭据仅用于查询游戏数据。使用本插件造成的任何数据滥用行为与作者无关。

## 仓库

- 主仓库：`https://github.com/Anon-deisu/zmd-plugin`

## 参考

- EndUID：`https://github.com/Loping151/EndUID`  主要逻辑实现参考
- BeyondUID：`https://github.com/baiqwerdvd/BeyondUID/tree/master`  抽卡获取/记录逻辑参考
- biligame wiki：`https://wiki.biligame.com/zmd/` wiki信息获取

如你计划分发，请注意相关上游仓库的许可证要求。
