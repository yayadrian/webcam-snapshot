FROM denoland/deno:latest

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && apt-get clean

# Create app directory
WORKDIR /app

# Set environment variable to indicate we're in Docker
ENV IS_DOCKER=true

# Copy dependency files
COPY deno.json .
COPY webcam-snapshot.ts .
COPY youtube-snapshot.ts .
COPY import_map.json .

# Cache the dependencies
RUN deno cache --import-map=import_map.json webcam-snapshot.ts

# Create snapshots directory
RUN mkdir snapshots

# Start the application
CMD ["deno", "task", "start"] 