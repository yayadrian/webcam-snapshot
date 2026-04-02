import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { extractYouTubeVideoId, getYouTubeThumbnail } from "./youtube-snapshot.ts";

Deno.test("extractYouTubeVideoId - watch URL", () => {
  assertEquals(
    extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "dQw4w9WgXcQ",
  );
});

Deno.test("extractYouTubeVideoId - watch URL with extra params", () => {
  assertEquals(
    extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42"),
    "dQw4w9WgXcQ",
  );
});

Deno.test("extractYouTubeVideoId - short URL", () => {
  assertEquals(
    extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ"),
    "dQw4w9WgXcQ",
  );
});

Deno.test("extractYouTubeVideoId - embed URL", () => {
  assertEquals(
    extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"),
    "dQw4w9WgXcQ",
  );
});

Deno.test("extractYouTubeVideoId - invalid URL returns null", () => {
  assertEquals(extractYouTubeVideoId("https://example.com"), null);
});

Deno.test("extractYouTubeVideoId - empty string returns null", () => {
  assertEquals(extractYouTubeVideoId(""), null);
});

Deno.test("extractYouTubeVideoId - random text returns null", () => {
  assertEquals(extractYouTubeVideoId("not a url at all"), null);
});

// Thumbnail fallback tests using fetch stubs

function stubFetch(responses: Map<string, { ok: boolean; status: number; body: Uint8Array }>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const stub = responses.get(url);
    if (stub) {
      return Promise.resolve(new Response(stub.body as unknown as BodyInit, { status: stub.status }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };
  return () => { globalThis.fetch = originalFetch; };
}

Deno.test("getYouTubeThumbnail - skips placeholder-sized live/maxres, uses hqdefault", async () => {
  const smallPlaceholder = new Uint8Array(1000); // <5KB placeholder
  const validImage = new Uint8Array(10000);      // >5KB real image
  crypto.getRandomValues(validImage);

  const responses = new Map([
    ["https://img.youtube.com/vi/testid123/live.jpg", { ok: true, status: 200, body: smallPlaceholder }],
    ["https://img.youtube.com/vi/testid123/maxresdefault.jpg", { ok: true, status: 200, body: smallPlaceholder }],
    ["https://img.youtube.com/vi/testid123/hqdefault.jpg", { ok: true, status: 200, body: validImage }],
  ]);

  const restore = stubFetch(responses);
  try {
    const result = await getYouTubeThumbnail("testid123", "test-timestamp");
    assertEquals(result.jpgFilename, "youtube-testid123-test-timestamp.jpg");
    assertEquals(result.gifFilename, "youtube-testid123-test-timestamp.gif");
  } finally {
    restore();
    // Clean up test files
    await Deno.remove("youtube-snapshots/youtube-testid123-test-timestamp.jpg").catch(() => {});
    await Deno.remove("youtube-snapshots/youtube-testid123-test-timestamp.gif").catch(() => {});
  }
});

Deno.test("getYouTubeThumbnail - accepts small hqdefault without size check", async () => {
  const smallButValid = new Uint8Array(2000); // <5KB but hqdefault should still be accepted
  crypto.getRandomValues(smallButValid);

  const responses = new Map([
    ["https://img.youtube.com/vi/smallid/live.jpg", { ok: false, status: 404, body: new Uint8Array(0) }],
    ["https://img.youtube.com/vi/smallid/maxresdefault.jpg", { ok: false, status: 404, body: new Uint8Array(0) }],
    ["https://img.youtube.com/vi/smallid/hqdefault.jpg", { ok: true, status: 200, body: smallButValid }],
  ]);

  const restore = stubFetch(responses);
  try {
    const result = await getYouTubeThumbnail("smallid", "test-ts");
    assertEquals(result.jpgFilename, "youtube-smallid-test-ts.jpg");
  } finally {
    restore();
    await Deno.remove("youtube-snapshots/youtube-smallid-test-ts.jpg").catch(() => {});
    await Deno.remove("youtube-snapshots/youtube-smallid-test-ts.gif").catch(() => {});
  }
});

Deno.test("getYouTubeThumbnail - throws when all thumbnails fail", async () => {
  const responses = new Map([
    ["https://img.youtube.com/vi/failid/live.jpg", { ok: false, status: 404, body: new Uint8Array(0) }],
    ["https://img.youtube.com/vi/failid/maxresdefault.jpg", { ok: false, status: 404, body: new Uint8Array(0) }],
    ["https://img.youtube.com/vi/failid/hqdefault.jpg", { ok: false, status: 404, body: new Uint8Array(0) }],
  ]);

  const restore = stubFetch(responses);
  try {
    await assertRejects(
      () => getYouTubeThumbnail("failid", "test-ts"),
      Error,
      "Failed to download any valid thumbnail",
    );
  } finally {
    restore();
  }
});
