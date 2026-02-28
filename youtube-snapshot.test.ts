import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { extractYouTubeVideoId } from "./youtube-snapshot.ts";

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
