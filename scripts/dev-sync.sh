#!/usr/bin/env bash
# dev-sync.sh — builda o monorepo e garante que o `iacmp` global aponta pro código local.
#
# Resolve o problema de "duas versões de iacmp na máquina": depois de qualquer
# mudança no código, rode `npm run sync` (ou ./scripts/dev-sync.sh) e o comando
# `iacmp` em QUALQUER pasta passa a refletir o código do monorepo.
#
# Uso:
#   npm run sync           # instala deps (se preciso) + build + link + verificação
#   npm run sync -- --test # idem, rodando a suíte completa de testes antes do link
#
# NUNCA rode `npm install -g iacmp` nesta máquina — isso troca o global pela
# versão publicada no npm e desfaz o link (foi a causa do caos de 2026-07-03).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
RUN_TESTS=false
[ "${1:-}" = "--test" ] && RUN_TESTS=true

step() { printf '\n== %s\n' "$1"; }
fail() { printf '\nERRO: %s\n' "$1" >&2; exit 1; }

cd "$REPO_ROOT"

step "1/5 Dependências (npm install se o lockfile mudou)"
npm install --no-audit --no-fund 2>&1 | tail -1

step "2/5 Build de todos os pacotes"
npx turbo run build --force 2>&1 | grep -E "Tasks:" || fail "build falhou — rode 'npx turbo run build --force' para ver o erro"

if $RUN_TESTS; then
  step "2.5/5 Testes (--test)"
  npx turbo run test --force 2>&1 | grep -E "Tests:|Tasks:" || fail "testes falharam"
fi

step "3/5 Link global -> monorepo"
(cd "$CLI_DIR" && npm link --no-audit --no-fund 2>&1 | tail -1)

step "4/5 Verificação do binário global"
GLOBAL_PREFIX="$(npm prefix -g)"
LINK_TARGET="$(readlink "$GLOBAL_PREFIX/lib/node_modules/iacmp" 2>/dev/null || true)"
RESOLVED="$(cd "$GLOBAL_PREFIX/lib/node_modules" 2>/dev/null && cd "$LINK_TARGET" 2>/dev/null && pwd || true)"
if [ "$RESOLVED" != "$CLI_DIR" ]; then
  fail "o iacmp global NÃO aponta pro monorepo (aponta para: ${RESOLVED:-instalação do npm}). Rode: cd $CLI_DIR && npm link"
fi
BIN_PATH="$(command -v iacmp || true)"
[ -n "$BIN_PATH" ] || fail "comando 'iacmp' não encontrado no PATH ($GLOBAL_PREFIX/bin precisa estar no PATH)"

step "5/5 Smoke test do binário"
VERSION_OUT="$(iacmp --version 2>&1 | head -1)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"

printf '\nOK — iacmp global sincronizado com o monorepo.\n'
printf '   binário : %s\n' "$BIN_PATH"
printf '   alvo    : %s\n' "$CLI_DIR"
printf '   versão  : %s\n' "$VERSION_OUT"
printf '   commit  : %s (%s)\n' "$COMMIT" "$(git -C "$REPO_ROOT" branch --show-current)"
