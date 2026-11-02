import { createGrowthServer } from './scripts/serve.mjs';

const server = createGrowthServer();
export default function handler(request, response) {
  if ((request.url ?? '').split('?')[0] !== '/api/orgs/set-active' || request.method !== 'POST') {
    response.writeHead(404, { 'cache-control': 'no-store' });
    response.end();
    return;
  }
  server.emit('request', request, response);
}
