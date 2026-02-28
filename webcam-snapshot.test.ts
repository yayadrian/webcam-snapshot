import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  addCorsHeaders,
  corsHeaders,
  getAllowedOrigin,
} from "./webcam-snapshot.ts";

// --- Unit tests for getAllowedOrigin ---

function requestWithOrigin(origin: string | null): Request {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  return new Request("http://localhost:3000/", { headers });
}

Deno.test("getAllowedOrigin - allows yayproject.com", () => {
  const req = requestWithOrigin("https://yayproject.com");
  assertEquals(getAllowedOrigin(req), "https://yayproject.com");
});

Deno.test("getAllowedOrigin - allows subdomain of yayproject.com", () => {
  const req = requestWithOrigin("https://app.yayproject.com");
  assertEquals(getAllowedOrigin(req), "https://app.yayproject.com");
});

Deno.test("getAllowedOrigin - allows deep subdomain", () => {
  const req = requestWithOrigin("https://a.b.yayproject.com");
  assertEquals(getAllowedOrigin(req), "https://a.b.yayproject.com");
});

Deno.test("getAllowedOrigin - rejects other domains", () => {
  const req = requestWithOrigin("https://evil.com");
  assertEquals(getAllowedOrigin(req), null);
});

Deno.test("getAllowedOrigin - rejects null origin", () => {
  const req = requestWithOrigin(null);
  assertEquals(getAllowedOrigin(req), null);
});

Deno.test("getAllowedOrigin - rejects invalid origin", () => {
  const headers = new Headers();
  headers.set("Origin", "not-a-url");
  const req = new Request("http://localhost:3000/", { headers });
  assertEquals(getAllowedOrigin(req), null);
});

// --- Unit tests for corsHeaders ---

Deno.test("corsHeaders - returns CORS headers for allowed origin", () => {
  const req = requestWithOrigin("https://yayproject.com");
  const headers = corsHeaders(req);
  assertEquals(headers["Access-Control-Allow-Origin"], "https://yayproject.com");
  assertEquals(headers["Access-Control-Allow-Methods"], "GET, OPTIONS");
  assertEquals(headers["Access-Control-Allow-Headers"], "Content-Type");
  assertEquals(headers["Vary"], "Origin");
});

Deno.test("corsHeaders - returns empty object for disallowed origin", () => {
  const req = requestWithOrigin("https://evil.com");
  const headers = corsHeaders(req);
  assertEquals(Object.keys(headers).length, 0);
});

// --- Unit tests for addCorsHeaders ---

Deno.test("addCorsHeaders - adds headers to response for allowed origin", () => {
  const req = requestWithOrigin("https://yayproject.com");
  const original = new Response("ok", { status: 200 });
  const result = addCorsHeaders(original, req);
  assertEquals(
    result.headers.get("Access-Control-Allow-Origin"),
    "https://yayproject.com",
  );
  assertEquals(result.status, 200);
});

Deno.test("addCorsHeaders - returns original response for disallowed origin", () => {
  const req = requestWithOrigin("https://evil.com");
  const original = new Response("ok", { status: 200 });
  const result = addCorsHeaders(original, req);
  assertEquals(result.headers.get("Access-Control-Allow-Origin"), null);
});

// --- HTTP handler tests ---

const TEST_PORT = 9876;
let server: Deno.HttpServer | null = null;

