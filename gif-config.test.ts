import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { GIF_CONFIG, gifFilterComplex, gifScaleFilter } from "./gif-config.ts";

Deno.test("GIF_CONFIG has expected values", () => {
  assertEquals(GIF_CONFIG.duration, 3);
  assertEquals(GIF_CONFIG.fps, 10);
  assertEquals(GIF_CONFIG.width, 480);
  assertEquals(GIF_CONFIG.scaleFlags, "lanczos");
});

Deno.test("gifFilterComplex returns correct ffmpeg filter string", () => {
  const result = gifFilterComplex();
  assertEquals(
    result,
    "[0:v] fps=10,scale=480:-1:flags=lanczos,split [a][b];[a] palettegen=stats_mode=diff [p];[b][p] paletteuse=dither=bayer:bayer_scale=5",
  );
});

Deno.test("gifScaleFilter returns correct scale filter", () => {
  const result = gifScaleFilter();
  assertEquals(result, "scale=480:-1:flags=lanczos");
});
