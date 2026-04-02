FROM denoland/deno:latest

# TARGETARCH is provided automatically by Docker BuildKit (amd64, arm64, etc.)
ARG TARGETARCH

# Install ffmpeg and yt-dlp (select the correct binary for the target architecture)
RUN apt-get update && \
    apt-get install -y ffmpeg curl && \
    YTDLP_BINARY=$([ "$TARGETARCH" = "arm64" ] && echo "yt-dlp_linux_aarch64" || echo "yt-dlp_linux") && \
    curl -fSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_BINARY} -o /usr/local/bin/yt-dlp --retry 3 --retry-delay 5 && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean

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

# Cache the dependencies
RUN deno cache --import-map=import_map.json webcam-snapshot.ts

# Create snapshots directory
RUN mkdir snapshots
RUN mkdir youtube-snapshots

# Start the application
CMD ["deno", "task", "start"] 