/**
 * dsh-godot-play 宿主半区冒烟测试（无需 dsh 进程）。
 *
 * stub 出 webServer / subprocess / webRuntime 三个注入服务：
 *   - subprocess.spawn 用 node:child_process 真跑一个"假 Godot"脚本；
 *   - 端到端走一遍：POST /build → 轮询 /status → 断言 done + webReady；
 *   - 再验证 /dsh-godot-play/web/* 静态托管与路径穿越防护。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { apply } from "../lib/index.js";

const results = [];
function expect(cond, label) {
	results.push({ ok: !!cond, label });
	if (!cond) console.error("✘ " + label);
	else console.log("✔ " + label);
}

// ── 构造假 Godot 项目 ──────────────────────────────────────────
const proj = mkdtempSync(join(tmpdir(), "godot-play-smoke-"));
mkdirSync(join(proj, "web"), { recursive: true });
writeFileSync(join(proj, "export_presets.cfg"), [
	'[preset.0]',
	'name="Web"',
	'platform="Web"',
	'runnable=true',
	'',
	'[preset.1]',
	'name="Desktop"',
	'platform="Windows Desktop"'
].join("\n"));

// 假 Godot：--import 打一行；--export-release <preset> <out> 写 index.html
const fakeGodot = join(proj, "fake-godot.sh");
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
let effectFn = null;

function makeCollector() {
	let buf = "";
	let dropped = 0;
	const cap = 128 * 1024;
	return {
		append(chunk) {
			buf += chunk;
			if (buf.length > cap) { dropped += buf.length - cap; buf = buf.slice(-cap); }
		},
		reader() {
			return {
				readFrom(byte) {
					if (byte > buf.length) byte = buf.length;
					const start = Math.max(byte, dropped);
					const lossy = byte < dropped;
					return { text: buf.slice(start), nextOffset: buf.length, lossy };
				}
			};
		}
	};
}

const ctx = {
	logger: { info() {}, warn() {}, error() {} },
	webRuntime: { trustedHosts: [] },
	subprocess: {
		resolveExecutable() { throw new Error("not on PATH in smoke"); },
		spawn(spec) {
			const out = makeCollector();
			const err = makeCollector();
			const cp = spawn(spec.argv[0], spec.argv.slice(1), {
				cwd: spec.cwd,
				env: { ...process.env, ...(spec.env || {}) },
				stdio: ["ignore", "pipe", "pipe"]
			});
			cp.stdout.on("data", (d) => out.append(String(d)));
			cp.stderr.on("data", (d) => err.append(String(d)));
			const done = new Promise((resolve, reject) => {
				cp.on("error", reject);
				cp.on("close", (code, signal) => resolve({ exitCode: code, signal: signal || null }));
			});
			return {
				pid: cp.pid,
				stdin: undefined,
				stdout: undefined,
				stderr: undefined,
				collected: { stdout: out.reader(), stderr: err.reader() },
				done,
				terminate() { try { cp.kill("SIGTERM"); } catch { /* ignore */ } }
			};
		}
	},
	webServer: {
		register(route) { routes.push(route); return () => {}; }
	},
	effect(fn) { effectFn = fn; const d = fn(); return d; }
};

// ── 挂载宿主 ────────────────────────────────────────────────────
apply(ctx, { projectRoot: proj, webRel: "web", godotBin: fakeGodot, allowRemote: true });
expect(routes.length === 4, "挂载 4 条路由（build/status/meta/static）");

const route = (method, path) => routes.find((r) => r.path === path && (r.kind === "exact" || r.kind === "prefix"));

function mkReq(method, url) {
	return { method, url, socket: { remoteAddress: "127.0.0.1" }, headers: {} };
}
function mkRes() {
	const chunks = [];
	const res = new Writable({
		write(c, enc, cb) { chunks.push(Buffer.from(c)); cb(); },
		final(cb) { cb(); }
	});
	res.status = 0;
	res.headers = {};
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

// ── 构建链路 ────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const buildRoute = route("POST", "/api/godot-play/build");
const statusRoute = route("GET", "/api/godot-play/status");

{
	const req = mkReq("POST", "/api/godot-play/build");
	const res = mkRes();
	const p0 = afterRes(res);
	await buildRoute.handler(req, res);
	await p0;
	expect(res.status === 202, "POST /build 返回 202");

	let last = null;
	for (let i = 0; i < 200; i++) {
		await sleep(50);
		const r2 = mkReq("GET", "/api/godot-play/status");
		const s2 = mkRes();
		const p2 = afterRes(s2);
		await statusRoute.handler(r2, s2);
		await p2;
		last = JSON.parse(s2.__body());
		if (last.state !== "running") break;
	}
	expect(last.state === "done", "status 终态为 done（实际 " + last.state + "）");
	expect(last.exitCode === 0, "exitCode === 0");
	expect(last.webReady === true, "webReady === true（web/index.html 已产出）");
	expect((last.logTail || "").includes("exported ok"), "日志含假 Godot 输出");
	expect((last.logTail || "").includes("✔ 构建完成"), "日志含构建完成标记");
	expect(last.godot === fakeGodot, "godot 解析到配置路径");
	expect(last.preset === "Web", "自动探测到 Web 导出预设");
}

// ── 静态托管 ────────────────────────────────────────────────────
{
	const req = mkReq("GET", "/dsh-godot-play/web/index.html");
	const res = mkRes();
	const p3 = afterRes(res);
	await route("GET", "/dsh-godot-play/web").handler(req, res);
	await p3;
	expect(res.status === 200, "静态托管返回 200");
	expect(res.headers["Cross-Origin-Embedder-Policy"] === "require-corp", "响应带 COEP 头");
	expect(res.__body() === "game", "静态内容正确");
}
for (const evil of ["/dsh-godot-play/web/../export_presets.cfg", "/dsh-godot-play/web/%2e%2e/export_presets.cfg", "/dsh-godot-play/web/..%2fexport_presets.cfg"]) {
	const req = mkReq("GET", evil);
	const res = mkRes();
	const p4 = afterRes(res);
	await route("GET", "/dsh-godot-play/web").handler(req, res);
	await p4;
	expect(res.status === 403 || res.status === 404, "穿越被拒（403/404）：" + evil + " → " + res.status);
}

// ── 清理 ────────────────────────────────────────────────────────
if (effectFn) { const d = effectFn(); if (typeof d === "function") d(); }
rmSync(proj, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exitCode = failed > 0 ? 1 : 0;
