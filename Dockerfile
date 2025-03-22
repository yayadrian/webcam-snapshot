FROM denoland/deno:latest

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && apt-get clean

# Create app directory
WORKDIR /app

# Copy dependency files
COPY deno.json .
COPY webcam-snapshot.ts .

# Create src directory and copy import_map.json there
RUN mkdir -p src
COPY import_map.json src/

# Cache the dependencies
RUN deno cache --import-map=src/import_map.json webcam-snapshot.ts

# Create snapshots directory
RUN mkdir snapshots

# Start the application
CMD ["deno", "task", "start"] 