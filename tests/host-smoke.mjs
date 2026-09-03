/**
 * dsh-godot-play 宿主半区冒烟测试（无需 dsh 进程）。
 *
 * stub 出 webServer / subprocess / webRuntime / workspaceRegistry：
 *   - subprocess.spawn 真跑"假 Godot"脚本；
 *   - workspaceRegistry 提供有序项目记录（新→旧）；
 *   - 覆盖：锁定配置的构建链路、workspaces 列表/登记、切换被锁拒绝、
 *     目标优先级纯函数、静态托管与路径穿越防护。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { apply, chooseProject, detectWebPreset, detectWebExportDir } from "../lib/index.js";

const results = [];
function expect(cond, label) {
	results.push({ ok: !!cond, label });
	if (!cond) console.error("✘ " + label);
	else console.log("✔ " + label);
}

// ── 假 Godot 项目 A（锁定目标）/ B（另一 Godot 项目）/ plain（非 Godot）──
const base = mkdtempSync(join(tmpdir(), "godot-play-smoke-"));
const mkProject = (name, extraPresetLines = []) => {
	const dir = join(base, name);
	mkdirSync(join(dir, "web"), { recursive: true });
	writeFileSync(join(dir, "export_presets.cfg"), [
		'[preset.0]', 'name="Web"', 'platform="Web"', 'runnable=true',
		...extraPresetLines
	].join("\n"));
	writeFileSync(join(dir, "project.godot"), 'config_version=5\n');
	return dir;
};
const projA = mkProject("game-a");
const projB = mkProject("game-b");
const plain = join(base, "plain");
mkdirSync(plain, { recursive: true });

const fakeGodot = join(base, "fake-godot.sh");
writeFileSync(fakeGodot, [
	"#!/usr/bin/env bash",
	"set -euo pipefail",
	'echo "[fake-godot] argv: $*"',
	'for ((i=1;i<=$#;i++)); do',
	'  if [ "${!i}" = "--export-release" ]; then',
	'    out="${@:$((i+2)):1}"',
	'    printf "game" > "$out"',
	'  fi',
	'done',
	'echo "[fake-godot] exported ok"'
].join("\n") + "\n");
chmodSync(fakeGodot, 0o755);

// ── stub ctx ────────────────────────────────────────────────────
const routes = [];
let effectCleanup = null;

function makeCollector() {
	let buf = ""; let dropped = 0; const cap = 128 * 1024;
	return {
		append(c) { buf += c; if (buf.length > cap) { dropped += buf.length - cap; buf = buf.slice(-cap); } },
		reader() {
			return {
				readFrom(byte) {
					if (byte > buf.length) byte = buf.length;
					const start = Math.max(byte, dropped);
					return { text: buf.slice(start), nextOffset: buf.length, lossy: byte < dropped };
				}
			};
		}
	};
}

// 注册表顺序：新→旧。预置 [projB(较新), projA(较旧), plain]
const registryEntries = [
	{ path: projB, title: "game-b", createdAt: "2026-09-03T10:00:00Z" },
	{ path: projA, title: "game-a", createdAt: "2026-09-03T09:00:00Z" },
	{ path: plain, title: "plain", createdAt: "2026-09-03T08:00:00Z" }
];
const ctx = {
	logger: { info() {}, warn() {}, error() {} },
	webRuntime: { trustedHosts: [] },
	subprocess: {
		resolveExecutable() { throw new Error("not on PATH in smoke"); },
		spawn(spec) {
			const out = makeCollector(); const err = makeCollector();
			const cp = spawn(spec.argv[0], spec.argv.slice(1), {
				cwd: spec.cwd, env: { ...process.env, ...(spec.env || {}) }, stdio: ["ignore", "pipe", "pipe"]
			});
			cp.stdout.on("data", (d) => out.append(String(d)));
			cp.stderr.on("data", (d) => err.append(String(d)));
			const done = new Promise((resolve, reject) => {
				cp.on("error", reject);
				cp.on("close", (code, signal) => resolve({ exitCode: code, signal: signal || null }));
			});
			return {
				pid: cp.pid, stdin: undefined, stdout: undefined, stderr: undefined,
				collected: { stdout: out.reader(), stderr: err.reader() },
				done,
				terminate() { try { cp.kill("SIGTERM"); } catch { /* ignore */ } }
			};
		}
	},
	workspaceRegistry: {
		list() { return registryEntries; },
		async create(p, title) { registryEntries.unshift({ path: p, title: title || p }); return registryEntries[0]; }
	},
	webServer: {
		register(route) { routes.push(route); return () => {}; }
	},
	effect(fn) { effectCleanup = fn; return fn(); }
};

