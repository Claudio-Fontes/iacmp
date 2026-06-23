// Trava de segurança: esses testes fazem deploy/destroy REAL na AWS. Roda só
// se AWS_PROFILE apontar explicitamente pro profile dedicado (iacmp-e2e-test,
// IAM least-privilege, não a root key) — nunca por engano com outra credencial.
module.exports = async function globalSetup() {
  if (process.env.AWS_PROFILE !== 'iacmp-e2e') {
    throw new Error(
      'AWS_PROFILE precisa ser exatamente "iacmp-e2e" pra rodar os testes de e2e-aws ' +
      '(testes fazem deploy/destroy real na AWS). Rode com:\n' +
      '  AWS_PROFILE=iacmp-e2e npm run test:e2e'
    );
  }
};
