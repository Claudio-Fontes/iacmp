/**
 * Gera o adapter de uma Fn.Lambda acionada por fila (eventSources[].queueId →
 * Service Bus, ver AzureFunctionMeta.sbTrigger em bicep.ts) para o binding
 * `serviceBusTrigger` clássico do Azure Functions v4 (Node, non-isolated).
 *
 * O código retornado roda DENTRO da Function App — por isso é uma string de JS
 * puro, não TypeScript compilado (mesmo padrão do HttpTrigger/index.js gerado
 * por http-trigger-wrapper.ts).
 *
 * O host entrega a mensagem já desserializada quando dá para fazer parse de
 * JSON (objeto) ou como string/Buffer crua caso contrário — normaliza SEMPRE
 * para uma STRING (JSON.stringify se veio objeto), porque os handlers do
 * corpus (mesmos usados no worker SQS da AWS) fazem `JSON.parse(record.body)`
 * — `body` tem que ser string, igual ao contrato Lambda/SQS.
 *
 * Propositalmente SEM try/catch ao redor de `handler(...)`: uma exceção do
 * handler deve PROPAGAR para o host — é o sinal que ativa o abandon do
 * peek-lock (retry) e, após esgotar `maxDeliveryCount`, o dead-lettering
 * nativo do Service Bus. Engolir o erro aqui faria a mensagem ser completada
 * (ack) mesmo quando o processamento falhou, perdendo a mensagem.
 */
export function renderServiceBusTriggerWrapper(): string {
  return `'use strict';
const { handler } = require('../handler');

module.exports = async function (context, msg) {
  let body;
  if (typeof msg === 'string') {
    body = msg;
  } else if (Buffer.isBuffer(msg)) {
    body = msg.toString('utf8');
  } else {
    body = JSON.stringify(msg);
  }

  const messageId = (context.bindingData && context.bindingData.messageId) || undefined;

  await handler({ Records: [{ body: body, messageId: messageId }] }, {});
};
`;
}