// ── 目标优先级纯函数 ────────────────────────────────────────────
{
	expect(chooseProject({ pinnedPath: projA, lastPath: projB, godotDirs: [projB, projA], fallbackPath: plain }) === projA, "优先级：锁定 > 其它");
	expect(chooseProject({ pinnedPath: null, lastPath: projA, godotDirs: [projB, projA], fallbackPath: plain }) === projA, "优先级：上次选择命中");
	expect(chooseProject({ pinnedPath: null, lastPath: plain, godotDirs: [projB, projA], fallbackPath: plain }) === projB, "上次选择无效时回落最新 Godot 工作区");
	expect(chooseProject({ pinnedPath: null, lastPath: null, godotDirs: [], fallbackPath: plain }) === plain, "无可选时用兜底目录");
}
// 预设探测纯函数
{
	expect(detectWebPreset(projA, "") === "Web", "detectWebPreset 命中 Web");
	expect(detectWebPreset(plain, "") === null, "非 Godot/无预设返回 null");
	expect(detectWebExportDir(projA, "") === null, "预设无 export_path → null（兜底 web）");
	expect(detectWebExportDir(plain, "") === null, "非 Godot/无预设 → null");
	// export_path 目录解析：常规 / res:// 前缀 / 项目根 / 上级逃逸 / 无目录文件名
	expect(detectWebExportDir(mkProject("dir-1", ['export_path="build/web/index.html"']), "") === "build/web", "取 export_path 目录 build/web");
	expect(detectWebExportDir(mkProject("dir-2", ['export_path="res://dist/web/index.html"']), "") === "dist/web", "容忍 res:// 前缀");
	expect(detectWebExportDir(mkProject("dir-3", ['export_path="web"']), "") === null, "export_path 指向目录本身（非文件）→ null");
	expect(detectWebExportDir(mkProject("dir-4", ['export_path="index.html"']), "") === null, "项目根文件名 → null（拒绝托管项目根）");
	expect(detectWebExportDir(mkProject("dir-5", ['export_path="../evil/index.html"']), "") === null, "上级逃逸 → null");
}

// ── 挂载宿主（锁定 projA）──────────────────────────────────────
apply(ctx, { projectRoot: projA, webRel: "web", godotBin: fakeGodot, allowRemote: true });
expect(routes.length >= 8, "挂载 ≥8 条路由（workspaces/build/status/logs-clear/meta/target/add + static）");
const route = (path) => routes.find((r) => r.path === path);

function mkReq(method, url, body) {
	const r = { method, url, socket: { remoteAddress: "127.0.0.1" }, headers: {} };
	if (body !== undefined) {
		const payload = JSON.stringify(body);
		r.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) };
		r.body = payload;
		r.on = (ev, cb) => {
			if (ev === "data") process.nextTick(() => cb(r.body));
			if (ev === "end") process.nextTick(() => cb());
		};
	}
	return r;
}
function mkRes() {
	const chunks = [];
	const res = new Writable({
		write(c, enc, cb) { chunks.push(Buffer.from(c)); cb(); },
		final(cb) { cb(); }
	});
	res.status = 0; res.headers = {};
	res.writeHead = function (s, h) { this.status = s; Object.assign(this.headers, h || {}); };
	res.__body = () => Buffer.concat(chunks).toString("utf8");
	return res;
}
function afterRes(res) {
	return new Promise((r) => {
		if (res.writableFinished) r();
		else { res.on("finish", r); res.on("error", r); }
	});
}
async function call(path, req, method = "GET") {
	const handler = route(path).handler;
	const res = mkRes();
	const done = afterRes(res);
	await handler(req, res);
	await done;
	return { status: res.status, json: () => { try { return JSON.parse(res.__body()); } catch { return {}; } } };
}

// ── 多项目 API（锁定态）────────────────────────────────────────
{
	const r = await call("/api/godot-play/workspaces", mkReq("GET", "/api/godot-play/workspaces"));
	const j = r.json();
	expect(r.status === 200 && j.pinned === true, "workspaces：pinned=true");
	expect(j.current === projA, "workspaces：current=锁定项目");
	const paths = (j.candidates || []).map((c) => c.path);
	expect(paths.includes(projA) && paths.includes(projB), "candidates 含 A、B");
	expect(!paths.includes(plain), "candidates 不含非 Godot 目录");
}
{
	// 登记 projC
	const projC = mkProject("game-c");
	const r = await call("/api/godot-play/workspaces/add", mkReq("POST", "/api/godot-play/workspaces/add", { path: projC }), "POST");
	const j = r.json();
	expect(r.status === 200 && (j.candidates || []).some((c) => c.path === projC), "登记成功且出现在候选里");
	// 登记非 Godot → 400
	const r2 = await call("/api/godot-play/workspaces/add", mkReq("POST", "/api/godot-play/workspaces/add", { path: plain }), "POST");
	expect(r2.status === 400, "登记非 Godot 目录返回 400");
}
{
	// 锁定时切换被拒
	const r = await call("/api/godot-play/target", mkReq("POST", "/api/godot-play/target", { path: projB }), "POST");
	expect(r.status === 400, "锁定时 POST /target 返回 400");
}

