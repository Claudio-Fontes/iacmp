import { createServer } from './server';
import { ProjectInfo } from './ui';

export { ProjectInfo, StackInfo } from './ui';

/**
 * Sobe o dashboard local. Bind em 127.0.0.1 por padrão: o servidor não tem
 * autenticação e mostra metadados da infraestrutura do usuário — escutar em
 * 0.0.0.0 numa rede compartilhada (café, coworking, CI) exporia isso a
 * qualquer um na mesma rede. Para expor de propósito, passe `host`
 * explicitamente (achado P2-05 da auditoria de segurança de 2026-07-31).
 */
export function startDashboard(info: ProjectInfo, port: number, host = '127.0.0.1'): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer(info);
    server.on('error', reject);
    server.listen(port, host, () => resolve());
  });
}
