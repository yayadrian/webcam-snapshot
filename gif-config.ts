// Shared GIF generation configuration

export const GIF_CONFIG = {
  /** Duration of GIF capture in seconds */
  duration: 3,
  /** Frames per second */
  fps: 10,
  /** Output width in pixels (height auto-scales to maintain aspect ratio) */
  width: 480,
  /** Scaling algorithm */
  scaleFlags: "lanczos",
};

/**
 * FFmpeg filter_complex string for high-quality animated GIF generation.
 * Uses a split filter to generate an optimized 256-color palette and apply
 * it with dithering in a single pass (no double network reads).
 */
export function gifFilterComplex(): string {
  const { fps, width, scaleFlags } = GIF_CONFIG;
  return [
    `[0:v] fps=${fps},scale=${width}:-1:flags=${scaleFlags},split [a][b]`,
    `[a] palettegen=stats_mode=diff [p]`,
    `[b][p] paletteuse=dither=bayer:bayer_scale=5`,
  ].join(";");
}

/**
 * Simple scale-only filter for static GIF conversion (single frame, e.g. YouTube thumbnails).
 */
export function gifScaleFilter(): string {
  const { width, scaleFlags } = GIF_CONFIG;
  return `scale=${width}:-1:flags=${scaleFlags}`;
}
