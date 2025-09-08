# webcam-snapshot

A tiny Deno HTTP service that takes snapshots (JPG + 1s GIF) from webcam/HLS streams and YouTube URLs, saves them to disk, and serves them over HTTP.

## Features

- HLS/webcam snapshots: JPG + 1s GIF
- YouTube snapshots: fast thumbnail path with yt-dlp + ffmpeg fallback
- Static file serving for generated images
- Redirect endpoints for direct image links
- Hourly cleanup (keeps latest 100 files)

## Prerequisites (local dev)

- Deno
- ffmpeg (required)
- yt-dlp (recommended for YouTube fallback)

macOS (Homebrew):

```bash
brew install deno ffmpeg yt-dlp
```

## Run locally (development)

This repo defines Deno tasks for development and Docker.

Environment variables:

- PORT (default: 3000)
- PUBLIC_URL (default: `http://localhost:<PORT>`)

Start the server:

```bash
deno task start
```

The server will listen on PORT and create these folders if they don’t exist:

- `snapshots/` for webcam images
- `youtube-snapshots/` for YouTube images

### Endpoints

- Webcam
	- GET `/snapshot?url=<HLS_or_media_URL>` → JSON `{ jpgUrl, gifUrl }`
	- GET `/redirect?url=<URL>&format=jpg|gif` → 302 to latest image
	- Static: GET `/images/<filename>`

- YouTube
	- GET `/youtube-snapshot?url=<youtube_url>` → JSON `{ jpgUrl, gifUrl }`
	- GET `/youtube-snapshot/redirect?url=<url>&format=jpg|gif` → 302
	- Static: GET `/youtube-snapshot/images/<filename>`

Example (webcam/HLS):

```text
http://localhost:3000/snapshot?url=https://camsecure.co/HLS/swanagecamlifeboat.m3u8
```

## Run with Docker

This project includes a Dockerfile that installs ffmpeg and yt-dlp.

Build and run using Deno tasks:

```bash
deno task docker-all
```

Or use Docker directly:

```bash
docker build -t webcam-snapshot .
docker run \
	-p 3000:3000 \
	-e PORT=3000 \
	-e PUBLIC_URL=http://localhost:3000 \
	webcam-snapshot
```

Optional: persist snapshots to your host machine:

```bash
docker run \
	-p 3000:3000 \
	-e PORT=3000 \
	-e PUBLIC_URL=http://localhost:3000 \
	-v "$(pwd)/snapshots:/app/snapshots" \
	-v "$(pwd)/youtube-snapshots:/app/youtube-snapshots" \
	webcam-snapshot
```

Notes:

- When running behind a proxy or non-localhost, set `PUBLIC_URL` so returned URLs are externally valid.
- `Dockerfile.youtube` is experimental/legacy; use the main `Dockerfile` for the server.

## Code Quality

This codebase follows modern TypeScript best practices:

- **Comprehensive JSDoc documentation** for all functions
- **Type-safe interfaces** for all data structures  
- **Modular architecture** with separated concerns
- **Constants extracted** for all configuration values
- **Consistent error handling** with standardized responses
- **Input validation** with type guards
- **Proper cleanup** of temporary files and old snapshots
- **Efficient execution** with parallel processing where appropriate

## License

MIT
