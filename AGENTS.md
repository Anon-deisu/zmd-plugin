# enduid-yunzai（TRSS-Yunzai）架构速览

本文件用于帮助后续 AI/维护者快速理解插件结构与数据流，便于安全修改与排查问题。

## 插件状态（同步）

- 二维码生成已完全去除外部 Python 依赖：使用 Node 依赖 `qrcode` 直接生成 PNG；插件内不再包含/引用 `model/python/`。

## 入口与加载方式

- `index.js`：自动扫描并 `import()` `apps/*.js`，将每个模块“第一个导出”的值作为插件类，最终 `export { apps }`。
  - 新增功能建议：新建一个 `apps/<name>.js`，并确保该文件第一个导出是 `class <name> extends plugin`。

## 功能分层（按目录）

### apps/（命令入口层）

每个文件都是一个 `plugin` 子类，负责：
1) 正则匹配命令；2) 参数解析；3) 调用 `model/` 完成业务；4) 回复文字/图片。

- `apps/enduid.js`：账号绑定/登录、每日、签到、自动签到任务、环境诊断等。
- `apps/card.js`：`刷新/卡片/面板`（依赖 `model/card.js` 获取数据 + `model/render.js` 渲染图片）。
- `apps/build.js`：`基建/飞船`（依赖 `model/card.js` 数据 + `resources/enduid/build.html` 模板渲染）。
- `apps/ann.js`：公告列表/详情、群订阅、公告推送任务（依赖 `model/ann.js`）。
- `apps/alias.js`：角色别名查看/添加/删除（依赖 `model/alias.js`）。
- `apps/status.js`：状态统计、更新日志（依赖 `model/signStats.js`、`model/store.js`、`model/updateLog.js`）。
- `apps/strategy.js`：攻略查询、资源下载/更新、上传/删除（会写入 `data/strategyimg/`）。

### model/（业务/数据层）

- `model/config.js`：默认配置 + 生成 `config/enduid-yunzai.yaml`。
  - 注意：`cmd.prefix` 仅用于帮助文本提示，不参与命令正则匹配；要改触发词请改各 `apps/*.js` 的 `rule.reg`。
- `model/store.js`：绑定账号/当前账号/自动签到开关等（Redis 持久化）。
- `model/card.js`：Skland 卡片详情获取与缓存；并在成功后更新角色别名库（调用 `model/alias.js`）。
- `model/alias.js`：别名库（模板 `model/alias_template.json` + Redis 持久化），提供解析/添加/删除。
- `model/ann.js`：公告抓取（fetch 为主；可选 puppeteer 兜底）、订阅群管理、去重与已读集合、推送任务逻辑。
- `model/skland/*`：Skland API 常量、请求签名、headers、请求封装。
- `model/skland/deviceId.js` + `model/smsdk_runner.cjs`：通过运行 `sm.sdk.js` 生成 `dId`（Skland 签名/请求需要）。
- `model/qrcode.js`：生成扫码登录二维码 PNG（Node 依赖 `qrcode`；输出到 `process.cwd()/temp/enduid-yunzai/`）。
- `model/render.js`：基于 TRSS 的 `lib/puppeteer/puppeteer.js` 截图渲染（模板在 `resources/**`）。
- `model/signStats.js`：签到成功/失败统计（Redis hash，保留 14 天）。
- `model/updateLog.js`：通过 `git log` 抽取带 emoji 的提交信息作为“更新日志”。

### resources/（图片渲染模板）

`model/render.js` 通过 `resources/<app>/<tpl>.html` + `resources/common/layout/default.html` 渲染图片。

常用模板示例：
- `resources/enduid/card.html`：卡片总览
- `resources/enduid/panel.html`：角色面板
- `resources/enduid/build.html`：基建/飞船
- `resources/enduid/daily*.html`：每日信息

## 命令匹配规则（冲突排查重点）

