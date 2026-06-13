import { createServer } from './server';
import { ProjectInfo } from './ui';

export { ProjectInfo, StackInfo } from './ui';

export function startDashboard(info: ProjectInfo, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer(info);
    server.on('error', reject);
    server.listen(port, () => resolve());
  });
}
