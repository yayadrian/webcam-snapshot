/// <reference lib="dom" />

import { join } from "std/path/mod.ts";
import { handleYouTubeSnapshot } from "./youtube-snapshot.ts";

interface Console {
    log(...data: unknown[]): void;
    error(...data: unknown[]): void;
}

// Configure environment variables
const PORT = parseInt(Deno.env.get("PORT") || "3000");
const PUBLIC_URL = Deno.env.get("PUBLIC_URL") || `http://localhost:${PORT}`;
const SNAPSHOTS_DIR = "snapshots";

// Ensure snapshots directory exists
try {
    await Deno.mkdir(SNAPSHOTS_DIR, { recursive: true });
} catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw error;
    }
}

// Function to take snapshot from video stream
async function takeSnapshot(videoSrc: string): Promise<{jpgFilename: string, gifFilename: string}> {
    console.log('Loading video stream...', videoSrc);
    try {
        const response = await fetch(videoSrc);
        if (!response.ok) {
            throw new Error(`Failed to fetch stream: ${response.status} ${response.statusText}`);
        }
        let playlist = await response.text();
        console.log('Received playlist:', playlist);
        
        // Handle master playlist
        if (playlist.includes('#EXT-X-STREAM-INF')) {
            const lines = playlist.split('\n');
            let streamUrl: string | undefined;
            
            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine && !trimmedLine.startsWith('#')) {
                    streamUrl = trimmedLine;
                    break;
                }
            }
            
            if (!streamUrl) {
                throw new Error('No stream URL found in master playlist');
            }
            
            // Get the base URL from the original URL
            const baseUrl = new URL(videoSrc).href.split('/').slice(0, -1).join('/');
            videoSrc = streamUrl.startsWith('http') ? streamUrl : `${baseUrl}/${streamUrl}`;
            console.log('Following stream URL:', videoSrc);
            
            // Fetch the media playlist
            const mediaResponse = await fetch(videoSrc);
            if (!mediaResponse.ok) {
                throw new Error(`Failed to fetch media playlist: ${mediaResponse.status} ${mediaResponse.statusText}`);
            }
            playlist = await mediaResponse.text();
            console.log('Received media playlist:', playlist);
        }
        
        // Parse media playlist
        const lines = playlist.split('\n');
        let initSegment: string | undefined;
        let videoSegment: string | undefined;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('#EXT-X-MAP:URI="')) {
                initSegment = trimmedLine.split('URI="')[1].split('"')[0];
            } else if (trimmedLine && !trimmedLine.startsWith('#')) {
                videoSegment = trimmedLine;
                break;
            }
        }
        
        if (!videoSegment) {
            throw new Error('No video segments found in playlist');
        }

        // Get the base URL from the playlist URL
        const baseUrl = new URL(videoSrc).href.split('/').slice(0, -1).join('/');
        const videoUrl = videoSegment.startsWith('http') ? videoSegment : `${baseUrl}/${videoSegment}`;
        console.log('Processing video segment:', videoUrl);
        
        // Create timestamp for filenames
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const tempVideoFilename = join(SNAPSHOTS_DIR, `temp_segment-${timestamp}.mp4`);
        const jpgFilename = `snapshot-${timestamp}.jpg`;
        const gifFilename = `snapshot-${timestamp}.gif`;

        // Download and combine initialization segment with media segment
        const videoResponse = await fetch(videoUrl);
        const videoBuffer = await videoResponse.arrayBuffer();
        
        let finalBuffer: Uint8Array;
        if (initSegment) {
            const initUrl = initSegment.startsWith('http') ? initSegment : `${baseUrl}/${initSegment}`;
            const initResponse = await fetch(initUrl);
            const initBuffer = await initResponse.arrayBuffer();
            
            // Combine init segment with media segment
            finalBuffer = new Uint8Array(initBuffer.byteLength + videoBuffer.byteLength);
            finalBuffer.set(new Uint8Array(initBuffer), 0);
            finalBuffer.set(new Uint8Array(videoBuffer), initBuffer.byteLength);
        } else {
            finalBuffer = new Uint8Array(videoBuffer);
        }
        
        // Save the combined video temporarily
        await Deno.writeFile(tempVideoFilename, finalBuffer);
        
        // Extract first frame as JPG using FFmpeg
        const ffmpegJpgSnapshot = new Deno.Command('ffmpeg', {
            args: [
                '-i', tempVideoFilename,
                '-vframes', '1',
                '-f', 'image2',
                '-y',
                join(SNAPSHOTS_DIR, jpgFilename)
            ],
            stderr: "piped"
        });

        // Create a 1-second GIF using FFmpeg
        const ffmpegGifSnapshot = new Deno.Command('ffmpeg', {
            args: [
                '-i', tempVideoFilename,
                '-t', '1',
                '-vf', 'fps=10,scale=320:-1:flags=lanczos',
                '-y',
                join(SNAPSHOTS_DIR, gifFilename)
            ],
            stderr: "piped"
        });

        const [jpgResult, gifResult] = await Promise.all([
            ffmpegJpgSnapshot.output(),
            ffmpegGifSnapshot.output()
        ]);
        
        if (!jpgResult.success || !gifResult.success) {
            // Log FFmpeg errors for debugging
            const jpgError = new TextDecoder().decode(jpgResult.stderr);
            const gifError = new TextDecoder().decode(gifResult.stderr);
            console.error('FFmpeg JPG Error:', jpgError);
            console.error('FFmpeg GIF Error:', gifError);
            throw new Error('Failed to create snapshots');
        }

        // Clean up temporary file
        await Deno.remove(tempVideoFilename);
        
        return { jpgFilename, gifFilename };
    } catch (error: unknown) {
        if (error instanceof Error) {
            throw new Error(`Failed to process video: ${error.message}`);
        }
        throw new Error('Failed to process video: Unknown error');
    }
}

