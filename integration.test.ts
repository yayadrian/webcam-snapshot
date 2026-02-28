import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

const TEST_PORT = 9877;
const base = `http://localhost:${TEST_PORT}`;

// Start the real server by importing the module with a custom port
let serverProcess: Deno.ChildProcess;

function startServer(): Promise<void> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      "--import-map=import_map.json",
      "webcam-snapshot.ts",
    ],
    env: {
      PORT: String(TEST_PORT),
      PUBLIC_URL: `http://localhost:${TEST_PORT}`,
    },
    stdout: "piped",
    stderr: "piped",
  });
  serverProcess = cmd.spawn();

  // Wait for server to be ready by polling
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server failed to start within 10s")), 10_000);
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`${base}/`);
        await res.body?.cancel();
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      } catch {
        // not ready yet
      }
    }, 200);
  });
}

function stopServer(): void {
  try {
    serverProcess.kill("SIGTERM");
  } catch {
    // already stopped
  }
}

async function cleanupFiles(filenames: string[], dir: string): Promise<void> {
  for (const name of filenames) {
    try {
      await Deno.remove(`${dir}/${name}`);
    } catch {
      // file may not exist
    }
  }
}

function extractFilename(imageUrl: string): string {
  return imageUrl.split("/").pop()!;
}

const MIN_IMAGE_SIZE = 1024; // real images should be at least 1KB

function assertValidJpg(buf: ArrayBuffer): void {
  const bytes = new Uint8Array(buf);
  assertEquals(bytes[0], 0xFF, "JPG should start with FF");
  assertEquals(bytes[1], 0xD8, "JPG byte 2 should be D8");
  assertEquals(bytes[2], 0xFF, "JPG byte 3 should be FF");
  assertEquals(buf.byteLength >= MIN_IMAGE_SIZE, true, `JPG should be at least ${MIN_IMAGE_SIZE} bytes, got ${buf.byteLength}`);
}

function assertValidGif(buf: ArrayBuffer): void {
  const header = new TextDecoder().decode(new Uint8Array(buf, 0, 6));
  assertEquals(header === "GIF89a" || header === "GIF87a", true, `GIF should start with GIF89a or GIF87a, got ${header}`);
  assertEquals(buf.byteLength >= MIN_IMAGE_SIZE, true, `GIF should be at least ${MIN_IMAGE_SIZE} bytes, got ${buf.byteLength}`);
}

Deno.test({
  name: "Integration: webcam snapshot creates JPG and GIF",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServer();
    const filesToClean: string[] = [];

    try {
      // Hit the real /snapshot endpoint with a live HLS stream
      const res = await fetch(
        `${base}/snapshot?url=https://camsecure.co/HLS/swanagecamlifeboat.m3u8`,
      );
      assertEquals(res.status, 200);

      const json = await res.json();
      assertExists(json.jpgUrl, "Response should contain jpgUrl");
      assertExists(json.gifUrl, "Response should contain gifUrl");

      // Extract filenames for cleanup
      filesToClean.push(extractFilename(json.jpgUrl));
      filesToClean.push(extractFilename(json.gifUrl));

      // Fetch the JPG image from the server
      const jpgRes = await fetch(json.jpgUrl);
      assertEquals(jpgRes.status, 200);
      assertEquals(jpgRes.headers.get("content-type"), "image/jpeg");
      const jpgBody = await jpgRes.arrayBuffer();
      assertValidJpg(jpgBody);

      // Fetch the GIF image from the server
      const gifRes = await fetch(json.gifUrl);
      assertEquals(gifRes.status, 200);
      assertEquals(gifRes.headers.get("content-type"), "image/gif");
      const gifBody = await gifRes.arrayBuffer();
      assertValidGif(gifBody);
    } finally {
      stopServer();
      await cleanupFiles(filesToClean, "snapshots");
    }
  },
});

Deno.test({
  name: "Integration: YouTube snapshot creates JPG and GIF",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServer();
    const filesToClean: string[] = [];

    try {
      // Hit the real /youtube-snapshot endpoint with a live YouTube stream
      const res = await fetch(
        `${base}/youtube-snapshot?url=https://www.youtube.com/watch?v=ydYDqZQpim8`,
      );
      assertEquals(res.status, 200);

      const json = await res.json();
      assertExists(json.jpgUrl, "Response should contain jpgUrl");
      assertExists(json.gifUrl, "Response should contain gifUrl");

      // Extract filenames for cleanup
      filesToClean.push(extractFilename(json.jpgUrl));
      filesToClean.push(extractFilename(json.gifUrl));

      // Fetch the JPG image from the server
      const jpgRes = await fetch(json.jpgUrl);
      assertEquals(jpgRes.status, 200);
      assertEquals(jpgRes.headers.get("content-type"), "image/jpeg");
      const jpgBody = await jpgRes.arrayBuffer();
      assertValidJpg(jpgBody);

      // Fetch the GIF image from the server
      const gifRes = await fetch(json.gifUrl);
      assertEquals(gifRes.status, 200);
      assertEquals(gifRes.headers.get("content-type"), "image/gif");
      const gifBody = await gifRes.arrayBuffer();
      assertValidGif(gifBody);
    } finally {
      stopServer();
      await cleanupFiles(filesToClean, "youtube-snapshots");
    }
  },
});