- 大多数命令正则以 `^#?(?:终末地|zmd)` 开头（允许无 `#` 触发）。
- 如果出现“和其它插件重复触发/冲突”，优先检查并调整各 `apps/*.js` 的 `rule.reg` 前缀与关键字。

## 数据持久化与隐私（打包/迁移注意）

敏感绑定信息不在插件目录内，而在 Redis 中；但插件目录内仍可能产生“用户上传/缓存”文件：

- `plugins/enduid-yunzai/data/strategyimg/`：攻略资源与 `index.json`（可能包含用户上传内容/图片）。
- `process.cwd()/temp/enduid-yunzai/`：登录二维码临时 PNG。

主要 Redis Key（排查/迁移用）：
- `Yz:EndUID:User:<userId>`：账号列表/active/autoSign
- `Yz:EndUID:Users`：已绑定用户集合
- `Yz:EndUID:AutoSignUsers`：开启自动签到用户集合
- `Yz:EndUID:Token:<md5(cred)>`：短期 token 缓存
- `Yz:EndUID:CardDetail:<userId>:<uid>`：卡片详情缓存
- `Yz:EndUID:AliasMap`：别名库
- `Yz:EndUID:Ann:SubGroups` / `Yz:EndUID:Ann:SeenIds`：公告订阅群/已读集合
- `Yz:EndUID:SignStats:<YYYY-MM-DD>`：签到统计
- `Yz:EndUID:StrategyUpload:<userId>`：攻略上传会话缓存

## Git 提交流程（维护约定）

本插件独立仓库：`https://github.com/Anon-deisu/zmd-plugin`

规则：每次代码改动结束后，都要在插件目录执行一次“提交 + 推送”。

1) 检查改动范围：`git status` / `git diff`
2) 暂存：`git add -A`
3) 自动生成提交信息（提交名 + 小标题）：
   - 提交名（第一行，<= 50 字）：`<type>(<scope>): <一句话总结>`
      - `type`：`feat` / `fix` / `refactor` / `docs` / `chore`
      - `scope`：例如 `gachalog` / `wiki` / `login` / `resource` / `core`
      - 标题（冒号后“一句话总结”）尽量使用中文，避免英文。
   - 小标题（第二段第一行）：`<scope>: <更具体说明>`
   - 需要时在正文补充要点（`-` 列表），避免长篇。
4) 提交：`git commit -m "<提交名>" -m "<小标题>\n\n- ..."`
5) 推送：`git push origin main`

注意：
- 禁止提交任何 `data/` 下的用户数据（已由 `.gitignore` 排除）。
- 不要提交 agent 文件（例如 `AGENTS.md`）。注意：就算 `.gitignore` 写了 `AGENTS.md`，如果它曾经被 git 跟踪（tracked），改动仍会被 `git add -A` 暂存。
  - 最稳妥：只 add 需要的文件，避免 `git add -A`。
    - 例：`git add -- README.md`
    - 例：`git add -- apps model resources index.js package.json`
  - 如果不小心 `git add -A` 了：用 `git restore --staged AGENTS.md`（或 `git reset AGENTS.md`）把它从暂存区移除，再 `git status` 复核。
  - 仅本地生效的防误提方式：`git update-index --skip-worktree AGENTS.md`（恢复：`git update-index --no-skip-worktree AGENTS.md`）。

### 实际提交流程（示例）

在插件目录执行（不要在上级 TRSS-Yunzai 仓库里提交）：

```bash
cd C:\msys64\home\yuyu\TRSS_AllBot\TRSS-Yunzai\plugins\enduid-yunzai

# 1) 确认仓库/分支/远端
git rev-parse --show-toplevel
git status -sb
git remote -v

# 2) 看清改动
git diff

# 3) 只暂存要提交的文件（避免把 AGENTS.md 等本地文件带上）
# docs 示例：
git add -- README.md

# 4) 提交
git commit -m "docs: 更新 README"

# 5) 推送（已设置 upstream 时直接 git push 即可）
git push

# 可选：确认与远端是否同步
git rev-list --left-right --count origin/main...main
```