// Clean up old snapshots (keep last 100)
async function cleanupOldSnapshots() {
    try {
        const files = [];
        for await (const entry of Deno.readDir(SNAPSHOTS_DIR)) {
            if (entry.isFile && entry.name.startsWith('snapshot-')) {
                files.push(entry.name);
            }
        }
        
        // Sort files by creation time (newest first)
        files.sort().reverse();
        
        // Remove all but the latest 100 files
        for (const file of files.slice(100)) {
            await Deno.remove(join(SNAPSHOTS_DIR, file));
        }
    } catch (error: unknown) {
        console.error('Error cleaning up snapshots:', error);
    }
}

// Start the HTTP server
Deno.serve({ port: PORT }, async (request: Request) => {
    const url = new URL(request.url);
    
    // Handle YouTube snapshot requests
    if (url.pathname.startsWith('/youtube-snapshot')) {
        return handleYouTubeSnapshot(request);
    }
    
    // Add new redirect endpoint
    if (url.pathname === '/redirect') {
        const videoSrc = url.searchParams.get('url');
        const format = url.searchParams.get('format')?.toLowerCase() || 'jpg';
        
        if (!videoSrc) {
            return new Response('Missing url parameter', { status: 400 });
        }
        
        if (format !== 'jpg' && format !== 'gif') {
            return new Response('Format must be either jpg or gif', { status: 400 });
        }
        
        try {
            const { jpgFilename, gifFilename } = await takeSnapshot(videoSrc);
            const redirectUrl = `/images/${format === 'jpg' ? jpgFilename : gifFilename}`;
            
            return new Response(null, {
                status: 302,
                headers: { 'Location': redirectUrl }
            });
        } catch (error: unknown) {
            if (error instanceof Error) {
                return new Response(JSON.stringify({ error: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return new Response(JSON.stringify({ error: 'Unknown error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
    
    // Handle snapshot requests
    if (url.pathname === '/snapshot') {
        const videoSrc = url.searchParams.get('url');
        
        if (!videoSrc) {
            return new Response('Missing url parameter', { status: 400 });
        }
        
        try {
            const { jpgFilename, gifFilename } = await takeSnapshot(videoSrc);
            const jpgUrl = `${PUBLIC_URL}/images/${jpgFilename}`;
            const gifUrl = `${PUBLIC_URL}/images/${gifFilename}`;
            return new Response(JSON.stringify({ 
                jpgUrl,
                gifUrl
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error: unknown) {
            if (error instanceof Error) {
                return new Response(JSON.stringify({ error: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return new Response(JSON.stringify({ error: 'Unknown error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
    
    // Serve static images
    if (url.pathname.startsWith('/images/')) {
        const filename = url.pathname.replace('/images/', '');
        try {
            const file = await Deno.readFile(join(SNAPSHOTS_DIR, filename));
            const contentType = filename.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
            return new Response(file, {
                headers: { 'Content-Type': contentType }
            });
        } catch (error) {
            return new Response('Image not found', { status: 404 });
        }
    }
    
    // Default route
    return new Response(
        'Webcam Snapshot Service\n\n' +
        'Available endpoints:\n\n' +
        '1. Webcam Snapshots:\n' +
        '   /snapshot?url=YOUR_WEBCAM_URL\n' +
        '   /redirect?url=YOUR_WEBCAM_URL&format=jpg\n\n' +
        '2. YouTube Snapshots:\n' +
        '   /youtube-snapshot?url=YOUR_YOUTUBE_URL\n' +
        '   /youtube-snapshot/redirect?url=YOUR_YOUTUBE_URL&format=jpg\n', 
        {
            headers: { 'Content-Type': 'text/plain' }
        }
    );
});

// Run cleanup every hour
setInterval(cleanupOldSnapshots, 60 * 60 * 1000);

console.log(`Server running on port ${PORT}`);
