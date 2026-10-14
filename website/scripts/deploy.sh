#!/usr/bin/env bash
# 官网发布脚本:构建 → 生成并校验 AASA → 隔离登录 CloudBase → 上传 dist/ → 上传后检查。
#
#   bash website/scripts/deploy.sh --dry-run   # 只构建 + 生成/校验,不登录、不上传(建议先跑这个)
#   bash website/scripts/deploy.sh             # 交互确认后发布
#   bash website/scripts/deploy.sh --yes       # 非交互(CI)发布
#   选项: --no-build 跳过构建(沿用现有 dist/)  -h|--help 帮助
#
# 配置(环境变量优先,其次仓库根目录 .env;不会 source .env,也不会打印任何密钥):
#   TARO_APP_CLOUD_ENV_ID        CloudBase 环境 ID(发布必需)
#   CLOUDBASE_SECRET_ID / _KEY   该环境所属账号的 API 密钥(发布必需)
#   APPLE_TEAM_ID                10 位 Apple Team ID,用于替换 AASA 里的占位(必需,否则 Universal Link 不生效)
#   TARO_APP_WX_UNIVERSAL_LINK   如 https://jielingzi.cn/app/,用于校验 AASA 覆盖路径、发布后检查线上域名(可选)
#
# 设计要点:
#   * 隔离登录:本机全局的 tcb 登录可能是别的账号。这里把 HOME/USERPROFILE 指到临时目录再登录,
#     结束(无论成败)即删除,全局登录不受影响(与 dist-tmp/tcb-deploy.mjs 的做法一致)。
#   * 绝不使用 --prune:同一托管空间里可能还有 /cloud-admin/、/__auth/ 等不属于官网的内容。
#   * 密钥通过 tcb login 的参数传入(本机进程列表短暂可见,与现有部署脚本一致);所有 CLI 输出都会先脱敏。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$SITE_DIR/.." && pwd)"
DIST_DIR="$SITE_DIR/dist"
AASA_PATH=".well-known/apple-app-site-association"

