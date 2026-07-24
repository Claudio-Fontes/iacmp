#!/usr/bin/env bash
#
# Publica todos os pacotes do iacmp no npm, na ORDEM de dependência:
#   @iacmp/core → @iacmp/runtime → @iacmp/knowledge → @iacmp/mcp → iacmp (CLI)
#
# O @iacmp/mcp vem ANTES do CLI: a CLI passou a depender de @iacmp/mcp (para
# `iacmp mcp serve` / `iacmp setup`). Publicar o CLI antes do mcp abriria uma
# janela em que `iacmp` existe mas seu dep `@iacmp/mcp` ainda não — quebrando o
# `npm install -g iacmp` de quem instalasse nesse intervalo.
#
# Idempotente: pula os pacotes cuja versão já está no registro — se um OTP
# expirar ou algo falhar no meio, é só re-executar que ele continua de onde parou.
# Usa o authToken do ~/.npmrc (sem login interativo).
#
# Uso:
#   ./scripts/publish-release.sh                 # publica
#   ./scripts/publish-release.sh --dry-run       # simula (npm publish --dry-run), não envia nada
#   ./scripts/publish-release.sh --otp 123456    # se a conta exigir 2FA em cada publish
#
set -eo pipefail

NPM_FLAGS=()
DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --otp)     NPM_FLAGS+=(--otp "$2"); shift 2 ;;
    --dry-run) DRY=1; NPM_FLAGS+=(--dry-run); shift ;;
    *) echo "flag desconhecida: $1 (use --otp <código> ou --dry-run)"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MCP="${IACMP_MCP_DIR:-$HOME/Projetos/iacmp-mcp}"

echo "▸ Build de todos os pacotes do monorepo..."
( cd "$ROOT" && npx turbo run build )

publish_pkg() {
  local dir="$1"
  local name version
  name="$(node -p "require('$dir/package.json').name")"
  version="$(node -p "require('$dir/package.json').version")"
  if [[ $DRY -eq 0 ]] && npm view "$name@$version" version >/dev/null 2>&1; then
    echo "✔ $name@$version já está no npm — pulando."
    return 0
  fi
  echo "▸ Publicando $name@$version ..."
  ( cd "$dir" && npm publish "${NPM_FLAGS[@]}" )
  echo "✔ $name@$version ok."
}

publish_pkg "$ROOT/packages/core"
publish_pkg "$ROOT/packages/runtime"
publish_pkg "$ROOT/packages/knowledge"

# @iacmp/mcp (repo separado) ANTES do CLI — a CLI depende dele.
echo "▸ Build do @iacmp/mcp (repo separado: $MCP) ..."
( cd "$MCP" && npm run build )
publish_pkg "$MCP"

publish_pkg "$ROOT/packages/cli"

echo ""
if [[ $DRY -eq 1 ]]; then
  echo "✅ Dry-run concluído — NADA foi publicado. Rode sem --dry-run para publicar de verdade."
else
  echo "✅ Release publicado."
  echo "   Valide numa máquina limpa (o @iacmp/mcp vem junto como dependência):"
  echo "     npm install -g iacmp && iacmp --version      # esperado: 2.3.0"
  echo "     iacmp setup                                  # registra o MCP no Claude"
fi
