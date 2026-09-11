/**
 * Cloudflare Worker entrypoint for hosting the built SPA (dist/) as static assets.
 *
 * By default, Workers Static Assets serves any file that exists in ./dist
 * without invoking this Worker. This handler only runs for requests that do
 * NOT match a static asset (e.g. /api/*).
 */

interface AssetBinding {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

interface Env {
  ASSETS: AssetBinding;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The Vite dev/preview server exposes /api/levels, /api/songs and
    // /api/host-info. None of these are meaningful on the edge: the client
    // already falls back to the static /levels/levels.json that is generated
    // at build time, and /api/host-info only matters for local LAN QR codes.
    // Return a JSON 404 so the client's graceful fallbacks kick in.
    if (url.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Fall through to the static asset binding (e.g. for /, /assets/*.js).
    return env.ASSETS.fetch(request);
  },
};
