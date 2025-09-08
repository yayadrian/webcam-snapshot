/// <reference lib="dom" />

import { join } from "std/path/mod.ts";
import { handleYouTubeSnapshot } from "./youtube-snapshot.ts";

// Constants
const DEFAULT_PORT = 3000;
const FFMPEG_TIMEOUT = "30000000"; // 30 seconds in microseconds
const FFMPEG_SEGMENT_DURATION = "1"; // 1 second for GIF
const GIF_FPS = 10;
const GIF_SCALE = "320:-1";
const MAX_SNAPSHOTS_TO_KEEP = 100;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Configure environment variables
const PORT = parseInt(Deno.env.get("PORT") || String(DEFAULT_PORT));
const PUBLIC_URL = Deno.env.get("PUBLIC_URL") || `http://localhost:${PORT}`;
const SNAPSHOTS_DIR = "snapshots";

// Get current working directory and create absolute path for snapshots
const CURRENT_DIR = Deno.cwd();
const SNAPSHOTS_PATH = join(CURRENT_DIR, SNAPSHOTS_DIR);

// Type definitions
interface SnapshotResult {
    jpgFilename: string;
    gifFilename: string;
}

interface SnapshotUrls {
    jpgUrl: string;
    gifUrl: string;
}

/**
 * Utility function to create a standardized timestamp for filenames
 * @returns ISO timestamp with colons and dots replaced with hyphens
 */
function createTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Utility function to handle JSON error responses
 * @param error - The error to format
 * @param status - HTTP status code (default: 500)
 * @returns Response with JSON error message
 */
