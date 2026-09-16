#!/usr/bin/env bash
#
# 把一个带标记的段落追加进已有的 Caddyfile,其余内容一个字都不改。
#
#   caddy-append.sh <dest> <block-file>
#
# 为什么要单独一个脚本:真正跑这件事的时候是在别人的服务器上,而那里已经有一份能用的配置。
# 单独成脚本才能在没有服务器的情况下把它测干净——包括两个真实的边界:
#   1. 目标文件结尾没有换行,追加的第一行会粘到最后一行上;
#   2. 重复执行,标记段落必须被替换而不是堆第二份。
set -euo pipefail
DEST="$1"
BLOCK="$2"
MARK_BEGIN="# agentgate-managed-begin"
MARK_END="# agentgate-managed-end"

if [ ! -f "$BLOCK" ]; then echo "no block file at $BLOCK" >&2; exit 2; fi

if [ -f "$DEST" ]; then
  cp "$DEST" "$DEST.bak.$(date +%s)"
  if grep -qF "$MARK_BEGIN" "$DEST"; then
    sed "/$MARK_BEGIN/,/$MARK_END/d" "$DEST" > "$DEST.stripped"
    mv "$DEST.stripped" "$DEST"
  fi
  # 结尾没有换行时补一个,否则我们的第一行会和它原来最后一行连成一行
  if [ -n "$(tail -c 1 "$DEST" 2>/dev/null || true)" ]; then printf "\n" >> "$DEST"; fi
else
  : > "$DEST"
fi

cat "$BLOCK" >> "$DEST"
echo "appended to $DEST (backup: ${DEST}.bak.*)"
