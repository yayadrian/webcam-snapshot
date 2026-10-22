FROM denoland/deno:2.9.8

# TARGETARCH is provided automatically by Docker BuildKit (amd64, arm64, etc.)
ARG TARGETARCH

# Pinned tool versions, verified against published SHA-256 checksums.
# ffmpeg: upstream static build from BtbN/FFmpeg-Builds (month-end builds are retained for two years).
# Debian's packaged ffmpeg lags several major versions behind upstream, so use upstream builds instead.
ARG FFMPEG_RELEASE=autobuild-2026-09-30-13-08
ARG FFMPEG_BUILD=ffmpeg-n9.0.2-17-g2a571b6068
ARG FFMPEG_SHA256_AMD64=68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269
ARG FFMPEG_SHA256_ARM64=91afcd7695d4bbbb9e0057aa10baaf9875ec4e1a97303f9059ec971336a2ab46
ARG YTDLP_VERSION=2026.10.21
ARG YTDLP_SHA256_AMD64=d8bd33fca9d5b23bd5b9952b3fca36db5c46331933fda9f598a3da14ce2c243f
ARG YTDLP_SHA256_ARM64=e137c2171b0b8ef648e6136e86aa70c65923e93e434f01c93901d64744b190aa

# Install ffmpeg and yt-dlp (select the correct binaries for the target architecture)
RUN set -eu && \
    apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils && \
    if [ "$TARGETARCH" = "arm64" ]; then \
      FFMPEG_ARCH=linuxarm64; FFMPEG_SHA256=$FFMPEG_SHA256_ARM64; \
      YTDLP_BINARY=yt-dlp_linux_aarch64; YTDLP_SHA256=$YTDLP_SHA256_ARM64; \
    else \
      FFMPEG_ARCH=linux64; FFMPEG_SHA256=$FFMPEG_SHA256_AMD64; \
      YTDLP_BINARY=yt-dlp_linux; YTDLP_SHA256=$YTDLP_SHA256_AMD64; \
    fi && \
    FFMPEG_DIR="${FFMPEG_BUILD}-${FFMPEG_ARCH}-gpl-9.0" && \
    curl -fSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${FFMPEG_DIR}.tar.xz" -o /tmp/ffmpeg.tar.xz --retry 3 --retry-delay 5 && \
    echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - && \
    tar -xJf /tmp/ffmpeg.tar.xz -C /tmp && \
    install -m 0755 "/tmp/${FFMPEG_DIR}/bin/ffmpeg" "/tmp/${FFMPEG_DIR}/bin/ffprobe" /usr/local/bin/ && \
    curl -fSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YTDLP_BINARY}" -o /usr/local/bin/yt-dlp --retry 3 --retry-delay 5 && \
    echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - && \
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