#!/usr/bin/env bash
# dsh-godot-play 卸载：删除 profile node_modules 中的包目录。
#
# 用法：bash uninstall.sh   （可用 DSH_PROFILE_DIR 指定其它 profile）
set -euo pipefail

PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
PKG_NAME="dsh-godot-play"
DEST="${PROFILE}/node_modules/${PKG_NAME}"

if [ -d "$DEST" ]; then
  rm -rf "$DEST"
  echo "✅ 已删除：$DEST"
else
  echo "⏭️  未安装：$DEST"
fi

PATCH_FILE="${PROFILE}/cordis.patch.yml"
echo
echo "如需彻底移除，请手动删除 ${PATCH_FILE} 中含 id: godot-play 的 insert 块。"