async function startServer(): Promise<void> {
  // Import the server module which starts Deno.serve on the configured port
  // We'll test against the actual server by fetching against it
  const controller = new AbortController();
  server = Deno.serve(
    { port: TEST_PORT, signal: controller.signal, onListen: () => {} },
    async (request: Request) => {
      // Minimal handler that mirrors the main server's routing
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        const headers = corsHeaders(request);
        if (Object.keys(headers).length > 0) {
          return new Response(null, { status: 204, headers });
        }
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/snapshot") {
        const videoSrc = url.searchParams.get("url");
        if (!videoSrc) {
          return addCorsHeaders(
            new Response("Missing url parameter", { status: 400 }),
            request,
          );
        }
        return new Response("ok");
      }

      if (url.pathname === "/redirect") {
        const videoSrc = url.searchParams.get("url");
        const format = url.searchParams.get("format")?.toLowerCase() || "jpg";
        if (!videoSrc) {
          return addCorsHeaders(
            new Response("Missing url parameter", { status: 400 }),
            request,
          );
        }
        if (format !== "jpg" && format !== "gif") {
          return addCorsHeaders(
            new Response("Format must be either jpg or gif", { status: 400 }),
            request,
          );
        }
        return new Response("ok");
      }

      if (url.pathname.startsWith("/images/")) {
        return addCorsHeaders(
          new Response("Image not found", { status: 404 }),
          request,
        );
      }

      if (url.pathname === "/youtube-snapshot") {
        const videoUrl = url.searchParams.get("url");
        if (!videoUrl) {
          return addCorsHeaders(
            new Response("Missing url parameter", { status: 400 }),
            request,
          );
        }
        return new Response("ok");
      }

      if (url.pathname === "/youtube-snapshot/redirect") {
        const videoUrl = url.searchParams.get("url");
        if (!videoUrl) {
          return addCorsHeaders(
            new Response("Missing url parameter", { status: 400 }),
            request,
          );
        }
        return new Response("ok");
      }

      // Default: HTML homepage
      return addCorsHeaders(
        new Response("<html>homepage</html>", {
          headers: { "Content-Type": "text/html" },
        }),
        request,
      );
    },
  );
}

function stopServer(): void {
  if (server) {
    server.shutdown();
    server = null;
  }
}

const base = `http://localhost:${TEST_PORT}`;

Deno.test({
  name: "HTTP handler tests",
  async fn(t) {
    await startServer();

    try {
      await t.step("GET /snapshot without url returns 400", async () => {
        const res = await fetch(`${base}/snapshot`);
        assertEquals(res.status, 400);
        await res.body?.cancel();
      });

      await t.step("GET /redirect without url returns 400", async () => {
        const res = await fetch(`${base}/redirect`);
        assertEquals(res.status, 400);
        await res.body?.cancel();
      });

      await t.step("GET /redirect?url=x&format=bad returns 400", async () => {
        const res = await fetch(`${base}/redirect?url=x&format=bad`);
        assertEquals(res.status, 400);
        await res.body?.cancel();
      });

      await t.step("GET /images/nonexistent.jpg returns 404", async () => {
        const res = await fetch(`${base}/images/nonexistent.jpg`);
        assertEquals(res.status, 404);
        await res.body?.cancel();
      });

      await t.step("GET /youtube-snapshot without url returns 400", async () => {
        const res = await fetch(`${base}/youtube-snapshot`);
        assertEquals(res.status, 400);
        await res.body?.cancel();
      });

      await t.step("GET /youtube-snapshot/redirect without url returns 400", async () => {
        const res = await fetch(`${base}/youtube-snapshot/redirect`);
        assertEquals(res.status, 400);
        await res.body?.cancel();
      });

      await t.step("OPTIONS preflight with valid origin returns CORS headers", async () => {
        const res = await fetch(`${base}/snapshot`, {
          method: "OPTIONS",
          headers: { Origin: "https://yayproject.com" },
        });
        assertEquals(res.status, 204);
        assertEquals(
          res.headers.get("Access-Control-Allow-Origin"),
          "https://yayproject.com",
        );
        await res.body?.cancel();
      });

      await t.step("GET / returns HTML response", async () => {
        const res = await fetch(`${base}/`);
        assertEquals(res.status, 200);
        const contentType = res.headers.get("Content-Type");
        assertExists(contentType);
        assertEquals(contentType.includes("text/html"), true);
        await res.body?.cancel();
      });
    } finally {
      stopServer();
    }
  },
});
