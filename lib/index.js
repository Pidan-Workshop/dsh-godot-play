/**
 * dsh-godot-play —— 宿主半区（Node）。
 *
 * 社区同构实现（参照 dsh-web-shell 模式）：真正的 apply 注入
 * webServer / subprocess / webRuntime 三个宿主服务，挂同源路由：
 *
 *   POST /api/godot-play/build    → 触发 Godot Web 导出（ctx.subprocess.spawn）
 *   GET  /api/godot-play/status   → 构建状态 + 日志增量轮询
 *   GET  /api/godot-play/meta     → 就绪探测（客户端启动用）
 *   GET  /dsh-godot-play/web/*    → 静态托管 web/ 导出（带 cross-origin isolation 头）
 *
 * 浏览器半区同源 fetch，装完即用：无需 python、无需额外端口/进程。
 * 「用户自己装好 Godot + Web 导出模板 + 项目里有 Web 导出预设」是唯一前置。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 稳定插件名（与 cordis.patch.yml 的行 id 一致）。 */
export const name = "godot-play";
/** 宿主服务依赖。 */
export const inject = ["webServer", "subprocess", "webRuntime"];

const API_BASE = "/api/godot-play";
const WEB_PREFIX = "/dsh-godot-play/web";
const LOG_CAP_BYTES = 256 * 1024;      // 内存日志尾环
const COLLECT_CAP_BYTES = 128 * 1024;  // 每路 stdout/stderr 采集上限
const POLL_MS = 250;                   // 运行中把采集流搬进日志尾环的节奏

// ── 配置（cordis.patch.yml 的 config 合并后传入）───────────────────────────
function normalizeConfig(config) {
	return {
		// 项目根：默认取 dsh 进程的工作目录；多项目可在此覆盖
		projectRoot: path.resolve(config?.projectRoot ?? process.cwd()),
		// 导出输出相对目录（Godot Web 预设的 target 需与之匹配）
		webRel: config?.webRel ?? "web",
		// 空 = 自动从 export_presets.cfg 找首个 platform=="Web" 的预设
		exportPreset: config?.exportPreset ?? "",
		// 空 = 自动探测（GODOT 环境变量 → macOS 默认安装路径 → PATH）
		godotBin: config?.godotBin ?? "",
		// 导出前先跑一次 --import（保证 .godot 缓存/UID 就绪）
		importFirst: config?.importFirst !== false,
		graceMs: config?.graceMs ?? 10_000,
		// 非 loopback 也放行（局域网访问 GUI 时按需开启；默认 false）
		allowRemote: config?.allowRemote ?? false
	};
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
/** 日志尾环：只留最近 cap 字节，避免无限增长。 */
class Tail {
	constructor(cap) { this.cap = cap; this.buf = ""; }
	append(chunk) {
		if (!chunk) return;
		this.buf += chunk;
		if (this.buf.length > this.cap) this.buf = this.buf.slice(this.buf.length - this.cap);
	}
	get text() { return this.buf; }
}

/** 候选 Godot 可执行文件：绝对路径直接验存在，裸命令走 ctx.subprocess.resolveExecutable。 */
function godotCandidates(cfg) {
	const list = [];
	if (cfg.godotBin) list.push(cfg.godotBin);
	if (process.env.GODOT) list.push(process.env.GODOT);
	if (process.platform === "darwin") list.push("/Applications/Godot.app/Contents/MacOS/Godot");
	if (process.platform === "win32") list.push("godot.exe");
	list.push("godot");
	return list;
}
function resolveGodot(ctx, cfg) {
	for (const cand of godotCandidates(cfg)) {
		if (path.isAbsolute(cand) || cand.includes("/") || cand.includes("\\")) {
			if (fs.existsSync(cand)) return cand;
			continue;
		}
		try {
			const r = ctx.subprocess?.resolveExecutable?.(cand);
			if (r) return r;
		} catch { /* 下一个候选 */ }
	}
	return null;
}

/** 从 export_presets.cfg 里找首个 platform=="Web" 的预设名（优先 runnable）。 */
function detectWebPreset(projectRoot, override) {
	if (override) return override;
	const file = path.join(projectRoot, "export_presets.cfg");
	if (!fs.existsSync(file)) return null;
	let text;
	try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
	const presets = [];
	let cur = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const sec = /^\[preset\.(\d+)\]$/.exec(line);
		if (sec) { cur = { name: null, platform: null, runnable: false }; presets.push(cur); continue; }
		if (!cur) continue;
		const mName = /^name\s*=\s*"?([^"\r\n]+?)"?$/.exec(line);
		const mPlat = /^platform\s*=\s*"?([^"\r\n]+?)"?$/.exec(line);
		const mRun = /^runnable\s*=\s*(true|false)\s*$/.exec(line);
		if (mName) cur.name = mName[1];
		else if (mPlat) cur.platform = mPlat[1];
		else if (mRun) cur.runnable = mRun[1] === "true";
	}
	const web = presets.filter((p) => p.platform === "Web" && p.name);
	if (web.length === 0) return null;
	return (web.find((p) => p.runnable) ?? web[0]).name;
}

