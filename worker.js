/* Optional Cloudflare Worker: use it only if the plugin reports
   "Нет доступа к API (сеть или CORS)". Forwards GET /api/v1/* and adds CORS headers. */
const API_ORIGIN = "https://aniliberty.top";
const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept"
};

export default {
    async fetch(request) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS });
        }
        const url = new URL(request.url);
        if (request.method !== "GET" || !url.pathname.startsWith("/api/v1/")) {
            return new Response("Not found", { status: 404, headers: CORS });
        }
        const upstream = await fetch(API_ORIGIN + url.pathname + url.search, {
            headers: { Accept: "application/json" }
        });
        const response = new Response(upstream.body, upstream);
        Object.entries(CORS).forEach(([key, value]) => response.headers.set(key, value));
        return response;
    }
};
