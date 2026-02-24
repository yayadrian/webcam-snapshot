FROM denoland/deno:latest

# Install ffmpeg and yt-dlp
RUN apt-get update && \
    apt-get install -y ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
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