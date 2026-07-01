// Cloudflare Worker to proxy /api/* to backend Droplet
// Deploy this at: Cloudflare Dashboard → Workers & Pages → Create Worker

const BACKEND_API_URL = 'YOUR_DROPLET_BACKEND_URL'; // e.g., 'https://api.epicglobal.app' or 'http://123.45.67.89:3000'

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Proxy /api/* requests to backend
    if (url.pathname.startsWith('/api/')) {
      const backendUrl = new URL(url.pathname + url.search, BACKEND_API_URL);
      
      // Forward the request to backend
      const backendRequest = new Request(backendUrl, {
        method: request.method,
        headers: request.headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      });
      
      // Get response from backend
      const response = await fetch(backendRequest);
      
      // Add CORS headers if needed
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', url.origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
      
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
