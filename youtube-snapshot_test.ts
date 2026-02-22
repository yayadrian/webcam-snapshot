/// <reference lib="deno.ns" />

import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import {
    extractYouTubeVideoId,
    cleanupOldSnapshots,
    handleYouTubeSnapshot,
} from "./youtube-snapshot.ts";

// ---------------------------------------------------------------------------
// extractYouTubeVideoId – pure function, no side-effects
// ---------------------------------------------------------------------------

Deno.test("extractYouTubeVideoId: standard watch URL", () => {
    assertEquals(
        extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
        "dQw4w9WgXcQ",
    );
});

Deno.test("extractYouTubeVideoId: watch URL with extra query parameters", () => {
    assertEquals(
        extractYouTubeVideoId(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123",
        ),
        "dQw4w9WgXcQ",
    );
});

Deno.test("extractYouTubeVideoId: short youtu.be URL", () => {
    assertEquals(
        extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ"),
        "dQw4w9WgXcQ",
    );
});

Deno.test("extractYouTubeVideoId: embed URL", () => {
    assertEquals(
        extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"),
        "dQw4w9WgXcQ",
    );
});

Deno.test("extractYouTubeVideoId: live youtu.be URL", () => {
    assertEquals(
        extractYouTubeVideoId("https://youtu.be/live_XYZ123abc"),
        "live_XYZ123abc",
    );
});

Deno.test("extractYouTubeVideoId: non-YouTube URL returns null", () => {
    assertEquals(
        extractYouTubeVideoId("https://vimeo.com/123456789"),
        null,
    );
});

Deno.test("extractYouTubeVideoId: empty string returns null", () => {
    assertEquals(extractYouTubeVideoId(""), null);
});

Deno.test("extractYouTubeVideoId: plain text returns null", () => {
    assertEquals(extractYouTubeVideoId("not-a-url"), null);
});

Deno.test("extractYouTubeVideoId: URL missing video ID returns null", () => {
    assertEquals(
        extractYouTubeVideoId("https://www.youtube.com/watch"),
        null,
    );
});

// ---------------------------------------------------------------------------
// handleYouTubeSnapshot – input validation (no ffmpeg/network required)
// ---------------------------------------------------------------------------

Deno.test("handleYouTubeSnapshot: /youtube-snapshot without url returns 400", async () => {
    const req = new Request("http://localhost:3000/youtube-snapshot");
    const res = await handleYouTubeSnapshot(req);
    assertEquals(res.status, 400);
});

Deno.test("handleYouTubeSnapshot: /youtube-snapshot/redirect without url returns 400", async () => {
    const req = new Request("http://localhost:3000/youtube-snapshot/redirect");
    const res = await handleYouTubeSnapshot(req);
    assertEquals(res.status, 400);
});

Deno.test("handleYouTubeSnapshot: /youtube-snapshot/redirect with invalid format returns 400", async () => {
    const req = new Request(
        "http://localhost:3000/youtube-snapshot/redirect?url=https://youtube.com/watch%3Fv%3Dabc&format=mp4",
    );
    const res = await handleYouTubeSnapshot(req);
    assertEquals(res.status, 400);
});

Deno.test("handleYouTubeSnapshot: /youtube-snapshot with non-YouTube URL returns 500 with error body", async () => {
    // extractYouTubeVideoId returns null → thrown before any network call
    const req = new Request(
        "http://localhost:3000/youtube-snapshot?url=https://not-youtube.com/video",
    );
    const res = await handleYouTubeSnapshot(req);
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "Invalid YouTube URL");
});

Deno.test("handleYouTubeSnapshot: /youtube-snapshot error response has JSON Content-Type", async () => {
    const req = new Request(
        "http://localhost:3000/youtube-snapshot?url=https://not-youtube.com",
    );
    const res = await handleYouTubeSnapshot(req);
    assertEquals(res.headers.get("Content-Type"), "application/json");
});

Deno.test("handleYouTubeSnapshot: /youtube-snapshot/redirect with non-YouTube URL returns 500", async () => {
    const req = new Request(
        "http://localhost:3000/youtube-snapshot/redirect?url=https://not-youtube.com&format=jpg",
    );
    const res = await handleYouTubeSnapshot(req);
    assertEquals(res.status, 500);
});

Deno.test("handleYouTubeSnapshot: /youtube-snapshot/images/ for missing file returns 404", async () => {
    const req = new Request(
        "http://localhost:3000/youtube-snapshot/images/definitely-does-not-exist-12345.jpg",
    );
    const res = await handleYouTubeSnapshot(req);
    assertEquals(res.status, 404);
});