// ── 构建链路（对锁定目标）──────────────────────────────────────
{
	const r0 = await call("/api/godot-play/build", mkReq("POST", "/api/godot-play/build"), "POST");
	expect(r0.status === 202, "POST /build 返回 202");
	let last = null;
	for (let i = 0; i < 200; i++) {
		await new Promise((r) => setTimeout(r, 50));
		const s = await call("/api/godot-play/status", mkReq("GET", "/api/godot-play/status"));
		last = s.json();
		if (last.state !== "running") break;
	}
	expect(last.state === "done", "status 终态为 done（实际 " + last.state + "）");
	expect(last.exitCode === 0, "exitCode === 0");
	expect(last.webReady === true, "webReady === true");
	expect((last.logTail || "").includes("目标项目：" + projA), "日志标注目标项目");
	expect((last.logTail || "").includes("exported ok"), "日志含假 Godot 输出");
}

// ── 清空日志 ────────────────────────────────────────────────────
{
	const before = (await call("/api/godot-play/status", mkReq("GET", "/api/godot-play/status"))).json();
	expect((before.logTail || "").length > 0, "清空前日志非空");
	const r = await call("/api/godot-play/logs/clear", mkReq("POST", "/api/godot-play/logs/clear"), "POST");
	expect(r.status === 200 && r.json().ok === true, "POST /logs/clear 返回 ok");
	const after = (await call("/api/godot-play/status", mkReq("GET", "/api/godot-play/status"))).json();
	expect((after.logTail || "") === "", "清空后 logTail 为空");
}

// ── 静态托管 ────────────────────────────────────────────────────
{
	const handler = route("/dsh-godot-play/web").handler;
	const req = mkReq("GET", "/dsh-godot-play/web/index.html");
	const res = mkRes();
	const p3 = afterRes(res);
	await handler(req, res);
	await p3;
	expect(res.status === 200, "静态托管 200");
	expect(res.headers["Cross-Origin-Embedder-Policy"] === "require-corp", "带 COEP 头");
	expect(res.__body() === "game", "静态内容正确");
}
for (const evil of ["/dsh-godot-play/web/../export_presets.cfg", "/dsh-godot-play/web/%2e%2e/export_presets.cfg", "/dsh-godot-play/web/..%2fexport_presets.cfg"]) {
	const handler = route("/dsh-godot-play/web").handler;
	const req = mkReq("GET", evil);
	const res = mkRes();
	const p4 = afterRes(res);
	await handler(req, res);
	await p4;
	expect(res.status === 403 || res.status === 404, "穿越被拒（403/404）：" + evil);
}

// ── webRel 自动跟随 export_presets.cfg（不配 webRel 的第二个宿主实例）──
{
	const projP = mkProject("game-p", ['export_path="build/web/index.html"']);
	apply(ctx, { projectRoot: projP, godotBin: fakeGodot, allowRemote: true });
	// 后注册实例的路由（同路径先注册的先命中，故取最后一个）
	const routeLast = (p) => routes.filter((r) => r.path === p).at(-1);
	const callLast = async (path, req, method = "GET") => {
		const handler = routeLast(path).handler;
		const res = mkRes();
		const done = afterRes(res);
		await handler(req, res);
		await done;
		return { status: res.status, json: () => { try { return JSON.parse(res.__body()); } catch { return {}; } } };
	};

	const r0 = await callLast("/api/godot-play/build", mkReq("POST", "/api/godot-play/build"), "POST");
	expect(r0.status === 202, "跟随模式 POST /build 返回 202");
	let last2 = null;
	for (let i = 0; i < 200; i++) {
		await new Promise((r) => setTimeout(r, 50));
		const s = await callLast("/api/godot-play/status", mkReq("GET", "/api/godot-play/status"));
		last2 = s.json();
		if (last2.state !== "running") break;
	}
	expect(last2.state === "done", "跟随模式 status 终态 done（实际 " + last2.state + "）");
	expect(last2.webReady === true, "跟随模式 webReady === true");
	const outPath = join(projP, "build", "web", "index.html");
	expect(existsSync(outPath), "产物落在预设 export_path 目录：" + outPath);
	expect((last2.logTail || "").includes("构建完成：" + outPath), "日志标注输出路径=" + outPath);

	const h = routeLast("/dsh-godot-play/web").handler;
	const rr = mkReq("GET", "/dsh-godot-play/web/index.html");
	const rs = mkRes();
	const pd = afterRes(rs);
	await h(rr, rs);
	await pd;
	expect(rs.status === 200 && rs.__body() === "game", "跟随模式静态托管 200");
}

if (effectCleanup) { const d = effectCleanup(); if (typeof d === "function") d(); }
rmSync(base, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exitCode = failed > 0 ? 1 : 0;
