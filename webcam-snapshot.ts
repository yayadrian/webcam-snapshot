/// <reference lib="dom" />

import { join } from "std/path/mod.ts";
import { handleYouTubeSnapshot } from "./youtube-snapshot.ts";
import { GIF_CONFIG, gifFilterComplex } from "./gif-config.ts";

interface Console {
    log(...data: unknown[]): void;
    error(...data: unknown[]): void;
}

// Configure environment variables
const PORT = parseInt(Deno.env.get("PORT") || "3000");
const PUBLIC_URL = Deno.env.get("PUBLIC_URL") || `http://localhost:${PORT}`;

// CORS: Allow any yayproject.com domain (including subdomains)
function getAllowedOrigin(request: Request): string | null {
    const origin = request.headers.get("Origin");
    if (!origin) return null;
    try {
        const url = new URL(origin);
        if (url.hostname === "yayproject.com" || url.hostname.endsWith(".yayproject.com")) {
            return origin;
        }
    } catch {
        // Invalid origin URL
    }
    return null;
}

function corsHeaders(request: Request): Record<string, string> {
    const allowedOrigin = getAllowedOrigin(request);
    if (!allowedOrigin) return {};
    return {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin",
    };
}

function addCorsHeaders(response: Response, request: Request): Response {
    const headers = corsHeaders(request);
    if (Object.keys(headers).length === 0) return response;
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) {
        newHeaders.set(key, value);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
    });
}

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
    
    // Temp file for capturing video segment from HLS stream
    const tempVideoPath = join(SNAPSHOTS_PATH, `temp-${timestamp}.ts`);

    try {
        // Step 1: Capture video segment from HLS stream to a temp file
        console.log(`Downloading ${GIF_CONFIG.duration}s video segment from stream...`);
        const captureFfmpeg = new Deno.Command('ffmpeg', {
            args: [
                '-loglevel', 'info',
                '-timeout', '30000000',  // 30 second timeout for connection
                '-i', videoSrc,          // Use HLS URL directly
                '-t', String(GIF_CONFIG.duration),
                '-c', 'copy',            // Copy codec, no re-encoding
                '-y',
                tempVideoPath
            ],
            stderr: "piped"
        });

        const captureResult = await captureFfmpeg.output();
        const captureStderr = new TextDecoder().decode(captureResult.stderr);
        if (!captureResult.success) {
            console.error('FFmpeg capture error:', captureStderr);
            throw new Error('Failed to capture video segment from stream');
        }
        console.log('Video segment captured successfully');

        // Step 2: Extract JPG from the temp file
        console.log('Extracting JPG from captured segment...');
        const jpgFfmpeg = new Deno.Command('ffmpeg', {
            args: [
                '-loglevel', 'info',
                '-i', tempVideoPath,
                '-vframes', '1',
                '-f', 'image2',
                '-y',
                jpgPath
            ],
            stderr: "piped"
        });

        // Step 3: Generate palette-optimized GIF from the temp file
        console.log('Generating palette-optimized GIF...');
        const gifFfmpeg = new Deno.Command('ffmpeg', {
            args: [
                '-loglevel', 'info',
                '-i', tempVideoPath,
                '-filter_complex', gifFilterComplex(),
                '-y',
                gifPath
            ],
            stderr: "piped"
        });

        // Run JPG and GIF extraction in parallel (both read from local file)
        const [jpgResult, gifResult] = await Promise.all([
            jpgFfmpeg.output(),
            gifFfmpeg.output()
        ]);

        if (!jpgResult.success) {
            const jpgError = new TextDecoder().decode(jpgResult.stderr);
            console.error('FFmpeg JPG error:', jpgError);
            throw new Error('Failed to extract JPG snapshot');
        }

        if (!gifResult.success) {
            const gifError = new TextDecoder().decode(gifResult.stderr);
            console.error('FFmpeg GIF error:', gifError);
            throw new Error('Failed to generate GIF snapshot');
        }

        console.log('JPG and GIF created successfully');
        return { jpgFilename, gifFilename };
    } catch (error: unknown) {
        if (error instanceof Error) {
            throw new Error(`Failed to process video: ${error.message}`);
        }
        throw new Error('Failed to process video: Unknown error');
    } finally {
        // Clean up temp video file
        try { await Deno.remove(tempVideoPath); } catch { /* ignore */ }
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
            '-t', String(GIF_CONFIG.duration),
            '-filter_complex', gifFilterComplex(),
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

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
        const headers = corsHeaders(request);
        if (Object.keys(headers).length > 0) {
            return new Response(null, { status: 204, headers });
        }
        return new Response(null, { status: 204 });
    }

    // Handle YouTube snapshot requests
    if (url.pathname.startsWith('/youtube-snapshot')) {
        const response = await handleYouTubeSnapshot(request);
        return addCorsHeaders(response, request);
    }
    
    // Add new redirect endpoint
    if (url.pathname === '/redirect') {
        const videoSrc = url.searchParams.get('url');
        const format = url.searchParams.get('format')?.toLowerCase() || 'jpg';

        if (!videoSrc) {
            return addCorsHeaders(new Response('Missing url parameter', { status: 400 }), request);
        }

        if (format !== 'jpg' && format !== 'gif') {
            return addCorsHeaders(new Response('Format must be either jpg or gif', { status: 400 }), request);
        }

        try {
            const { jpgFilename, gifFilename } = await takeSnapshot(videoSrc);
            const redirectUrl = `/images/${format === 'jpg' ? jpgFilename : gifFilename}`;

            return addCorsHeaders(new Response(null, {
                status: 302,
                headers: { 'Location': redirectUrl }
            }), request);
        } catch (error: unknown) {
            if (error instanceof Error) {
                return addCorsHeaders(new Response(JSON.stringify({ error: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                }), request);
            }
            return addCorsHeaders(new Response(JSON.stringify({ error: 'Unknown error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }), request);
        }
    }

    // Handle snapshot requests
    if (url.pathname === '/snapshot') {
        const videoSrc = url.searchParams.get('url');

        if (!videoSrc) {
            return addCorsHeaders(new Response('Missing url parameter', { status: 400 }), request);
        }

        try {
            const { jpgFilename, gifFilename } = await takeSnapshot(videoSrc);
            const jpgUrl = `${PUBLIC_URL}/images/${jpgFilename}`;
            const gifUrl = `${PUBLIC_URL}/images/${gifFilename}`;
            return addCorsHeaders(new Response(JSON.stringify({
                jpgUrl,
                gifUrl
            }), {
                headers: { 'Content-Type': 'application/json' }
            }), request);
        } catch (error: unknown) {
            if (error instanceof Error) {
                return addCorsHeaders(new Response(JSON.stringify({ error: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                }), request);
            }
            return addCorsHeaders(new Response(JSON.stringify({ error: 'Unknown error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }), request);
        }
    }

    // Serve static images
    if (url.pathname.startsWith('/images/')) {
        const filename = url.pathname.replace('/images/', '');
        try {
            const file = await Deno.readFile(join(SNAPSHOTS_PATH, filename));
            const contentType = filename.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
            return addCorsHeaders(new Response(file, {
                headers: { 'Content-Type': contentType }
            }), request);
        } catch (error) {
            return addCorsHeaders(new Response('Image not found', { status: 404 }), request);
        }
    }

    // Default route
    return addCorsHeaders(new Response(
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
    ), request);
});

// Run cleanup every hour
setInterval(cleanupOldSnapshots, 60 * 60 * 1000);

console.log(`Server running on port ${PORT}`);