Deno.test("handleYouTubeSnapshot: unknown sub-path returns 404", async () => {
    const req = new Request(
        "http://localhost:3000/youtube-snapshot/unknown-path",
    );
    const res = await handleYouTubeSnapshot(req);
    assertEquals(res.status, 404);
});

Deno.test("handleYouTubeSnapshot: /youtube-snapshot/ returns help text with 200", async () => {
    const req = new Request("http://localhost:3000/youtube-snapshot/");
    const res = await handleYouTubeSnapshot(req);
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, "YouTube Snapshot Service");
});

// ---------------------------------------------------------------------------
// cleanupOldSnapshots – file-system behaviour (uses real youtube-snapshots dir)
// ---------------------------------------------------------------------------

Deno.test(
    "cleanupOldSnapshots: removes files beyond the 100-file limit",
    { permissions: { read: true, write: true } },
    async () => {
        const dir = "youtube-snapshots";
        // Ensure directory exists
        await Deno.mkdir(dir, { recursive: true });

        // Create 105 dummy snapshot files
        const created: string[] = [];
        for (let i = 0; i < 105; i++) {
            const name = `youtube-test-cleanup-${String(i).padStart(4, "0")}.jpg`;
            const path = `${dir}/${name}`;
            await Deno.writeFile(path, new Uint8Array([0xff, 0xd8]));
            created.push(name);
        }

        await cleanupOldSnapshots();

        // Count remaining test files
        let remaining = 0;
        for await (const entry of Deno.readDir(dir)) {
            if (entry.name.startsWith("youtube-test-cleanup-")) remaining++;
        }

        // Clean up what is left
        for await (const entry of Deno.readDir(dir)) {
            if (entry.name.startsWith("youtube-test-cleanup-")) {
                await Deno.remove(`${dir}/${entry.name}`);
            }
        }

        // The cleanup keeps the latest 100; 5 of our 105 files should be gone
        assertEquals(remaining, 100);
    },
);

Deno.test(
    "cleanupOldSnapshots: does not remove files when under the 100-file limit",
    { permissions: { read: true, write: true } },
    async () => {
        const dir = "youtube-snapshots";
        await Deno.mkdir(dir, { recursive: true });

        // Create only 10 files – all should survive
        const created: string[] = [];
        for (let i = 0; i < 10; i++) {
            const name = `youtube-test-keep-${String(i).padStart(4, "0")}.jpg`;
            const path = `${dir}/${name}`;
            await Deno.writeFile(path, new Uint8Array([0xff, 0xd8]));
            created.push(name);
        }

        await cleanupOldSnapshots();

        let remaining = 0;
        for await (const entry of Deno.readDir(dir)) {
            if (entry.name.startsWith("youtube-test-keep-")) remaining++;
        }

        // Clean up
        for await (const entry of Deno.readDir(dir)) {
            if (entry.name.startsWith("youtube-test-keep-")) {
                await Deno.remove(`${dir}/${entry.name}`);
            }
        }

        assertEquals(remaining, 10);
    },
);

Deno.test(
    "cleanupOldSnapshots: only removes files with youtube- prefix",
    { permissions: { read: true, write: true } },
    async () => {
        const dir = "youtube-snapshots";
        await Deno.mkdir(dir, { recursive: true });

        // Create files with a non-matching prefix – should never be touched
        const unrelated = `${dir}/snapshot-should-survive.jpg`;
        await Deno.writeFile(unrelated, new Uint8Array([0xff, 0xd8]));

        // Create 105 youtube- prefixed files to trigger cleanup
        for (let i = 0; i < 105; i++) {
            const name = `youtube-test-prefix-${String(i).padStart(4, "0")}.jpg`;
            await Deno.writeFile(`${dir}/${name}`, new Uint8Array([0xff, 0xd8]));
        }

        await cleanupOldSnapshots();

        // Verify the unrelated file is still present
        let survives = false;
        try {
            await Deno.stat(unrelated);
            survives = true;
        } catch {
            survives = false;
        }

        // Clean up all test files
        for await (const entry of Deno.readDir(dir)) {
            if (
                entry.name.startsWith("youtube-test-prefix-") ||
                entry.name === "snapshot-should-survive.jpg"
            ) {
                await Deno.remove(`${dir}/${entry.name}`);
            }
        }

        assertEquals(survives, true);
    },
);
