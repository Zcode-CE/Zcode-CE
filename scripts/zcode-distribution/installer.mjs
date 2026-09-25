const packageDirName = "zcode";

export function installScriptSource(baseUrl, { placeholderBaseUrl } = {}) {
  // 占位基址的告警：这份 install.sh 是在没有真实托管地址时生成的（npm 打包链路），
  // 直接拿它装会去一个永不解析的域名取包。警告打到 stderr，不改变脚本的退出码语义。
  // 未使用占位基址时整段不产出 —— 正常的 install.sh 与改动前逐字节相同。
  const placeholderPrelude =
    placeholderBaseUrl && baseUrl === placeholderBaseUrl
      ? [
          `PLACEHOLDER_BASE_URL="${placeholderBaseUrl}"`,
          "",
          'if [ "${BASE_URL%/}" = "${PLACEHOLDER_BASE_URL%/}" ]; then',
          '  echo "zcode install: this install.sh was generated without a real download base URL" >&2',
          '  echo "  (placeholder: ${PLACEHOLDER_BASE_URL}). Set ZCODE_DIST_BASE_URL to your hosting URL." >&2',
          "fi",
          "",
          "",
        ].join("\n")
      : "";
  return `#!/usr/bin/env sh
set -eu

BASE_URL="\${ZCODE_DIST_BASE_URL:-${baseUrl}}"
${placeholderPrelude}INSTALL_DIR="\${ZCODE_DIST_HOME:-$HOME/.zcode/runtime}"
BIN_DIR="\${ZCODE_DIST_BIN_DIR:-$HOME/.local/bin}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "zcode install requires $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd curl
need_cmd tar

LATEST_JSON="$(curl -fsSL "\${BASE_URL%/}/latest.json")"
VERSION="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).version))")"
TARBALL="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).tarball))")"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/$TARBALL"
curl -fL "\${BASE_URL%/}/releases/$VERSION/$TARBALL" -o "$ARCHIVE"

mkdir -p "$INSTALL_DIR/releases" "$BIN_DIR"
TARGET="$INSTALL_DIR/releases/$VERSION"
rm -rf "$TARGET.new"
mkdir -p "$TARGET.new"
tar -xzf "$ARCHIVE" -C "$TARGET.new"
rm -rf "$TARGET"
mv "$TARGET.new/${packageDirName}" "$TARGET"
rm -rf "$TARGET.new"
ln -sfn "$TARGET" "$INSTALL_DIR/current"

cat > "$BIN_DIR/zcode" <<SH
#!/usr/bin/env sh
exec node "$INSTALL_DIR/current/bin/zcode.mjs" "\\$@"
SH
chmod +x "$BIN_DIR/zcode"

echo "ZCode $VERSION installed."
echo "Run: zcode (TUI) or zcode --web (Web)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not in PATH." ;;
esac
`;
}
