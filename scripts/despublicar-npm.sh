#!/usr/bin/env bash
# Despublica todos os pacotes iacmp do npm público.
#
# ORDEM OBRIGATÓRIA (reverse-topológica). O npm recusa despublicar um pacote
# enquanto outro pacote no registro público depender dele:
#
#   iacmp  →  @iacmp/core, @iacmp/mcp, @iacmp/runtime
#   @iacmp/mcp  →  @iacmp/knowledge
#
# Por isso `iacmp` sai primeiro e `@iacmp/knowledge` sai por último.
#
# Uso:
#   ./scripts/despublicar-npm.sh              # simulação (não altera nada)
#   ./scripts/despublicar-npm.sh --executar   # despublica de verdade
#   ./scripts/despublicar-npm.sh --executar --otp 123456

set -o pipefail

EXECUTAR=0
OTP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --executar) EXECUTAR=1; shift ;;
    --otp) OTP="$2"; shift 2 ;;
    *) echo "argumento desconhecido: $1"; exit 1 ;;
  esac
done

PACOTES=(iacmp @iacmp/mcp @iacmp/core @iacmp/runtime @iacmp/knowledge)

echo "== conta npm =="
USUARIO=$(npm whoami 2>/dev/null) || { echo "ERRO: não autenticado. Rode 'npm login'."; exit 1; }
echo "autenticado como: $USUARIO"
echo

echo "== estado atual =="
for p in "${PACOTES[@]}"; do
  v=$(npm view "$p" version 2>/dev/null)
  [ -n "$v" ] && echo "  publicado  $p@$v" || echo "  ausente    $p"
done
echo

if [ "$EXECUTAR" -eq 0 ]; then
  echo "SIMULAÇÃO — nada foi alterado."
  echo "Comandos que seriam executados, nesta ordem:"
  for p in "${PACOTES[@]}"; do echo "  npm unpublish $p --force"; done
  echo
  echo "Rode de novo com --executar para valer."
  exit 0
fi

echo "!! IRREVERSÍVEL !!"
echo "Serão removidas TODAS as versões dos ${#PACOTES[@]} pacotes acima."
echo "Números de versão já usados nunca poderão ser reaproveitados (republique como 3.0.0)."
echo "O nome fica bloqueado por 24h antes de aceitar publicação nova."
echo
read -r -p "Digite DESPUBLICAR para confirmar: " CONFIRMA
[ "$CONFIRMA" = "DESPUBLICAR" ] || { echo "abortado."; exit 1; }
echo

OTP_ARGS=""
[ -n "$OTP" ] && OTP_ARGS="--otp $OTP"

FALHAS=0
for p in "${PACOTES[@]}"; do
  if [ -z "$(npm view "$p" version 2>/dev/null)" ]; then
    echo "-- $p já ausente, pulando"
    continue
  fi
  echo "-- despublicando $p"
  if npm unpublish "$p" --force $OTP_ARGS; then
    echo "   ok"
  else
    echo "   FALHOU — veja a mensagem acima (dependente restante, 2FA ou critério de política)"
    FALHAS=$((FALHAS+1))
  fi
  sleep 3
done

echo
echo "== verificação final =="
for p in "${PACOTES[@]}"; do
  v=$(npm view "$p" version 2>/dev/null)
  [ -n "$v" ] && echo "  AINDA PUBLICADO  $p@$v" || echo "  removido         $p"
done

echo
if [ "$FALHAS" -eq 0 ]; then
  echo "Concluído. Próximos passos: trocar o LICENSE (MIT → proprietário)"
  echo "e remover o LICENSE do prepack/files em packages/cli/package.json."
else
  echo "$FALHAS pacote(s) falharam. O motivo mais comum é dependente ainda no registro:"
  echo "espere alguns minutos a propagação e rode de novo."
fi
