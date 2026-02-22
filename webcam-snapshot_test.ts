/// <reference lib="deno.ns" />

import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import {
    cleanupOldSnapshots,
    handleWebcamRequest,
} from "./webcam-snapshot.ts";

// ---------------------------------------------------------------------------
// handleWebcamRequest – routing and input validation (no ffmpeg required)
// ---------------------------------------------------------------------------

Deno.test("handleWebcamRequest: default route returns 200 with help text", async () => {
    const req = new Request("http://localhost:3000/");
    const res = await handleWebcamRequest(req);
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, "Webcam Snapshot Service");
});

Deno.test("handleWebcamRequest: default route has text/plain Content-Type", async () => {
    const req = new Request("http://localhost:3000/");
    const res = await handleWebcamRequest(req);
    assertEquals(res.headers.get("Content-Type"), "text/plain");
});

Deno.test("handleWebcamRequest: /snapshot without url returns 400", async () => {
    const req = new Request("http://localhost:3000/snapshot");
    const res = await handleWebcamRequest(req);
    assertEquals(res.status, 400);
});

Deno.test("handleWebcamRequest: /redirect without url returns 400", async () => {
    const req = new Request("http://localhost:3000/redirect");
    const res = await handleWebcamRequest(req);
    assertEquals(res.status, 400);
});

Deno.test("handleWebcamRequest: /redirect with invalid format returns 400", async () => {
    const req = new Request(
        "http://localhost:3000/redirect?url=https://example.com/stream.m3u8&format=mp4",
    );
    const res = await handleWebcamRequest(req);
    assertEquals(res.status, 400);
});

Deno.test("handleWebcamRequest: /redirect accepts jpg format (fails at ffmpeg, not validation)", async () => {
    // Validation passes – the 500 comes from ffmpeg failing on an invalid stream URL.
    // This confirms format='jpg' is accepted as valid input.
    const req = new Request(
        "http://localhost:3000/redirect?url=https://invalid-stream.example.com/nonexistent.m3u8&format=jpg",
    );
    const res = await handleWebcamRequest(req);
    // Should NOT be 400 (bad request) – validation passed
    const status = res.status;
    assertEquals(status !== 400, true, `Expected non-400 status, got ${status}`);
});

Deno.test("handleWebcamRequest: /redirect accepts gif format (fails at ffmpeg, not validation)", async () => {
    const req = new Request(
        "http://localhost:3000/redirect?url=https://invalid-stream.example.com/nonexistent.m3u8&format=gif",
    );
    const res = await handleWebcamRequest(req);
    assertEquals(res.status !== 400, true);
});

Deno.test("handleWebcamRequest: /images/ for missing file returns 404", async () => {
    const req = new Request(
        "http://localhost:3000/images/definitely-does-not-exist-snapshot.jpg",
    );
    const res = await handleWebcamRequest(req);
    assertEquals(res.status, 404);
});

Deno.test("handleWebcamRequest: /images/ .gif file gets image/gif Content-Type", async () => {
    // Write a tiny placeholder gif so we can test content-type resolution
    const dir = "snapshots";
    const filename = "snapshot-test-contenttype.gif";
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeFile(`${dir}/${filename}`, new Uint8Array([0x47, 0x49, 0x46]));

    const req = new Request(`http://localhost:3000/images/${filename}`);
    const res = await handleWebcamRequest(req);

    await Deno.remove(`${dir}/${filename}`);

    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "image/gif");
});

Deno.test("handleWebcamRequest: /images/ .jpg file gets image/jpeg Content-Type", async () => {
    const dir = "snapshots";
    const filename = "snapshot-test-contenttype.jpg";
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeFile(`${dir}/${filename}`, new Uint8Array([0xff, 0xd8, 0xff]));

    const req = new Request(`http://localhost:3000/images/${filename}`);
    const res = await handleWebcamRequest(req);

    await Deno.remove(`${dir}/${filename}`);

    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "image/jpeg");
});

// ---------------------------------------------------------------------------
// cleanupOldSnapshots – file-system behaviour (uses real snapshots dir)
// ---------------------------------------------------------------------------

Deno.test(
    "cleanupOldSnapshots: removes files beyond the 100-file limit",
    { permissions: { read: true, write: true } },
    async () => {
        const dir = "snapshots";
        await Deno.mkdir(dir, { recursive: true });

        // Create 105 dummy snapshot files
        for (let i = 0; i < 105; i++) {
            const name = `snapshot-test-cleanup-${String(i).padStart(4, "0")}.jpg`;
            await Deno.writeFile(`${dir}/${name}`, new Uint8Array([0xff, 0xd8]));
        }

        await cleanupOldSnapshots();

        let remaining = 0;
        for await (const entry of Deno.readDir(dir)) {
            if (entry.name.startsWith("snapshot-test-cleanup-")) remaining++;
        }

        // Clean up survivors
        for await (const entry of Deno.readDir(dir)) {
            if (entry.name.startsWith("snapshot-test-cleanup-")) {
                await Deno.remove(`${dir}/${entry.name}`);
            }
        }

        assertEquals(remaining, 100);
    },
);

Deno.test(
    "cleanupOldSnapshots: does not remove files when under the 100-file limit",
    { permissions: { read: true, write: true } },
    async () => {
        const dir = "snapshots";
        await Deno.mkdir(dir, { recursive: true });

        for (let i = 0; i < 10; i++) {
            const name = `snapshot-test-keep-${String(i).padStart(4, "0")}.jpg`;
            await Deno.writeFile(`${dir}/${name}`, new Uint8Array([0xff, 0xd8]));
        }

        await cleanupOldSnapshots();

        let remaining = 0;
        for await (const entry of Deno.readDir(dir)) {
            if (entry.name.startsWith("snapshot-test-keep-")) remaining++;
        }

        for await (const entry of Deno.readDir(dir)) {
            if (entry.name.startsWith("snapshot-test-keep-")) {
                await Deno.remove(`${dir}/${entry.name}`);
            }
        }

        assertEquals(remaining, 10);
    },
);
