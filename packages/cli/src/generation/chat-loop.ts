import ora from 'ora';
import { AIProvider, ChatSession } from '@iacmp/ai';

// Streaming da geração inicial: mostra o spinner "Gerando..." e vai anunciando
// cada arquivo conforme os "path" aparecem no JSON em construção. Retorna o texto
// bruto acumulado, ou null se a chamada à IA falhar (o spinner já reporta o erro).
//
// discardStdin: false — por padrão a ora cria sua PRÓPRIA readline.Interface em
// process.stdin pra capturar Ctrl+C enquanto o spinner gira, e o close() dela ao
// terminar quebra a nossa interface (createDirectAsk) pra qualquer pergunta feita
// DEPOIS do spinner. Só acontece com stdin TTY, por isso não aparece em testes.
export async function streamInitial(provider: AIProvider, session: ChatSession): Promise<string | null> {
  const spinner = ora({ text: 'Gerando...', spinner: 'dots', discardStdin: false }).start();
  const chunks: string[] = [];
  let accumulated = '';
  const announced = new Set<string>();
  try {
    await provider.stream(session.getMessages(), chunk => {
      chunks.push(chunk);
      accumulated += chunk;
      const pathRegex = /"path"\s*:\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = pathRegex.exec(accumulated)) !== null) {
        if (!announced.has(m[1])) {
          announced.add(m[1]);
          spinner.text = `Gerando ${m[1]}...`;
        }
      }
    });
  } catch (err) {
    spinner.fail('Erro ao chamar a IA: ' + (err as Error).message);
    return null;
  }
  spinner.succeed('Resposta recebida');
  return chunks.join('');
}

// Streaming simples (sem spinner nem anúncio de paths): acumula os chunks e
// devolve o texto bruto. Usado nas rodadas de revisão/correção, onde o spinner é
// gerenciado por quem chama. Propaga o erro da IA para o chamador tratar.
export async function streamRaw(provider: AIProvider, session: ChatSession): Promise<string> {
  const chunks: string[] = [];
  await provider.stream(session.getMessages(), chunk => chunks.push(chunk));
  return chunks.join('');
}
