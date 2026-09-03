/**
 * dsh-godot-play —— 浏览器半区。
 *
 * 自包含、零 React 依赖：挂一个右下角浮动「试玩游戏」按钮 + 可缩放
 * iframe 面板，iframe 指向本机托管的 Godot Web 导出
 * （默认 http://127.0.0.1:8090/，可在插件加载前注入全局
 * window.__GODOT_PLAY_URL__ 覆盖地址）。
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
		var GAME_URL = (typeof window !== "undefined" && window.__GODOT_PLAY_URL__)
			? window.__GODOT_PLAY_URL__
			: "http://127.0.0.1:8090/";

		function mount() {
			if (typeof document === "undefined") {
				return;
			}
			if (document.getElementById(ROOT_ID) !== null) {
				return; // 幂等：避免重复挂载
			}
			mountUi();
		}

		function mountUi() {

			var style = document.createElement("style");
			style.dataset.plugin = "dsh-godot-play";
			style.textContent = [
				"#" + ROOT_ID + " * { box-sizing: border-box; }",
				"#" + ROOT_ID + " { position: fixed; right: 14px; bottom: 14px; z-index: 2147483000; font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; }",
				"#" + ROOT_ID + " .panel { display: none; flex-direction: column; width: min(880px, calc(100vw - 40px)); height: min(620px, calc(100vh - 90px)); background: #14181c; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; }",
				"#" + ROOT_ID + ".open .panel { display: flex; }",
				"#" + ROOT_ID + " .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #1e242b; color: #e6e9ed; font-size: 12px; }",
				"#" + ROOT_ID + " .bar .dot { width: 8px; height: 8px; border-radius: 50%; background: #58c07f; }",
				"#" + ROOT_ID + " .bar .title { flex: 1; }",
				"#" + ROOT_ID + " .bar .hint { color: #9aa3ad; }",
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
				'    <span class="hint">iframe · 本机静态服务</span>',
				'    <button class="close" type="button">收起</button>',
				'  </div>',
				'  <div class="frame-wrap"></div>',
				'</div>',
				'<button class="fab" type="button">▶ 试玩游戏</button>'
			].join("");
			document.body.appendChild(root);

			var open = false;
			var frameWrap = root.querySelector(".frame-wrap");

			function ensureFrame() {
				if (frameWrap.querySelector("iframe") !== null) {
					return;
				}
				var busy = document.createElement("div");
				busy.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa3ad;font-size:13px;background:#14181c;";
				busy.textContent = "加载中：" + GAME_URL + " …";
				frameWrap.appendChild(busy);
				var frame = document.createElement("iframe");
				frame.src = GAME_URL;
				frame.setAttribute("allow", "fullscreen");
				frame.addEventListener("load", function () {
					if (busy.parentNode === frameWrap) {
						frameWrap.removeChild(busy);
					}
				});
				frameWrap.appendChild(frame);
			}

			root.querySelector(".fab").addEventListener("click", function () {
				open = true;
				root.classList.add("open");
				ensureFrame();
			});
			root.querySelector(".close").addEventListener("click", function () {
				open = false;
				root.classList.remove("open");
			});
		}

		/** 浏览器 cordis 插件体：挂载浮动试玩画布（纯 DOM，无服务依赖）。 */
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
