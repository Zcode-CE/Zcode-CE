#!/usr/bin/env bash
# desktop main/renderer 类型错误基线对比。
#
# 背景：pnpm typecheck 的工程列表只含 packages/desktop/tsconfig.host.json，
# 不含 tsconfig.main.json / tsconfig.renderer.json。这两个工程有大量既有错误，
# 会淹没新引入的错误，所以需要「与 HEAD 基线比较」而不是「看绝对数量」。
#
# 用法：
#   bash scripts/desktop-typecheck-baseline.sh head      # 用 git worktree 取真实 HEAD 并跑 tsc
#   bash scripts/desktop-typecheck-baseline.sh current   # 跑当前工作区
#   bash scripts/desktop-typecheck-baseline.sh diff      # head vs current，只报新增
#
# 两个必须避开的坑（都实测踩过）：
#   1. 不能用「先 snapshot 再 diff」的写法。snapshot 若对当前工作区跑 tsc，
#      记录的是当时的脏工作区，不是 HEAD —— diff 会得到「永远为空」的假通过。
#      必须用 git worktree 检出 HEAD 独立跑。
#   2. 不能按整行比较。tsc 对超长联合类型的截断文本在两次运行间不稳定
#      （同一 TS2339 打印出不同的成员顺序），按整行 comm 会误报新增。
#      必须按「文件|错误码」比较。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.reverse/16-typecheck-baseline"
mkdir -p "$OUT"

# 归一化为「文件|错误码」。
#
# 注意（实测教训）：错误码本身也会漂移。P1 删除上游模块后，未改动文件的错误
# 从 TS2307/TS2345/TS7006 变成 TS2322/TS2339（类型解析路径变了），按错误码比较
# 会把这些误报成「新增」，但同一批文件的总错误数是**下降**的（25 → 21）。
# 因此 diff 输出仅供定位，最终判断要看 per-file 计数是否净增。
normalize() {
  grep -oE '^[^(]+\([0-9]+,[0-9]+\): error TS[0-9]+' \
    | sed -E 's/\([0-9]+,[0-9]+\)//' \
    | sort -u || true
}

# 每个文件的错误条数（稳定判据）。
per_file_counts() {
  cut -d: -f1 | sort | uniq -c | awk '{print $2" "$1}' | sort
}

run_tsc() {
  local base="$1" name="$2"
  ( cd "$base/packages/desktop" && npx tsc -p tsconfig.main.json --noEmit 2>&1 || true ) \
    | normalize > "$OUT/$name.main.txt"
  ( cd "$base" && npx tsc -p packages/desktop/tsconfig.renderer.json --noEmit 2>&1 || true ) \
    | normalize > "$OUT/$name.renderer.txt"
  echo "[baseline] $name: main=$(wc -l < "$OUT/$name.main.txt") renderer=$(wc -l < "$OUT/$name.renderer.txt")"
}

# 让 worktree 借用主工作区的依赖解析。
#
# 只软链顶层 node_modules 是不够的：workspace 包各自有 packages/*/node_modules
# （pnpm 的 workspace 链接与包级依赖都在那里）。漏掉会让 HEAD 侧解析不到
# @zcode/shared 等 workspace 包，产生上百条假 TS2307，把真实差异淹没。
link_worktree_modules() {
  local wt="$1"
  [ -e "$wt/node_modules" ] || ln -s "$ROOT/node_modules" "$wt/node_modules"
  local pkg
  for pkg in "$ROOT"/packages/*/node_modules; do
    [ -d "$pkg" ] || continue
    local name rel
    name="$(basename "$(dirname "$pkg")")"
    rel="packages/$name/node_modules"
    [ -e "$wt/$rel" ] || ln -s "$pkg" "$wt/$rel"
  done
  for pkg in "$ROOT"/apps/*/node_modules "$ROOT"/apps/*/packages/*/node_modules; do
    [ -d "$pkg" ] || continue
    local rel
    rel="${pkg#"$ROOT"/}"
    [ -e "$wt/$rel" ] || ln -s "$pkg" "$wt/$rel"
  done
}

worktree_for_head() {
  local wt="$ROOT/.reverse/.head-worktree"
  if [ ! -d "$wt" ]; then
    git -C "$ROOT" worktree add --detach "$wt" HEAD >/dev/null 2>&1
  fi
  echo "$wt"
}

cleanup_worktree() {
  local wt="$ROOT/.reverse/.head-worktree"
  [ -d "$wt" ] && git -C "$ROOT" worktree remove --force "$wt" >/dev/null 2>&1 || true
}

case "${1:-}" in
  head)
    wt="$(worktree_for_head)"
    link_worktree_modules "$wt"
    run_tsc "$wt" "head"
    cleanup_worktree
    ;;
  current)
    run_tsc "$ROOT" "current"
    ;;
  diff)
    wt="$(worktree_for_head)"
    link_worktree_modules "$wt"
    run_tsc "$wt" "head"
    run_tsc "$ROOT" "current"
    cleanup_worktree
    for proj in main renderer; do
      echo "=== $proj 新增错误（仅供定位，错误码可能因上游删除而漂移）==="
      comm -13 "$OUT/head.$proj.txt" "$OUT/current.$proj.txt" || true
      echo
      echo "=== $proj 每文件错误数变化（净增才算可疑）==="
      per_file_counts < "$OUT/head.$proj.txt" > "$OUT/head.$proj.counts"
      per_file_counts < "$OUT/current.$proj.txt" > "$OUT/current.$proj.counts"
      # 只报告「当前比 HEAD 多」的文件。
      join -j 1 -o 0,1.2,2.2 "$OUT/head.$proj.counts" "$OUT/current.$proj.counts" 2>/dev/null \
        | awk '$3 > $2 { print "  " $1 ": " $2 " -> " $3 }' || true
      echo "  (无输出 = 无文件错误数净增)"
    done
    ;;
  *)
    echo "用法: $0 {head|current|diff}"
    exit 1
    ;;
esac