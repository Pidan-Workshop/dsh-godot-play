/**
 * dsh-godot-play —— 浏览器半区。
 *
 * 自包含、零框架依赖：右下角浮动「▶ 试玩游戏」按钮 + 可缩放面板。
 * 面板内：
 *   - iframe 加载宿主同源托管的 Godot Web 导出（默认 /dsh-godot-play/web/index.html）；
 *   - 「🔄 构建并加载」调用宿主 POST /api/godot-play/build，轮询 status 显示日志，
 *     构建成功后带缓存戳重载 iframe。
 *
 * 与 dsh 官方 client 插件同构：window.__ModuleLoader__.load 注册模块，
 * 导出 apply(ctx)/inject 供浏览器 cordis 运行器挂载。
 */
window.__ModuleLoader__.load({
	id: "dsh-godot-play",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var ROOT_ID = "dsh-godot-play-root";
		var API_BASE = "/api/godot-play";
		var WEB_PATH = "/dsh-godot-play/web/index.html";
		// 兼容旧注入：外部托管地址（完整 URL）仍可覆盖 iframe 指向
		var GAME_URL = (typeof window !== "undefined" && window.__GODOT_PLAY_URL__)
			? window.__GODOT_PLAY_URL__
			: (window.location.origin + WEB_PATH);

		var STATUS_POLL_MS = 600;

		// ── 轻量状态 ─────────────────────────────────────────────
		var ui = null;        // mountUi 后持有全部节点
		var buildState = "idle"; // idle | running | done | error
		var pollTimer = null;

		function mount() {
			if (typeof document === "undefined") return;
			if (document.getElementById(ROOT_ID) !== null) return; // 幂等
			mountUi();
			refreshStatus(true);
		}

		// ── 宿主接口 ─────────────────────────────────────────────
		function fetchJson(url, options) {
			return fetch(url, options).then(function (r) {
				return r.json().catch(function () { return {}; });
			});
		}

		function apiStatus() {
			return fetchJson(API_BASE + "/status", { cache: "no-store" });
		}

		function apiBuild() {
			return fetch(API_BASE + "/build", { method: "POST", cache: "no-store" }).then(function (r) {
				if (r.status === 202) return { ok: true };
				return r.json().then(function (j) { return { ok: false, error: (j && j.error) || ("HTTP " + r.status) }; });
			});
		}

		function setChip(state, text, failed) {
			if (!ui) return;
			ui.chip.dataset.state = state;
			ui.chip.textContent = text;
			ui.chip.classList.toggle("failed", !!failed);
		}

		function setLog(text) {
			if (!ui) return;
			ui.log.textContent = text || "";
			ui.log.scrollTop = ui.log.scrollHeight;
		}

		function renderStatus(j) {
			if (!j) return;
			buildState = j.state || "idle";
			if (j.project && ui && ui.proj) {
				ui.proj.textContent = "项目：" + j.project;
				ui.proj.title = j.project;
			}
			if (j.logTail) setLog(j.logTail);
			switch (buildState) {
				case "running":
					setChip("running", "⏳ 构建中…", false);
					break;
				case "done":
					setChip("done", j.webReady ? "✅ 构建成功 · 可试玩" : "⚠️ 构建完成但未产出 web/index.html", j.webReady ? false : true);
					break;
				case "error":
					setChip("error", "❌ 构建失败" + (j.exitCode != null ? "（exit " + j.exitCode + "）" : ""), true);
					break;
				default:
					setChip("idle", j.webReady ? "● 已就绪 · 可试玩" : "○ 未构建（点「构建并加载」）", false);
			}
			if (buildState === "running" && pollTimer === null) {
				startPoll();
			} else if (buildState !== "running" && pollTimer !== null) {
				stopPoll();
				if (buildState === "done") reloadFrame();
			}
		}

		function startPoll() {
			stopPoll();
			pollTimer = setInterval(function () {
				apiStatus().then(renderStatus).catch(function () {
					setChip("error", "⚠️ 宿主服务未响应", true);
					stopPoll();
				});
			}, STATUS_POLL_MS);
		}
		function stopPoll() {
			if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
		}

		function clickBuild() {
			if (buildState === "running") return;
			setChip("running", "⏳ 发起构建…", false);
			if (!ui) return;
			ui.logWrap.hidden = false;
			apiBuild().then(function (r) {
				if (!r.ok) {
					setChip("error", "❌ 无法启动构建：" + (r.error || "宿主服务未就绪？请重启 dsh web"), true);
					return;
				}
				apiStatus().then(renderStatus).catch(function () {});
			}).catch(function () {
				setChip("error", "❌ 请求失败：宿主 /api/godot-play 不可达（插件加载后需重启 dsh web 生效）", true);
			});
		}

		function toggleLog() {
			if (ui) ui.logWrap.hidden = !ui.logWrap.hidden;
		}

		function reloadFrame() {
			if (!ui || !ui.frame) return;
			ui.frame.src = GAME_URL + (GAME_URL.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
		}

		function ensureFrame() {
			if (!ui || ui.frame !== null) return;
			var busy = document.createElement("div");
			busy.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa3ad;font-size:13px;background:#14181c;";
			busy.textContent = "加载中：" + GAME_URL + " …";
			ui.frameWrap.appendChild(busy);
			var frame = document.createElement("iframe");
			frame.src = GAME_URL;
			frame.setAttribute("allow", "fullscreen");
			frame.addEventListener("load", function () {
				if (busy.parentNode === ui.frameWrap) ui.frameWrap.removeChild(busy);
			});
			ui.frameWrap.appendChild(frame);
			ui.frame = frame;
		}

		/** 打开/挂载时探一次状态：决定按钮文案与可用性。 */
		function refreshStatus(silent) {
			apiStatus().then(renderStatus).catch(function () {
				if (!silent) setChip("error", "⚠️ 宿主服务未就绪（插件加载后需重启 dsh web）", true);
			});
		}

		// ── UI ───────────────────────────────────────────────────
		function mountUi() {
			var style = document.createElement("style");
			style.dataset.plugin = "dsh-godot-play";
			style.textContent = [
				"#" + ROOT_ID + " * { box-sizing: border-box; }",
				"#" + ROOT_ID + " { position: fixed; right: 14px; bottom: 14px; z-index: 2147483000; font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; }",
				"#" + ROOT_ID + " .panel { display: none; flex-direction: column; width: min(880px, calc(100vw - 40px)); height: min(680px, calc(100vh - 90px)); background: #14181c; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; }",
				"#" + ROOT_ID + ".open .panel { display: flex; }",
				"#" + ROOT_ID + " .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #1e242b; color: #e6e9ed; font-size: 12px; }",
				"#" + ROOT_ID + " .bar .dot { width: 8px; height: 8px; border-radius: 50%; background: #58c07f; }",
				"#" + ROOT_ID + " .bar .title { flex: 1; }",
				"#" + ROOT_ID + " .bar .hint { color: #9aa3ad; }",
				"#" + ROOT_ID + " .tools { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #1a2027; border-bottom: 1px solid rgba(255,255,255,.08); font-size: 12px; }",
				"#" + ROOT_ID + " .chip { padding: 3px 10px; border-radius: 999px; background: #262e37; color: #9aa3ad; }",
				"#" + ROOT_ID + " .chip[data-state=running] { background: #3a4a3a; color: #b7e0b7; }",
				"#" + ROOT_ID + " .chip[data-state=done] { background: #2e4633; color: #9ed2a4; }",
				"#" + ROOT_ID + " .chip[data-state=error] { background: #4a2f2f; color: #e0a5a5; }",
				"#" + ROOT_ID + " .chip.failed { outline: 1px solid rgba(224,120,120,.5); }",
				"#" + ROOT_ID + " .build { display: flex; align-items: center; gap: 4px; background: #58c07f; color: #10151a; border: 0; border-radius: 8px; padding: 4px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }",
				"#" + ROOT_ID + " .build:hover { filter: brightness(1.08); }",
				"#" + ROOT_ID + " .build:disabled { opacity: .55; cursor: default; filter: none; }",
				"#" + ROOT_ID + " .proj { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9aa3ad; text-align: right; }",
				"#" + ROOT_ID + " .btn-minor { background: #262e37; color: #c6cdd6; border: 0; border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }",
				"#" + ROOT_ID + " .log-wrap { display: flex; flex-direction: column; max-height: 140px; background: #0d1115; border-bottom: 1px solid rgba(255,255,255,.08); }",
				"#" + ROOT_ID + " .log { flex: 1; margin: 0; padding: 6px 10px; overflow: auto; color: #b7c3cc; font: 11px/1.5 'SF Mono', Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-all; }",
				"#" + ROOT_ID + " .frame-wrap { position: relative; flex: 1; background: #000; }",
				"#" + ROOT_ID + " iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }",
				"#" + ROOT_ID + " .fab { display: flex; align-items: center; gap: 6px; margin-left: auto; background: #58c07f; color: #10151a; font-size: 13px; font-weight: 600; border: 0; border-radius: 999px; padding: 8px 14px; cursor: pointer; box-shadow: 0 6px 18px rgba(88,192,127,.35); }",
				"#" + ROOT_ID + " .fab:hover { filter: brightness(1.08); }",
				"#" + ROOT_ID + ".open .fab { display: none; }",
				"#" + ROOT_ID + " .close { background: #262e37; color: #e6e9ed; border: 0; border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }"
			].join("\n");
			document.head.appendChild(style);

			var root = document.createElement("div");
			root.id = ROOT_ID;
			root.innerHTML = [
				'<div class="panel">',
				'  <div class="bar">',
				'    <span class="dot"></span>',
				'    <span class="title">Godot Web · 试玩</span>',
				'    <span class="hint">宿主同源托管</span>',
				'    <button class="close" type="button">收起</button>',
				'  </div>',
				'  <div class="tools">',
				'    <span class="chip" data-state="idle">…</span>',
				'    <span class="proj" title=""></span>',
				'    <button class="build" type="button">🔄 构建并加载</button>',
				'    <button class="btn-minor log-toggle" type="button">日志</button>',
				'  </div>',
				'  <div class="log-wrap" hidden>',
				'    <pre class="log"></pre>',
				'  </div>',
				'  <div class="frame-wrap"></div>',
				'</div>',
				'<button class="fab" type="button">▶ 试玩游戏</button>'
			].join("");
			document.body.appendChild(root);

			ui = {
				root: root,
				chip: root.querySelector(".chip"),
				proj: root.querySelector(".proj"),
				buildBtn: root.querySelector(".build"),
				log: root.querySelector(".log"),
				logWrap: root.querySelector(".log-wrap"),
				frameWrap: root.querySelector(".frame-wrap"),
				frame: null
			};

			root.querySelector(".fab").addEventListener("click", function () {
				root.classList.add("open");
				refreshStatus(false);
				ensureFrame();
			});
			root.querySelector(".close").addEventListener("click", function () {
				root.classList.remove("open");
			});
			ui.buildBtn.addEventListener("click", clickBuild);
			root.querySelector(".log-toggle").addEventListener("click", toggleLog);
		}

		/** 浏览器 cordis 插件体：挂载浮动试玩面板（纯 DOM，无框架依赖）。 */
		function apply() {
			if (typeof document !== "undefined") {
				if (document.readyState === "loading") {
					document.addEventListener("DOMContentLoaded", mount);
				} else {
					mount();
				}
			}
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});
