#!/usr/bin/env bash
# dsh-godot-play 卸载：删除 profile node_modules 中的包目录。
# cordis.patch.yml 里的加载器条目需手动删除（见文末提示）。
#
# 用法：bash uninstall.sh   （可用 DSH_PROFILE_DIR 指定其它 profile）
set -euo pipefail

PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
PKG_NAME="dsh-godot-play"
DEST="$PROFILE/node_modules/$PKG_NAME"

if [ -d "$DEST" ]; then
  rm -rf "$DEST"
  echo "✅ 已删除：$DEST"
else
  echo "⏭️  未安装：$DEST"
fi

echo "提示：如需彻底移除，请手动删除 $PROFILE/$([ -f "$PROFILE/cordis.patch.yml" ] && echo cordis.patch.yml) 中 id: godot-play 的加载器条目。"
