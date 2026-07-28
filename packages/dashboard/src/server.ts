import * as http from 'http';
import { generateHtml, ProjectInfo } from './ui';

export function createServer(info: ProjectInfo): http.Server {
  return http.createServer((_req, res) => {
    const html = generateHtml(info);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
  });
}