/** 是否允许本次请求：loopback 直通；远端需命中 trustedHosts 或显式 allowRemote。 */
function isTrusted(ctx, req, cfg) {
	if (cfg.allowRemote) return true;
	const addr = req.socket?.remoteAddress ?? "";
	if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") return true;
	const hosts = ctx?.webRuntime?.trustedHosts;
	if (Array.isArray(hosts) && (hosts.includes(addr) || hosts.includes("*"))) return true;
	return false;
}

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".wasm": "application/wasm",
	".pck": "application/octet-stream",
	".json": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".woff2": "font/woff2"
};

function sendJson(res, status, body) {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(data)
	});
	res.end(data);
}

// ── 宿主入口 ────────────────────────────────────────────────────────────────
export function apply(ctx, config) {
	const cfg = normalizeConfig(config);
	const log = (msg) => { try { ctx?.logger?.info?.(msg); } catch { /* 忽略 */ } };

	// 构建状态机（单飞：同一时刻最多一个构建）
	const st = {
		state: "idle",          // idle | running | done | error
		log: new Tail(LOG_CAP_BYTES),
		exitCode: null,
		signal: null,
		godot: null,
		preset: null,
		startedAt: null,
		finishedAt: null,
		handle: null,           // 运行中的 subprocess handle
		stdoutOffset: 0,
		stderrOffset: 0
	};

	const webRoot = path.join(cfg.projectRoot, cfg.webRel);
	const outFile = path.join(webRoot, "index.html");

	/** 运行一步（import 或 export），stdout/stderr 以 collect 模式采集进日志尾环。 */
	function runStep(argv) {
		return new Promise((resolveStep) => {
			let handle;
			try {
				handle = ctx.subprocess.spawn({
					argv,
					cwd: cfg.projectRoot,
					stdio: {
						stdin: "ignore",
						stdout: { maxBytes: COLLECT_CAP_BYTES },
						stderr: { maxBytes: COLLECT_CAP_BYTES }
					},
					graceMs: cfg.graceMs
				});
			} catch (err) {
				st.log.append("✘ spawn 失败：" + (err?.message ?? String(err)) + "\n");
				resolveStep(false);
				return;
			}
			st.handle = handle;
			const drain = () => {
				const out = handle.collected?.stdout?.readFrom(st.stdoutOffset);
				if (out) {
					if (out.text) st.log.append(out.text);
					st.stdoutOffset = out.nextOffset;
				}
				const err = handle.collected?.stderr?.readFrom(st.stderrOffset);
				if (err) {
					if (err.text) st.log.append(err.text);
					st.stderrOffset = err.nextOffset;
				}
			};
			const iv = setInterval(drain, POLL_MS);
			handle.done
				.then((outcome) => {
					clearInterval(iv);
					drain(); // 收尾
					st.handle = null;
					st.exitCode = outcome.exitCode;
					st.signal = outcome.signal;
					if (outcome.exitCode === 0) {
						resolveStep(true);
					} else {
						st.log.append(`✘ 步骤失败 exit=${outcome.exitCode} signal=${outcome.signal ?? ""}\n`);
						resolveStep(false);
					}
				})
				.catch((err) => {
					clearInterval(iv);
					st.handle = null;
					st.log.append("✘ 执行错误：" + (err?.message ?? String(err)) + "\n");
					resolveStep(false);
				});
		});
	}

	async function startBuild() {
		st.state = "running";
		st.exitCode = null;
		st.signal = null;
		st.startedAt = Date.now();
		st.finishedAt = null;
		st.stdoutOffset = 0;
		st.stderrOffset = 0;
		st.log.append(`\n▶ 构建开始 ${new Date().toISOString()}\n`);

		const godot = resolveGodot(ctx, cfg);
		st.godot = godot;
		if (!godot) {
			st.log.append("✘ 找不到 Godot。请安装后重试，或在本插件 cordis.patch.yml 的 config 里设置 godotBin。\n");
			st.state = "error";
			st.finishedAt = Date.now();
			return;
		}
		st.log.append(`✔ Godot：${godot}\n`);

		const preset = detectWebPreset(cfg.projectRoot, cfg.exportPreset);
		st.preset = preset;
		if (!preset) {
			st.log.append("✘ 项目的 export_presets.cfg 里没有 Web 导出预设。\n");
			st.log.append("  请在 Godot 编辑器：项目 → 导出 → 添加… → Web，然后保存导出预设。\n");
			st.state = "error";
			st.finishedAt = Date.now();
			return;
		}
		st.log.append(`✔ 导出预设：${preset}\n`);

		try { fs.mkdirSync(webRoot, { recursive: true }); } catch (err) {
			st.log.append("✘ 无法创建输出目录：" + (err?.message ?? String(err)) + "\n");
			st.state = "error";
			st.finishedAt = Date.now();
			return;
		}

		const steps = [];
		if (cfg.importFirst) steps.push(["--import"]);
		steps.push(["--export-release", preset, outFile]);

		let ok = true;
		for (const tail of steps) {
			const argv = [godot, "--headless", "--path", cfg.projectRoot, ...tail];
			st.log.append("\n$ " + argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ") + "\n");
			if (!(await runStep(argv))) { ok = false; break; }
		}
		st.finishedAt = Date.now();
		st.state = ok ? "done" : "error";
		if (ok) st.log.append("✔ 构建完成：" + outFile + "\n");
	}

	// ── 路由 ──────────────────────────────────────────────────────────────
	function handleBuild(req, res) {
		if (!isTrusted(ctx, req, cfg)) { sendJson(res, 403, { error: "forbidden" }); return; }
		if (st.state === "running") { sendJson(res, 409, { error: "build already running" }); return; }
		void startBuild(); // 异步执行，请求立即返回
		sendJson(res, 202, { started: true, state: "running" });
	}

	function handleStatus(req, res) {
		if (!isTrusted(ctx, req, cfg)) { sendJson(res, 403, { error: "forbidden" }); return; }
		// 运行中顺手把采集流搬进日志尾环（轮询即进度）
		if (st.state === "running" && st.handle) {
			try {
				const out = st.handle.collected?.stdout?.readFrom(st.stdoutOffset);
				if (out) { if (out.text) st.log.append(out.text); st.stdoutOffset = out.nextOffset; }
				const err = st.handle.collected?.stderr?.readFrom(st.stderrOffset);
				if (err) { if (err.text) st.log.append(err.text); st.stderrOffset = err.nextOffset; }
			} catch { /* 忽略并发抖动 */ }
		}
		sendJson(res, 200, {
			state: st.state,
			project: cfg.projectRoot,
			godot: st.godot,
			preset: st.preset,
			webReady: fs.existsSync(outFile),
			exitCode: st.exitCode,
			signal: st.signal,
			startedAt: st.startedAt,
			finishedAt: st.finishedAt,
			logTail: st.log.text
		});
	}

	function handleMeta(req, res) {
		sendJson(res, 200, {
			name: "dsh-godot-play",
			state: st.state,
			webReady: fs.existsSync(outFile),
			godot: st.godot,
			preset: st.preset
		});
	}

	/** 静态托管 web/ 导出：带 cross-origin isolation 头（Godot Web 线程必需）。 */
	function handleWeb(req, res) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { "Allow": "GET, HEAD" });
			res.end();
			return;
		}
		let urlPath;
		try { urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://dsh.local").pathname); }
		catch { res.writeHead(400); res.end("bad request"); return; }
		const rel = urlPath.slice(WEB_PREFIX.length) || "/";
		const target = path.normalize(path.join(webRoot, rel));
		if (target !== webRoot && !target.startsWith(webRoot + path.sep)) {
			res.writeHead(403); res.end("forbidden");
			return;
		}
		let stat;
		try { stat = fs.statSync(target); } catch {
			res.writeHead(404); res.end("not found");
			return;
		}
		if (stat.isDirectory()) {
			const idx = path.join(target, "index.html");
			try { stat = fs.statSync(idx); } catch {
				res.writeHead(404); res.end("not found");
				return;
			}
			sendFile(res, req, idx, stat);
			return;
		}
		sendFile(res, req, target, stat);
	}

	function sendFile(res, req, file, stat) {
		const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
		const headers = {
			"Content-Type": type,
			// Godot 4 Web 线程需要 cross-origin isolation
			"Cross-Origin-Embedder-Policy": "require-corp",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cache-Control": "no-cache",
			"Content-Length": stat.size
		};
		if (req.method === "HEAD") {
			res.writeHead(200, headers);
			res.end();
			return;
		}
		res.writeHead(200, headers);
		fs.createReadStream(file).pipe(res);
	}

	ctx.effect(() => {
		const disposers = [
			ctx.webServer.register({ kind: "exact", path: `${API_BASE}/build`, handler: handleBuild }),
			ctx.webServer.register({ kind: "exact", path: `${API_BASE}/status`, handler: handleStatus }),
			ctx.webServer.register({ kind: "exact", path: `${API_BASE}/meta`, handler: handleMeta }),
			ctx.webServer.register({ kind: "prefix", path: WEB_PREFIX, handler: handleWeb })
		];
		return () => {
			for (const d of disposers) { try { d(); } catch { /* 忽略 */ } }
			if (st.handle) { try { st.handle.terminate(); } catch { /* 忽略 */ } }
		};
	}, "godot-play: /api/godot-play + static web routes");

	log(`dsh-godot-play 宿主已挂载：项目=${cfg.projectRoot}，web=${webRoot}`);
}