DRY_RUN=0; ASSUME_YES=0; DO_BUILD=1
log()  { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] ⚠ %s\n' "$*" >&2; }
die()  { printf '[deploy] 错误:%s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-build) DO_BUILD=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数:$arg(用 --help 查看用法)" ;;
  esac
done

# ---------- 读取配置 ----------
env_from_file() { # 读 .env 里某个键的最后一次取值(去引号/CR)
  local f="$ROOT_DIR/.env"
  [ -f "$f" ] || return 0
  { grep -E "^[[:space:]]*$1[[:space:]]*=" "$f" || true; } | tail -n 1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/' | tr -d '\r'
}
cfg() { local v="${!1:-}"; [ -n "$v" ] || v="$(env_from_file "$1")"; printf '%s' "$v"; }

ENV_ID="$(cfg TARO_APP_CLOUD_ENV_ID)"
SECRET_ID="$(cfg CLOUDBASE_SECRET_ID)"
SECRET_KEY="$(cfg CLOUDBASE_SECRET_KEY)"
TEAM_ID="$(cfg APPLE_TEAM_ID)"
UNIVERSAL_LINK="$(cfg TARO_APP_WX_UNIVERSAL_LINK)"

to_native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

# ---------- 前置检查 ----------
command -v node >/dev/null 2>&1 || die "未找到 node"
command -v npm  >/dev/null 2>&1 || die "未找到 npm"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "需要 Node.js ≥ 20(当前 $(node -v))"
[ -n "$TEAM_ID" ] || die "未配置 APPLE_TEAM_ID(环境变量或 .env):不替换占位就发布,Universal Link 会静默失效"
if [ "$DRY_RUN" -eq 0 ]; then
  [ -n "$ENV_ID" ]     || die "未配置 TARO_APP_CLOUD_ENV_ID"
  [ -n "$SECRET_ID" ]  || die "未配置 CLOUDBASE_SECRET_ID"
  [ -n "$SECRET_KEY" ] || die "未配置 CLOUDBASE_SECRET_KEY"
  command -v tcb >/dev/null 2>&1 || die "未找到 tcb,请先安装:npm i -g @cloudbase/cli"
fi

# ---------- 构建 ----------
cd "$SITE_DIR"
if [ "$DO_BUILD" -eq 1 ]; then
  [ -d node_modules ] || { log "安装依赖(npm ci)"; npm ci --no-audit --no-fund; }
  log "构建官网"
  npm run build
  npm run verify
else
  [ -d "$DIST_DIR" ] || die "--no-build 需要已有 dist/,请先 npm run build"
  log "跳过构建,沿用现有 dist/"
fi

# ---------- 生成并校验 AASA ----------
# 总是从 public/ 的模板重新生成,所以重复执行(含 --no-build)是幂等的。
AASA_ARGS=(--team-id "$TEAM_ID")
[ -z "$UNIVERSAL_LINK" ] || AASA_ARGS+=(--universal-link "$UNIVERSAL_LINK")
node scripts/prepare-aasa.mjs "${AASA_ARGS[@]}"
if grep -rIl "APPLE_TEAM_ID" "$DIST_DIR" >/dev/null 2>&1; then die "dist/ 中仍有未替换的 APPLE_TEAM_ID 占位"; fi

FILE_COUNT="$(find "$DIST_DIR" -type f | wc -l | tr -d ' ')"
log "待发布:dist/ 共 $FILE_COUNT 个文件(含 $AASA_PATH)"
UL_HOST=""
[ -z "$UNIVERSAL_LINK" ] || UL_HOST="$(printf '%s' "$UNIVERSAL_LINK" | sed -E 's#^https?://([^/]+).*#\1#')"

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run 完成:未登录、未上传。目标环境 ${ENV_ID:-<未配置>};Universal Link 域名 ${UL_HOST:-<未配置>}"
  exit 0
fi

# ---------- 确认 ----------
log "即将发布到 CloudBase 环境:$ENV_ID(只新增/覆盖文件,不会清理远端其他文件)"
if [ "$ASSUME_YES" -ne 1 ]; then
  [ -t 0 ] || die "非交互环境请加 --yes"
  read -r -p "[deploy] 确认发布?输入 yes 继续:" ans
  [ "$ans" = "yes" ] || die "已取消"
fi

# ---------- 隔离登录 ----------
TCB_HOME="$(mktemp -d)"
trap 'rm -rf "$TCB_HOME"; log "已删除临时登录目录"' EXIT
NATIVE_HOME="$(to_native "$TCB_HOME")"

redact() { # 脱敏:逐字替换密钥内容
  R1="$SECRET_ID" R2="$SECRET_KEY" awk 'BEGIN{a=ENVIRON["R1"];b=ENVIRON["R2"]}
    {for(i=1;i<=2;i++){s=(i==1?a:b); if(length(s)>=8){while((p=index($0,s))>0)$0=substr($0,1,p-1)"<redacted>"substr($0,p+length(s))}} print}'
}
tcb_run() { # 在隔离 HOME 下运行 tcb;返回 tcb 自身的退出码。MSYS_NO_PATHCONV 防止 Git Bash 改写参数里的路径。
  local rc
  set +e
  MSYS_NO_PATHCONV=1 HOME="$NATIVE_HOME" USERPROFILE="$NATIVE_HOME" XDG_CONFIG_HOME="$NATIVE_HOME/.config" CI=1 \
    tcb "$@" 2>&1 | redact | grep -v -E 'Loading data|New version found|Current version|npm i -g @cloudbase|tcb ai'
  rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

log "在临时目录登录(全局 tcb 登录不受影响)"
tcb_run login --apiKeyId "$SECRET_ID" --apiKey "$SECRET_KEY" || die "登录失败"
log "确认该账号能访问环境 $ENV_ID"
tcb_run hosting detail -e "$ENV_ID" || die "无法读取环境 $ENV_ID 的静态托管信息(账号与环境不匹配?)"

# ---------- 发布 ----------
DIST_NATIVE="$(to_native "$DIST_DIR")"
log "上传 dist/ 到托管根路径(--safe 先备份、失败自动回滚;--verify 上传后校验;入口页最后上传)"
tcb_run hosting deploy "$DIST_NATIVE" -e "$ENV_ID" --safe --verify --entry index.html,rules.html,404.html \
  || die "上传失败(--safe 已尝试回滚)"

# 再把 .well-known 单独上传一次:以 .well-known 目录为根时,里面的文件名不以点开头,
# 即便 CLI 在遍历 dist/ 时跳过了“点目录”,这一步也能保证 AASA 到位;已上传则只是幂等覆盖。
log "单独上传 .well-known/(Universal Link 的 AASA)"
tcb_run hosting deploy "$(to_native "$DIST_DIR/.well-known")" .well-known -e "$ENV_ID" --verify \
  || die ".well-known 上传失败"

# ---------- 上传后检查 ----------
log "检查云端是否存在 $AASA_PATH"
LIST_OUT="$(tcb_run hosting list .well-known -e "$ENV_ID" || true)"
printf '%s\n' "$LIST_OUT"
printf '%s' "$LIST_OUT" | grep -q "apple-app-site-association" \
  || die "云端 .well-known/ 下没有 apple-app-site-association,Universal Link 不会生效"

if [ -n "$UL_HOST" ] && command -v curl >/dev/null 2>&1; then
  URL="https://$UL_HOST/$AASA_PATH"
  log "线上检查 $URL(仅警告,不影响退出码;Apple 要求 HTTPS、不重定向、返回 JSON)"
  META="$(curl -sS -m 20 -o /tmp/aasa.$$ -w '%{http_code} %{content_type} %{num_redirects}' "$URL" 2>&1 || true)"
  CODE="${META%% *}"
  if [ "$CODE" = "200" ]; then
    CTYPE="$(printf '%s' "$META" | cut -d' ' -f2)"; REDIR="$(printf '%s' "$META" | awk '{print $NF}')"
    grep -q "$TEAM_ID.com.jielingzi.app" /tmp/aasa.$$ 2>/dev/null || warn "线上内容里没有找到 $TEAM_ID.com.jielingzi.app(可能是 CDN 缓存或域名指向了别处)"
    case "$CTYPE" in application/json*) : ;; *) warn "Content-Type 是 '$CTYPE' 而不是 application/json。无扩展名文件在静态托管上常见此情况,请在 Apple 验证工具里确认能否识别" ;; esac
    [ "$REDIR" = "0" ] || warn "出现了 $REDIR 次重定向,Apple 不跟随重定向,Universal Link 会失败"
    log "线上返回 200,Content-Type=$CTYPE"
  else
    warn "无法从 https://$UL_HOST 取到 AASA($META)。若自定义域名尚未解析/绑定到该托管环境,这是预期的;绑定后请重新检查"
  fi
  rm -f "/tmp/aasa.$$"
  log "Apple CDN 视角的验证:https://app-site-association.cdn-apple.com/a/v1/$UL_HOST(注意 Apple 会缓存)"
fi

log "发布完成"
