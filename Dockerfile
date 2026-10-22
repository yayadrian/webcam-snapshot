FROM denoland/deno:2.9.8

# TARGETARCH is provided automatically by Docker BuildKit (amd64, arm64, etc.)
ARG TARGETARCH

# Tool versions (override with --build-arg to test other releases)
# FFMPEG_BRANCH selects the latest static build of that FFmpeg release branch from BtbN/FFmpeg-Builds.
ARG FFMPEG_BRANCH=9.0
ARG YTDLP_VERSION=2026.10.21

# Install a static ffmpeg build and yt-dlp (select the correct binaries for the target architecture).
# Debian's packaged ffmpeg lags several major versions behind upstream, so use upstream builds instead.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils && \
    FFMPEG_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "linuxarm64" || echo "linux64") && \
    curl -fSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n${FFMPEG_BRANCH}-latest-${FFMPEG_ARCH}-gpl-${FFMPEG_BRANCH}.tar.xz" -o /tmp/ffmpeg.tar.xz --retry 3 --retry-delay 5 && \
    tar -xJf /tmp/ffmpeg.tar.xz -C /tmp && \
    install -m 0755 /tmp/ffmpeg-n${FFMPEG_BRANCH}-latest-${FFMPEG_ARCH}-gpl-${FFMPEG_BRANCH}/bin/ffmpeg /usr/local/bin/ffmpeg && \
    install -m 0755 /tmp/ffmpeg-n${FFMPEG_BRANCH}-latest-${FFMPEG_ARCH}-gpl-${FFMPEG_BRANCH}/bin/ffprobe /usr/local/bin/ffprobe && \
    YTDLP_BINARY=$([ "$TARGETARCH" = "arm64" ] && echo "yt-dlp_linux_aarch64" || echo "yt-dlp_linux") && \
    curl -fSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YTDLP_BINARY}" -o /usr/local/bin/yt-dlp --retry 3 --retry-delay 5 && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    rm -rf /tmp/ffmpeg* && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    ffmpeg -version | head -n 1 && yt-dlp --version

# Create app directory
WORKDIR /app

# Set environment variable to indicate we're in Docker
ENV IS_DOCKER=true

# Copy dependency files
COPY deno.json .
COPY webcam-snapshot.ts .
COPY youtube-snapshot.ts .
COPY gif-config.ts .
COPY import_map.json .
COPY deno.lock .

# Cache the dependencies
RUN deno install --entrypoint webcam-snapshot.ts

# Create snapshots directory
RUN mkdir snapshots
RUN mkdir youtube-snapshots

# Optional: mount a cookies file at /app/cookies.txt for YouTube authentication
# Use: docker run -v /path/to/cookies.txt:/app/cookies.txt -e YT_COOKIES_FILE=/app/cookies.txt ...
ENV YT_COOKIES_FILE=""

# Start the application
CMD ["deno", "task", "start"] 