function createErrorResponse(error: unknown, status = 500): Response {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Creates an FFmpeg command for capturing a JPG frame from a video stream
 * @param videoSrc - The video source URL
 * @param outputPath - The output file path for the JPG
 * @returns Configured Deno.Command for FFmpeg
 */
function createJpgCaptureCommand(videoSrc: string, outputPath: string): Deno.Command {
    return new Deno.Command('ffmpeg', {
        args: [
            '-loglevel', 'warning',
            '-timeout', FFMPEG_TIMEOUT,
            '-i', videoSrc,
            '-vframes', '1',
            '-f', 'image2',
            '-y',
            outputPath
        ],
        stderr: "piped"
    });
}

/**
 * Creates an FFmpeg command for capturing a GIF from a video stream
 * @param videoSrc - The video source URL
 * @param outputPath - The output file path for the GIF
 * @returns Configured Deno.Command for FFmpeg
 */
function createGifCaptureCommand(videoSrc: string, outputPath: string): Deno.Command {
    return new Deno.Command('ffmpeg', {
        args: [
            '-loglevel', 'warning',
            '-timeout', FFMPEG_TIMEOUT,
            '-i', videoSrc,
            '-t', FFMPEG_SEGMENT_DURATION,
            '-vf', `fps=${GIF_FPS},scale=${GIF_SCALE}:flags=lanczos`,
            '-y',
            outputPath
        ],
        stderr: "piped"
    });
}

/**
 * Execute an FFmpeg command and handle errors
 * @param command - The FFmpeg command to execute
 * @param operationType - Description of the operation for error reporting
 * @returns Promise that resolves if successful, throws if failed
 */
async function executeFFmpegCommand(command: Deno.Command, operationType: string): Promise<void> {
    const result = await command.output();
    if (!result.success) {
        const error = new TextDecoder().decode(result.stderr);
        console.error(`FFmpeg ${operationType} Error:`, error);
        throw new Error(`Failed to ${operationType.toLowerCase()}`);
    }
}

/**
 * Takes a snapshot (JPG + 1s GIF) from a video stream
 * @param videoSrc - The video source URL (HLS, webcam, etc.)
 * @returns Promise<SnapshotResult> with filenames of generated images
 * @throws Error if snapshot generation fails
 */
async function takeSnapshot(videoSrc: string): Promise<SnapshotResult> {
    console.log('Loading video stream...', videoSrc);
    
    // Create timestamp for filenames
    const timestamp = createTimestamp();
    const jpgFilename = `snapshot-${timestamp}.jpg`;
    const gifFilename = `snapshot-${timestamp}.gif`;
    
    // Create absolute paths for output files
    const jpgPath = join(SNAPSHOTS_PATH, jpgFilename);
    const gifPath = join(SNAPSHOTS_PATH, gifFilename);
    
    try {
        // Capture JPG and GIF in parallel for efficiency
        console.log('Capturing JPG and GIF from stream');
        const jpgCommand = createJpgCaptureCommand(videoSrc, jpgPath);
        const gifCommand = createGifCaptureCommand(videoSrc, gifPath);
        
        await Promise.all([
            executeFFmpegCommand(jpgCommand, 'JPG capture'),
            executeFFmpegCommand(gifCommand, 'GIF capture')
        ]);
        
        return { jpgFilename, gifFilename };
    } catch (error: unknown) {
        if (error instanceof Error) {
            throw new Error(`Failed to process video: ${error.message}`);
        }
        throw new Error('Failed to process video: Unknown error');
    }
}



/**
 * Clean up old snapshots, keeping only the latest files
 * @param maxFiles - Maximum number of files to keep (default: MAX_SNAPSHOTS_TO_KEEP)
 * @returns Promise that resolves when cleanup is complete
 */
async function cleanupOldSnapshots(maxFiles = MAX_SNAPSHOTS_TO_KEEP): Promise<void> {
    try {
        const files: string[] = [];
        
        // Collect all snapshot files
        for await (const entry of Deno.readDir(SNAPSHOTS_PATH)) {
            if (entry.isFile && entry.name.startsWith('snapshot-')) {
                files.push(entry.name);
            }
        }
        
        // Sort files by creation time (newest first) and remove old ones
        const sortedFiles = files.sort().reverse();
        const filesToDelete = sortedFiles.slice(maxFiles);
        
        // Delete old files
        for (const file of filesToDelete) {
            try {
                await Deno.remove(join(SNAPSHOTS_PATH, file));
                console.log(`Cleaned up old snapshot: ${file}`);
            } catch (deleteError) {
                console.error(`Failed to delete ${file}:`, deleteError);
            }
        }
        
        if (filesToDelete.length > 0) {
            console.log(`Cleanup complete: removed ${filesToDelete.length} old snapshots`);
        }
    } catch (error: unknown) {
        console.error('Error during snapshot cleanup:', error);
    }
}

/**
 * Validates format parameter for redirect endpoints
 * @param format - The format string to validate
 * @returns true if format is valid (jpg or gif)
 */
function isValidFormat(format: string): format is 'jpg' | 'gif' {
    return format === 'jpg' || format === 'gif';
}

/**
 * Handles the redirect endpoint for webcam snapshots
 * @param url - The URL object containing search parameters
 * @returns Response with redirect or error
 */
async function handleRedirectEndpoint(url: URL): Promise<Response> {
    const videoSrc = url.searchParams.get('url');
    const format = url.searchParams.get('format')?.toLowerCase() || 'jpg';
    
    if (!videoSrc) {
        return new Response('Missing url parameter', { status: 400 });
    }
    
    if (!isValidFormat(format)) {
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
        return createErrorResponse(error);
    }
}

/**
 * Handles the main snapshot endpoint for webcam captures
 * @param url - The URL object containing search parameters
 * @returns Response with JSON containing image URLs or error
 */
async function handleSnapshotEndpoint(url: URL): Promise<Response> {
    const videoSrc = url.searchParams.get('url');
    
    if (!videoSrc) {
        return new Response('Missing url parameter', { status: 400 });
    }
    
    try {
        const { jpgFilename, gifFilename } = await takeSnapshot(videoSrc);
        const response: SnapshotUrls = {
            jpgUrl: `${PUBLIC_URL}/images/${jpgFilename}`,
            gifUrl: `${PUBLIC_URL}/images/${gifFilename}`
        };
        
        return new Response(JSON.stringify(response), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error: unknown) {
        return createErrorResponse(error);
    }
}

/**
 * Serves static image files from the snapshots directory
 * @param filename - The filename to serve
 * @returns Response with the image file or 404 error
 */
async function handleStaticImageEndpoint(filename: string): Promise<Response> {
    try {
        const file = await Deno.readFile(join(SNAPSHOTS_PATH, filename));
        const contentType = filename.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
        
        return new Response(file, {
            headers: { 'Content-Type': contentType }
        });
    } catch (_error) {
        return new Response('Image not found', { status: 404 });
    }
}

/**
 * Handles the root endpoint with service information
 * @returns Response with service documentation
 */
function handleRootEndpoint(): Response {
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
}

/**
 * Main HTTP request handler that routes requests to appropriate endpoints
 * @param request - The incoming HTTP request
 * @returns Promise<Response> - The HTTP response
 */
function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle YouTube snapshot requests
    if (url.pathname.startsWith('/youtube-snapshot')) {
        return handleYouTubeSnapshot(request);
    }
    
    // Handle webcam snapshot redirect endpoint
    if (url.pathname === '/redirect') {
        return handleRedirectEndpoint(url);
    }
    
    // Handle webcam snapshot endpoint
    if (url.pathname === '/snapshot') {
        return handleSnapshotEndpoint(url);
    }
    
    // Serve static images
    if (url.pathname.startsWith('/images/')) {
        const filename = url.pathname.replace('/images/', '');
        return handleStaticImageEndpoint(filename);
    }
    
    // Default route - service information
    return handleRootEndpoint();
}

// Ensure snapshots directory exists
try {
    await Deno.mkdir(SNAPSHOTS_DIR, { recursive: true });
    console.log(`Snapshots directory ready: ${SNAPSHOTS_PATH}`);
} catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
        console.error('Failed to create snapshots directory:', error);
        throw error;
    }
}

// Start the HTTP server
Deno.serve({ port: PORT }, handleRequest);

// Run cleanup every hour
setInterval(cleanupOldSnapshots, CLEANUP_INTERVAL_MS);

console.log(`Webcam Snapshot Service running on port ${PORT}`);
console.log(`Public URL: ${PUBLIC_URL}`);
console.log(`Snapshots directory: ${SNAPSHOTS_PATH}`);
