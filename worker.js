/* Optional Cloudflare Worker: use it only if the plugin reports
   "Нет доступа к API (сеть или CORS)". Forwards /api/v1/* and adds CORS headers. Keeps nothing. */
const API_ORIGIN = "https://aniliberty.top";
const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Authorization, Content-Type"
};

export default {
    async fetch(request) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS });
        }
        const url = new URL(request.url);
        if (!url.pathname.startsWith("/api/v1/")) {
            return new Response("Not found", { status: 404, headers: CORS });
        }
        const headers = { Accept: "application/json" };
        ["Authorization", "Content-Type"].forEach((name) => {
            if (request.headers.has(name)) { headers[name] = request.headers.get(name); }
        });
        const upstream = await fetch(API_ORIGIN + url.pathname + url.search, {
            method: request.method,
            headers,
            body: request.method === "GET" ? undefined : await request.text()
        });
        const response = new Response(upstream.body, upstream);
        Object.entries(CORS).forEach(([key, value]) => response.headers.set(key, value));
        return response;
    }
};
