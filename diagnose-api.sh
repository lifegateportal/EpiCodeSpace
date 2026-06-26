#!/bin/bash
# API Diagnostics for EpiCodeSpace

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  EpiCodeSpace API Diagnostics"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Test 1: Check production site API
echo "1️⃣  Testing production API: https://epicodespace.epicglobal.app/api/chat"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
curl -s -w "\nHTTP Status: %{http_code}\nResponse Time: %{time_total}s\n" \
  -X POST "https://epicodespace.epicglobal.app/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"agent":"epicode-agent","messages":[{"role":"user","content":"test"}],"context":{},"mode":"ask"}' \
  | head -20
echo ""
echo ""

# Test 2: Check if API endpoint exists at all
echo "2️⃣  Testing if /api/chat endpoint is reachable"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
curl -s -I "https://epicodespace.epicglobal.app/api/chat" 2>&1 | head -10
echo ""
echo ""

# Test 3: Check CORS headers
echo "3️⃣  Checking CORS configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
curl -s -H "Origin: https://epicodespace.epicglobal.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -X OPTIONS "https://epicodespace.epicglobal.app/api/chat" -I 2>&1 | grep -i "access-control"
echo ""
echo ""

# Test 4: Check if it's a routing issue
echo "4️⃣  Testing if /api path is being served at all"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
curl -s -I "https://epicodespace.epicglobal.app/api/" 2>&1 | head -5
echo ""
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Diagnosis Complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 Next Steps:"
echo "   • If Test 1 shows 404: API route not configured in Cloudflare"
echo "   • If Test 1 shows 500/502: Backend Droplet API is down"
echo "   • If Test 1 shows 403: CORS blocking the request"
echo "   • If Test 1 shows 429: Rate limit hit"
echo "   • If Test 1 shows 200 but 'missing key': Env vars not set on Droplet"
echo ""
