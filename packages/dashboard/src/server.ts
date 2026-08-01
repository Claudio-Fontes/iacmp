import * as http from 'http';
import { generateHtml, ProjectInfo } from './ui';

export function createServer(info: ProjectInfo): http.Server {
  return http.createServer((req, res) => {
    // Só a raiz responde conteúdo — qualquer outro caminho é 404 (o dashboard
    // não serve arquivos; responder o mesmo HTML em toda rota confunde scanners
    // e esconde erro de digitação do usuário).
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== '/' && pathname !== '/index.html') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const html = generateHtml(info);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      // O dashboard mostra metadados da infraestrutura do usuário (nomes de
      // stacks/recursos): headers defensivos mínimos para não virar vetor de
      // clickjacking/sniffing se alguém expuser a porta.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  });
}
