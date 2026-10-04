# dsh-godot-play

在 **DeepSeek Harness Web GUI** 里**一键构建并试玩多个 Godot Web 导出**的插件，装完即用、零外部进程。

- 浏览器半区：右下角浮动「▶ 试玩游戏」面板，目标自动跟随当前工作区（老客户端才显示「项目」下拉），
  内含「🔄 构建并加载」按钮、状态芯片与构建日志；
- 宿主（Node）半区：注入 `webServer` / `subprocess` / `webRuntime` / `workspaceRegistry`
  四个宿主服务，直接以 `ctx.subprocess.spawn` 运行 `godot --headless --export-release`，
  并把当前项目的 `web/` 导出以**同源前缀路由**静态托管（响应带 cross-origin isolation 头）。

> 不需要 python、不需要独立端口、不需要任何常驻 sidecar。架构参照社区同构插件
> [dsh-web-shell](https://github.com/JesmonX/dsh-web-shell) 的宿主半区模式。

## 特性

- **工作区门控**：只在**客户端当前工作区确实是 Godot 项目**（目录里有 `project.godot`）时才显示右下角入口按钮；
  切到非 Godot 工作区（比如插件仓库本身）按钮自动收起。判定走宿主 `GET /api/godot-play/probe`
  ——浏览器半区碰不到文件系统，拿不到答案就**退回常显**，绝不会让按钮凭空消失（见下「工作区门控与目标跟随」）；
- **目标跟随工作区**：构建与托管的目标就是**当前工作区**（面板里不再有「项目」下拉）——
  跟着 DSH 侧栏切换工作区，就等于切换项目；
- **多项目（老客户端回退）**：拿不到工作区服务时（DSH 0.1.x / 未装新版宿主半区），
  面板回退成「项目」下拉 + 「＋」手动登记，行为与 0.4.0 一致；
- **目标优先级**：config `projectRoot`（锁定）> 当前工作区（跟随，内存态）> 上次选择（持久化到 `~/.dsh/dsh-godot-play.json`）> 最新创建的 Godot 工作区 > 从 dsh 工作目录向上找 `project.godot` > 工作目录本身；
- **随手控制**：「↻ 重新启动」带缓存戳重载当前游戏 iframe（不重新构建）；「清空日志」把宿主内存尾环与屏幕显示一起清掉（构建进行中也可清，新输出照常追加）；
- 纯 DOM，零框架依赖；iframe 懒加载；构建日志尾环；幂等安装/卸载脚本。

## 前置（用户责任）

1. 本机安装 Godot，且装好 **Web 导出模板**；
2. 目标 Godot 项目里存在 **Web 导出预设**（编辑器：项目 → 导出 → 添加… → Web，并保存）。
   插件**自动跟随该预设的 `export_path` 目录**（取其在 `export_presets.cfg` 里声明的输出目录，
   写入 `index.html`），不再要求与 `webRel` 手工对齐；也可用 `config.webRel` 显式覆盖
   （默认兜底 `<项目>/web`）。

## 安装

```sh
# 官方插件 CLI（已在 npm 发布）
dsh plugin --profile <profile> add dsh-godot-play

# 本地开发：直接指向仓库目录（改完代码重启即生效，无需重装）
dsh plugin --profile <profile> add /path/to/dsh-godot-play

# 或手动装入（等价动作，见包内 install.sh）
bash install.sh                    # 默认 profile ~/.dsh/profiles/web
```

> `<profile>` 例：`web`（`dsh web`）或 `desktop`（桌面端）。
> **桌面端用的是保留 profile，CLI 要求先完全退出桌面端**再执行，否则会撞上 profile 的文件锁。

装完**重启对应的 dsh** 生效（会话有持久化，可恢复）。

## 使用

1. 在当前工作区是 Godot 项目时，GUI 右下角出现「▶ 试玩游戏」按钮（非 Godot 工作区不显示，见「工作区门控与目标跟随」），点它打开面板；
2. 目标**自动就是当前工作区**（面板显示「跟随工作区：<项目名>」）；换项目 = 在 DSH 侧栏换工作区。
   老客户端没有工作区服务时，这里会显示「项目」下拉 +「＋」手动登记；
3. 点「🔄 构建并加载」：状态芯片显示进度，展开「日志」看 Godot 输出；
4. 成功后 iframe 自动带缓存戳重载，直接试玩；切换工作区时目标与 iframe 一起跟随；
5. 想重新开始当前游戏点「↻ 重新启动」（只重载游戏，不重新构建）；点「清空日志」清掉构建日志（构建中也可清）。

## 宿主接口（同源路由）

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/godot-play/workspaces` | GET | Godot 项目候选列表（来自 workspaceRegistry，含 current/pinned） |
| `/api/godot-play/workspaces/add` | POST | 登记一个项目目录（`{path}`，须含 project.godot） |
| `/api/godot-play/target` | POST | 切换目标项目（`{path}`；config 锁定时返回 400）——老客户端的「项目」下拉用 |
| `/api/godot-play/follow` | POST | 浏览器半区报告「当前工作区是这里」，目标跟随它（`{path}`；内存态不持久化，config 锁定时回 `{pinned:true}`） |
| `/api/godot-play/build` | POST | 对当前目标触发构建（单飞，构建中返回 409） |
| `/api/godot-play/status` | GET | 状态 + 日志尾环（轮询即进度；含 `source` = pinned/follow/last/auto） |
| `/api/godot-play/logs/clear` | POST | 清空内存中的构建日志尾环（构建中也可清，新输出照常追加） |
| `/api/godot-play/meta` | GET | 就绪探测（project / source / webReady / godot / preset / workspaceGate） |
| `/api/godot-play/probe` | GET | 工作区探测：`?path=<目录>` → `{path, isGodot}`（入口按钮显隐用，只读） |
| `/dsh-godot-play/web/*` | GET | 静态托管当前目标的 `web/` 导出（带 COEP/COOP 头） |

> 注：webServer 的 exact 路由按 (kind,path) 唯一、不区分 HTTP 方法，POST 动作因此用独立路径。

## 配置（cordis.patch.yml 的 `config`，默认全自动）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `projectRoot` | 空（动态） | 留空 = 跟随当前工作区 + 智能默认；填写 = **锁定**目标（关闭跟随，面板显示「config 锁定：<项目>」） |
| `godotBin` | 自动探测 | `GODOT` 环境变量 → macOS 默认安装路径 → `PATH` |
| `exportPreset` | 自动 | 从 `export_presets.cfg` 找首个 `platform=="Web"` 预设（优先 runnable） |
| `webRel` | 空（自动） | 显式填写 = 覆盖输出目录（相对目标项目根）；留空 = 自动跟随 Web 预设的 `export_path` 目录，解析不出时兜底 `web` |
| `importFirst` | `true` | 导出前先跑一次 `--import` 保证缓存就绪 |
| `graceMs` | `10000` | 进程终止宽限（毫秒） |
| `allowRemote` | `false` | 非 loopback 也放行（远程访问 GUI 时按需开启） |
| `workspaceGate` | `true` | 只在「当前工作区是 Godot 项目」时显示入口按钮；置 `false` = 任何工作区都常显 |

上次选择的项目记录在 `~/.dsh/dsh-godot-play.json`（可安全删除，回退到智能默认）。

## 工作区门控与目标跟随

两件事都建立在同一个前提上：**浏览器半区能读到客户端当前工作区**。

**① 入口按钮显隐**（宿主 `workspaceGate`，默认开）：

- **当前工作区怎么来**：浏览器半区读客户端服务 `ctx.get("sessions").list`（当前会话）与
  `ctx.get("workspaces").list`（工作区 `path` / `sessionIds`）；
  新客户端（0.2.x）用主视图保留位 `retainedBy.mainView` 标记当前会话，老客户端（0.1.x）回落 `list.current`；
- **是不是 Godot 项目**：只有宿主答得了（浏览器碰不到文件系统），故有只读端点
  `GET /api/godot-play/probe?path=…`，判据就是该目录里有 `project.godot`（与
  `/workspaces` 候选的过滤口径一致）；
- **绝不把按钮等没**：以下任何一种情况都退回**常显**（等于旧行为）——
  宿主半区没装 / 答不出 `workspaceGate`（旧宿主）/ `/probe` 不可达 /
  客户端没有上述服务（`ctx.inject` 起 3 秒兜底）/ `config.workspaceGate: false`。
  反过来，没有当前会话（空态）时会隐藏按钮；
- **切换即时生效**：订阅两个快照 store（每帧批量通知），切工作区即重算；同一路径的探测结果带缓存。

**② 目标跟随**（无需配置，有工作区服务就启用）：

- 浏览器半区把当前工作区 `POST /api/godot-play/follow`，宿主的构建与静态托管就以它为准
  （优先级：`projectRoot` 锁定 > 跟随 > 上次选择 > 智能默认）；
- 因此**「项目」下拉与「＋」登记在跟随模式下整段隐藏**——项目由工作区决定，再选一次是多余的；
  换项目 = 在 DSH 侧栏换工作区（`changed=true` 时浏览器半区顺带重载 iframe）；
- 跟随只写宿主内存，**不覆盖** `~/.dsh/dsh-godot-play.json` 里持久化的手动选择，页面关掉后自然失效；
- `config.projectRoot` 锁定时宿主回 `{pinned:true}`，浏览器半区停手上报并显示「config 锁定：<项目>」；
- 老客户端（没有工作区服务）不会进入跟随模式：面板保留原来的「项目」下拉，走 `/target` 手动切换。

> 规则是「**工作区目录本身**含 `project.godot`」。若你把工作区登记在 Godot 项目的某个子目录下，
> 按钮不会显示——把 Godot 项目根目录本身登记为工作区（DSH 侧栏的工作区选择器），
> 或在 `cordis.patch.yml` 里用 `workspaceGate: false` 关掉门控。

## 安全

- `/api/godot-play/*` 写操作带信任围栏：loopback 直通；远端地址须命中
  `ctx.webRuntime.trustedHosts` 或显式开启 `allowRemote`。
- 无任意命令执行面：argv 由插件按固定顺序拼接（仅 Godot 导出参数），不透传用户命令。
- 静态托管有路径穿越防护，只服务当前目标导出目录内文件（目录由 `webRel` / 预设 `export_path` 决定）。

## 跨域隔离说明

Godot 4 Web 导出若开了线程，需要 iframe 文档具备 cross-origin isolation
（响应头已带 `Cross-Origin-Embedder-Policy: require-corp`）。若游戏在同源 iframe 内
无法启动（控制台报 SharedArrayBuffer / crossOriginIsolated 相关错误），可：

1. 在导出预设里关闭线程（单线程构建无需 COI）；或
2. 用 `window.__GODOT_PLAY_URL__`（插件加载前注入）把 iframe 指向外部带 COI 头的托管服务。

## 开发与测试

本插件无需构建链（浏览器半区手写 lazy-CJS factory 格式，直接可加载）。

```sh
node --check lib/index.js && node --check lib/client.js   # 语法
node tests/host-smoke.mjs                                  # 宿主端到端冒烟（stub ctx，跑假 Godot，68 断言；Windows 下子进程 e2e 段 14 条需 bash，见下）
```

断言基线：Windows 上 `32/46` → 现状 `54/68`，失败的是同一批 14 条子进程 e2e（假 Godot 走 `.cmd` +
`shell: true` 那段），非改动引入；Linux/macOS 上应为全绿。浏览器半区（门控 + 跟随）另有一份临时
VM 冒烟（stub DOM / fetch / cordis ctx，29 条）用于开发期验证，未入库。

## License

MIT © Pidan Workshop
