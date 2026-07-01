// Cloudflare Worker to proxy /api/* to backend Droplet
// Deploy this at: Cloudflare Dashboard → Workers & Pages → Create Worker

const BACKEND_API_URL = 'https://api.epicglobal.app';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Proxy /api/* requests to backend
    if (url.pathname.startsWith('/api/')) {
      const backendUrl = new URL(url.pathname + url.search, BACKEND_API_URL);

      // Preserve WebSocket upgrades exactly (required for /api/terminal).
      const isWebSocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
      if (isWebSocket) {
        return fetch(new Request(backendUrl.toString(), request));
      }

      // Handle CORS preflight for normal HTTP API requests.
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': url.origin,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400',
          },
        });
      }

      const response = await fetch(new Request(backendUrl.toString(), request));

      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', url.origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    
    // For all other requests, fetch from origin (static site)
    return fetch(request);
  },
};
