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
// Get current working directory
const CURRENT_DIR = Deno.cwd();
// Create absolute path for snapshots
const SNAPSHOTS_PATH = join(CURRENT_DIR, SNAPSHOTS_DIR);

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
    
    // Create timestamp for filenames
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jpgFilename = `snapshot-${timestamp}.jpg`;
    const gifFilename = `snapshot-${timestamp}.gif`;
    
    // Create absolute paths for output files
    const jpgPath = join(SNAPSHOTS_PATH, jpgFilename);
    const gifPath = join(SNAPSHOTS_PATH, gifFilename);
    
    try {
        // Try direct HLS stream capture for JPG
        console.log('Capturing JPG directly from stream');
        const jpgFfmpeg = new Deno.Command('ffmpeg', {
            args: [
                '-loglevel', 'warning',
                '-timeout', '30000000',  // 30 second timeout for connection
                '-i', videoSrc,          // Use HLS URL directly
                '-vframes', '1',         // Get just one frame
                '-f', 'image2',
                '-y',
                jpgPath
            ],
            stderr: "piped"
        });
        
        const jpgResult = await jpgFfmpeg.output();
        if (!jpgResult.success) {
            const jpgError = new TextDecoder().decode(jpgResult.stderr);
            console.error('FFmpeg JPG Error:', jpgError);
            throw new Error('Failed to capture JPG snapshot');
        }
        
        // Try direct HLS stream capture for GIF
        console.log('Capturing GIF directly from stream');
        const gifFfmpeg = new Deno.Command('ffmpeg', {
            args: [
                '-loglevel', 'warning',
                '-timeout', '30000000',   // 30 second timeout
                '-i', videoSrc,           // Use HLS URL directly
                '-t', '1',                // Get 1 second of video
                '-vf', 'fps=10,scale=320:-1:flags=lanczos',
                '-y',
                gifPath
            ],
            stderr: "piped"
        });
        
        const gifResult = await gifFfmpeg.output();
        if (!gifResult.success) {
            const gifError = new TextDecoder().decode(gifResult.stderr);
            console.error('FFmpeg GIF Error:', gifError);
            throw new Error('Failed to capture GIF snapshot');
        }
        
        return { jpgFilename, gifFilename };
    } catch (error: unknown) {
        if (error instanceof Error) {
            throw new Error(`Failed to process video: ${error.message}`);
        }
        throw new Error('Failed to process video: Unknown error');
    }
}

// Function to extract frames directly from the input file
async function extractFramesDirectly(videoPath: string, jpgPath: string, gifPath: string): Promise<void> {
    // Extract JPG directly
    const jpgExtract = new Deno.Command('ffmpeg', {
        args: [
            '-f', 'mpegts',
            '-i', videoPath,
            '-vframes', '1',
            '-f', 'image2',
            '-y',
            jpgPath
        ],
        stderr: "piped"
    });
    
    const jpgResult = await jpgExtract.output();
    if (!jpgResult.success) {
        const jpgError = new TextDecoder().decode(jpgResult.stderr);
        console.error('Direct JPG extraction error:', jpgError);
        throw new Error('Failed to extract JPG');
    }
    
    // Extract GIF directly
    const gifExtract = new Deno.Command('ffmpeg', {
        args: [
            '-f', 'mpegts',
            '-i', videoPath,
            '-t', '1',
            '-vf', 'fps=10,scale=320:-1:flags=lanczos',
            '-y',
            gifPath
        ],
        stderr: "piped"
    });
    
    const gifResult = await gifExtract.output();
    if (!gifResult.success) {
        const gifError = new TextDecoder().decode(gifResult.stderr);
        console.error('Direct GIF extraction error:', gifError);
        throw new Error('Failed to extract GIF');
    }
}

// Clean up old snapshots (keep last 100)
async function cleanupOldSnapshots() {
    try {
        const files = [];
        for await (const entry of Deno.readDir(SNAPSHOTS_PATH)) {
            if (entry.isFile && entry.name.startsWith('snapshot-')) {
                files.push(entry.name);
            }
        }
        
        // Sort files by creation time (newest first)
        files.sort().reverse();
        
        // Remove all but the latest 100 files
        for (const file of files.slice(100)) {
            await Deno.remove(join(SNAPSHOTS_PATH, file));
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
            const file = await Deno.readFile(join(SNAPSHOTS_PATH, filename));
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
        '   /snapshot?url=https://camsecure.co/HLS/swanagecamlifeboat.m3u8\n\n' +
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
