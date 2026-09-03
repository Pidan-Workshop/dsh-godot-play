# dsh-godot-play

在 **DeepSeek Harness Web GUI**（dsh web）里直接运行 **Godot Web 导出**的客户端插件：
右下角浮动「▶ 试玩游戏」按钮 → 弹出可缩放 iframe 面板，加载本机托管的 Godot Web 构建。

> 插件本身不绑定具体游戏：加载地址可通过注入全局变量覆盖（见「配置」）。
> 默认地址指向牛马传奇（合成）的 Web 导出，也是本项目当前的主要用途。

## 特性

- 纯 DOM 挂载，零 React / 框架依赖，一个按钮 + 一个 iframe 面板。
- iframe 按需懒加载：点击「试玩游戏」才创建，收起不销毁。
- 幂等安装/卸载脚本（`install.sh` / `uninstall.sh`），支持多 profile。

## 结构

```
dsh-godot-play/
  package.json            ← dsh.client 声明（浏览器半区元数据）
  lib/index.js            ← 宿主（Node）半区：空 apply，仅作 cordis 加载器条目
  lib/client.js           ← 浏览器半区：__ModuleLoader__ 注册 + apply/inject
  cordis.patch.yml        ← 加载器条目样例（install.sh 会自动处理）
  install.sh              ← 一键装入 DSH profile（幂等）
  uninstall.sh            ← 卸载包本体
```

## 前置

1. 一份 **Godot Web 导出**（如 `web/index.html`），由本机静态服务托管。
   Godot 4 Web 构建硬性要求响应头带跨域隔离，否则运行时报
   `Cross-Origin Isolation / SharedArrayBuffer` 错误：
   - `Cross-Origin-Opener-Policy: same-origin`
   - `Cross-Origin-Embedder-Policy: require-corp`
   - `.wasm` 的 MIME 类型为 `application/wasm`

   最小托管示例（在导出目录的上一级执行）：

   ```bash
   python3 - <<'PY'
   import http.server, functools
   Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory="web")
   class H(Handler):
       def end_headers(self):
           self.send_header("Cross-Origin-Opener-Policy", "same-origin")
           self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
           super().end_headers()
   http.server.ThreadingHTTPServer(("127.0.0.1", 8090), H).serve_forever()
   PY
   ```

2. dsh web 本体（本插件只对 DeepSeek Harness 的浏览器运行器有意义）。

## 安装（装入 DSH profile，一次性）

```bash
bash install.sh                                  # 默认 profile：~/.dsh/profiles/web
DSH_PROFILE_DIR=~/.dsh/profiles/dev bash install.sh   # 指定其它 profile
```

脚本做两件事（均幂等，可重复执行）：

1. 把 `package.json` + `lib/` 拷到 `$PROFILE/node_modules/dsh-godot-play`；
2. 确保 `$PROFILE/cordis.patch.yml` 含 `id: godot-play` 的加载器条目。

装完**重启 dsh web** 生效（会话有持久化，可恢复）。

> 注意：profile 里执行 `pnpm install` 会清掉手工放置的包，重装依赖后重跑
> `bash install.sh` 即可（或改用 symlink 指向仓库源码）。

## 配置

默认加载地址 `http://127.0.0.1:8090/`。需要在**插件加载前**注入覆盖：

```js
window.__GODOT_PLAY_URL__ = "http://127.0.0.1:8080/";
```

## 验证

- 重启后，页面 `window.__DSH_BOOT__.entries` 应包含 `dsh-godot-play`，
  且 `/plugins/dsh-godot-play/client.js` 可访问（具体路径前缀以宿主为准）。
- 右下角出现「▶ 试玩游戏」按钮即挂载成功；点击后面板应加载 Godot Web 导出。

## License

MIT © suoyike
