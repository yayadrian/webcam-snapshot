# AI agent instructions for this repo

This project is a small Deno service that takes snapshots (JPG + 1s GIF) from webcam/HLS streams and YouTube URLs, stores them locally, and serves them over HTTP.

## Big picture
- Entrypoint: `webcam-snapshot.ts` starts an HTTP server with Deno.serve and routes.
- YouTube support is implemented in `youtube-snapshot.ts` and imported into the main server via `handleYouTubeSnapshot`.
- Snapshots are saved to disk with timestamped filenames and then served from static endpoints.
- External binaries are required at runtime: `ffmpeg` (always) and `yt-dlp` (YouTube fallback).

## Key files and directories
- `webcam-snapshot.ts`: server, routes, webcam snapshot flow, static file serving, hourly cleanup (keeps latest 100).
- `youtube-snapshot.ts`: YouTube flow; first tries YouTube thumbnails (live.jpg/maxres/hqdefault), falls back to `yt-dlp` + `ffmpeg` on short segment.
- `deno.json`: tasks and import map config. Use `deno task start` during dev.
- `import_map.json`: pins `std/` to a specific version; import as `"std/..."` (e.g., `std/path/mod.ts`).
- `Dockerfile`: builds a runnable image with ffmpeg + yt-dlp installed; preferred container workflow.
- `Dockerfile.youtube`: experimental/legacy; not a standalone server (no Deno.serve in that file’s main). Prefer the main `Dockerfile`.

## How it works (routes)
- Webcam:
  - `GET /snapshot?url=<HLS_or_media_URL>` → JSON: `{ jpgUrl, gifUrl }`
  - `GET /redirect?url=<URL>&format=jpg|gif` → 302 to latest image
  - Static files: `GET /images/<filename>`
- YouTube:
  - `GET /youtube-snapshot?url=<youtube_url>` → JSON: `{ jpgUrl, gifUrl }`
  - `GET /youtube-snapshot/redirect?url=<url>&format=jpg|gif` → 302
  - Static files: `GET /youtube-snapshot/images/<filename>`

## Runtime and env
- Permissions: when running locally, the server needs `--allow-net --allow-write --allow-read --allow-run --allow-env` (provided via `deno task start`).
- Env vars:
  - `PORT` (default 3000)
  - `PUBLIC_URL` (default `http://localhost:<PORT>`), used when returning absolute URLs in JSON.
- Output locations:
  - Webcam: `snapshots/` files named `snapshot-<ISO-timestamp>.{jpg,gif}`
  - YouTube: `youtube-<videoId>-<ISO-timestamp>.{jpg,gif}` in `youtube-snapshots/`

## Developer workflows
- Local dev: `deno task start` (from `deno.json`). Ensure `ffmpeg` (and for YouTube, `yt-dlp`) are installed on your machine.
- Docker: `deno task docker-all` builds and runs with required binaries preinstalled. Adjust `PORT` and `PUBLIC_URL` as needed.
- Adding endpoints: follow the existing pattern in `webcam-snapshot.ts` (parse URL params, validate inputs, try/catch with JSON error payloads, return 4xx/5xx on failures).

## Implementation patterns to follow
- Use `Deno.Command('ffmpeg' | 'yt-dlp', { args, stderr: 'piped', stdout?: 'piped' })` and check `.success`; log decoded stderr on failure for diagnostics.
- Build file paths with `std/path/join` using absolute base directories; serve with correct content-type.
- Keep snapshot directories flat; prefer timestamp-based filenames (replace `:` and `.` in ISO with `-`).
- Clean up old files to cap storage (see `cleanupOldSnapshots` for reference).
- Respect the import map: import standard lib as `std/...` and keep versions pinned via `import_map.json`.

## Gotchas and tips
- Some HLS streams may require longer timeouts or different ffmpeg flags; mirror the existing call signatures when extending.
- YouTube live streams: thumbnail route is most reliable/fast; only fall back to `yt-dlp` segment if thumbnails fail.
- If running behind a proxy, set `PUBLIC_URL` so returned `jpgUrl/gifUrl` are externally valid.
- `Dockerfile.youtube` does not start a server by itself; use the main `Dockerfile` unless you intend to refactor.


