/**
 * dsh-godot-play —— 宿主半区（Node）。
 *
 * 纯 UI 插件：空的 apply 只是让本包作为一条 cordis 加载器条目出现在
 * host 插件树中；浏览器半区经 package.json 的 dsh.client 声明被发现，
 * 由客户端模块系统加载 lib/client.js 后在浏览器里挂载 Godot Web 试玩画布。
 */
export function apply() {}
