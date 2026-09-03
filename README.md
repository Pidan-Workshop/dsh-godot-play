# dsh-godot-play

在 **DeepSeek Harness Web GUI** 里**一键构建并试玩 Godot Web 导出**的插件，装完即用、零外部进程。

- 浏览器半区：右下角浮动「▶ 试玩游戏」面板，内含「🔄 构建并加载」按钮、状态芯片与构建日志；
- 宿主（Node）半区：注入 `webServer` / `subprocess` / `webRuntime` 三个宿主服务，直接以
  `ctx.subprocess.spawn` 运行 `godot --headless --export-release`，并把 `web/` 导出以
  **同源前缀路由**静态托管（响应带 cross-origin isolation 头）。

> 不需要 python、不需要独立端口、不需要任何常驻 sidecar。架构参照社区同构插件
> [dsh-web-shell](https://github.com/JesmonX/dsh-web-shell) 的宿主半区模式。

## 前置（用户责任）

1. 本机安装 Godot，且装好 **Web 导出模板**；
2. 目标 Godot 项目里存在 **Web 导出预设**（编辑器：项目 → 导出 → 添加… → Web，并保存）；
3. 项目导出预设的输出目标与插件配置的 `webRel`（默认 `web`，即 `<项目>/web/index.html`）匹配。

> 唯一的前置就是这些：装完插件即可在 GUI 里点按钮构建，无需额外安装脚本或服务。

## 安装

插件随包自带 `dsh.bundle` patch（宿主行）与 `dsh.client`（浏览器半区），一条行即可挂全。

```sh
# 推荐：官方插件 CLI（npm 发布后）
dsh plugin --profile web add dsh-godot-play

# 本地开发：直接指向仓库目录
dsh plugin --profile web add /path/to/dsh-godot-play

# 或手动装入（等价动作，见 install.sh）
bash install.sh                    # 默认 profile ~/.dsh/profiles/web
```

装完**重启 dsh web** 生效（会话有持久化，可恢复）。

## 使用

1. GUI 右下角「▶ 试玩游戏」打开面板；
2. 点「🔄 构建并加载」：状态芯片显示构建进度，展开「日志」可看 Godot 输出；
3. 成功后 iframe 自动带缓存戳重载，直接试玩。

## 宿主接口（同源路由）

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/godot-play/build` | POST | 触发构建（单飞，构建中重复请求返回 409） |
| `/api/godot-play/status` | GET | 状态 + 日志尾环（轮询即进度） |
| `/api/godot-play/meta` | GET | 就绪探测（webReady / godot / preset） |
| `/dsh-godot-play/web/*` | GET | 静态托管 `web/` 导出（带 COEP/COOP 头） |

## 配置（cordis.patch.yml 的 `config`，默认全自动）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `projectRoot` | dsh 进程工作目录 | Godot 项目根；多项目场景在此覆盖 |
| `godotBin` | 自动探测 | `GODOT` 环境变量 → macOS 默认安装路径 → `PATH` |
| `exportPreset` | 自动 | 从 `export_presets.cfg` 找首个 `platform=="Web"` 预设（优先 runnable） |
| `webRel` | `web` | 导出输出目录（相对 projectRoot） |
| `importFirst` | `true` | 导出前先跑一次 `--import` 保证缓存就绪 |
| `graceMs` | `10000` | 进程终止宽限（毫秒） |
| `allowRemote` | `false` | 非 loopback 也放行（远程访问 GUI 时按需开启） |

## 安全

- `/api/godot-play/*` 写操作带信任围栏：loopback 直通；远端地址须命中
  `ctx.webRuntime.trustedHosts` 或显式开启 `allowRemote`。
- 无任意命令执行面：argv 由插件按固定顺序拼接（仅 Godot 导出参数），不透传用户命令。
- 静态托管做了路径穿越防护，只服务 `webRel` 目录内文件。

## 跨域隔离说明

Godot 4 Web 导出若开了线程，需要 iframe 文档具备 cross-origin isolation
（响应头已带 `Cross-Origin-Embedder-Policy: require-corp`）。若游戏在该同源 iframe 内
无法启动（控制台报 SharedArrayBuffer / crossOriginIsolated 相关错误），可：

1. 在导出预设里关闭线程（单线程构建无需 COI）；或
2. 用 `window.__GODOT_PLAY_URL__`（插件加载前注入）把 iframe 指向外部带 COI 头的托管服务。

## 开发与测试

本插件无需构建链（浏览器半区手写 lazy-CJS factory 格式，直接可加载）。

```sh
node --check lib/index.js && node --check lib/client.js   # 语法
node tests/host-smoke.mjs                                  # 宿主端到端冒烟（stub ctx，跑假 Godot）
```

## License

MIT © Pidan Workshop
