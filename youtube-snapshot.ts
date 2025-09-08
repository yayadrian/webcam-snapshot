/// <reference lib="dom" />

import { join } from "std/path/mod.ts";

// Constants
const DEFAULT_PORT = 3000;
const YT_DLP_RETRIES = 3;
const YT_DLP_FRAGMENT_RETRIES = 3;
const FFMPEG_SEEK_OFFSET = "0.1"; // seconds before end for JPG
const FFMPEG_GIF_DURATION = "1.0"; // seconds for GIF
const GIF_FPS = 10;
const GIF_SCALE = "320:-1";
const MAX_SNAPSHOTS_TO_KEEP = 100;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// YouTube thumbnail URLs in order of preference
const THUMBNAIL_URLS = [
    'live.jpg',        // Live thumbnail (updates frequently)
    'maxresdefault.jpg', // Max resolution
    'hqdefault.jpg'     // High quality fallback
] as const;

// Configure environment variables
const PORT = parseInt(Deno.env.get("PORT") || String(DEFAULT_PORT));
const PUBLIC_URL = Deno.env.get("PUBLIC_URL") || `http://localhost:${PORT}`;
const SNAPSHOTS_DIR = "youtube-snapshots";

// Type definitions
interface YouTubeSnapshotResult {
    jpgFilename: string;
    gifFilename: string;
}

interface YouTubeSnapshotUrls {
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

// Ensure snapshots directory exists
try {
    await Deno.mkdir(SNAPSHOTS_DIR, { recursive: true });
    console.log(`YouTube snapshots directory ready: ${SNAPSHOTS_DIR}`);
} catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
        console.error('Failed to create YouTube snapshots directory:', error);
        throw error;
    }
}

/**
 * Extract YouTube video ID from various YouTube URL formats
 * @param url - The YouTube URL to parse
 * @returns The video ID or null if not found
 */
function extractYouTubeVideoId(url: string): string | null {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
        /youtube\.com\/embed\/([^&\n?#]+)/,
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

/**
 * Takes a snapshot from YouTube video using multiple fallback methods
 * @param videoUrl - The YouTube video URL
 * @returns Promise<YouTubeSnapshotResult> with filenames of generated images
 * @throws Error if all snapshot methods fail
 */
async function takeYouTubeSnapshot(videoUrl: string): Promise<YouTubeSnapshotResult> {
    console.log('Processing YouTube video:', videoUrl);
    
    const videoId = extractYouTubeVideoId(videoUrl);
    if (!videoId) {
        throw new Error('Invalid YouTube URL');
    }
    
    const timestamp = createTimestamp();
    
    // Try the thumbnail method first as it's more reliable and faster
    try {
        console.log('Using direct thumbnail method');
        return await getYouTubeThumbnail(videoId, timestamp);
    } catch (thumbnailError) {
        console.error('Thumbnail method failed, falling back to video download:', thumbnailError);
        return await downloadAndExtractFromVideo(videoUrl, videoId, timestamp);
    }
}

/**
 * Downloads video segment and extracts snapshots using yt-dlp and ffmpeg
 * @param videoUrl - The YouTube video URL
 * @param videoId - The extracted video ID
 * @param timestamp - The timestamp for filename generation
 * @returns Promise<YouTubeSnapshotResult> with generated filenames
 */
async function downloadAndExtractFromVideo(
    videoUrl: string, 
    videoId: string, 
    timestamp: string
): Promise<YouTubeSnapshotResult> {
    const tempVideoFilename = join(SNAPSHOTS_DIR, `temp_segment-${timestamp}.mp4`);
    const jpgFilename = `youtube-${videoId}-${timestamp}.jpg`;
    const gifFilename = `youtube-${videoId}-${timestamp}.gif`;

    try {
        console.log('Downloading video segment using yt-dlp');
        
        // Create yt-dlp command with optimized settings
        const ytdlp = new Deno.Command('yt-dlp', {
            args: [
                '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                '--output', tempVideoFilename,
                '--live-from-start',
                '--downloader', 'ffmpeg',
                '--downloader-args', 'ffmpeg:-ss 0 -t 3', // Get 3 seconds
                '--force-overwrites',
                '--ignore-no-formats-error',
                '--ignore-errors',
                '--retries', String(YT_DLP_RETRIES),
                '--fragment-retries', String(YT_DLP_FRAGMENT_RETRIES),
                videoUrl
            ],
            stderr: "piped",
            stdout: "piped"
        });
        
        const ytdlpResult = await ytdlp.output();
        
        // Verify file was created and has content
        if (!ytdlpResult.success || !(await isValidVideoFile(tempVideoFilename))) {
            const ytdlpError = new TextDecoder().decode(ytdlpResult.stderr);
            const ytdlpOutput = new TextDecoder().decode(ytdlpResult.stdout);
            console.error('yt-dlp Error:', ytdlpError);
            console.log('yt-dlp Output:', ytdlpOutput);
            throw new Error('Failed to download video segment');
        }
        
        // Extract snapshots using FFmpeg
        await extractSnapshotsFromVideo(tempVideoFilename, jpgFilename, gifFilename);
        
        return { jpgFilename, gifFilename };
    } catch (error) {
        console.error('Video download method failed:', error);
        throw new Error('All snapshot methods failed');
    } finally {
        // Clean up temporary file
        await cleanupTempFile(tempVideoFilename);
    }
}

/**
 * Checks if a video file exists and has content
 * @param filename - Path to the video file
 * @returns Promise<boolean> - true if file exists and has content
 */
async function isValidVideoFile(filename: string): Promise<boolean> {
    try {
        const fileInfo = await Deno.stat(filename);
        return fileInfo.size > 0;
    } catch (_e) {
        return false;
    }
}

/**
 * Extracts JPG and GIF snapshots from a video file using FFmpeg
 * @param videoPath - Path to the source video file
 * @param jpgFilename - Filename for the JPG output
 * @param gifFilename - Filename for the GIF output
 */
async function extractSnapshotsFromVideo(
    videoPath: string, 
    jpgFilename: string, 
    gifFilename: string
): Promise<void> {
    // Create FFmpeg commands for JPG and GIF extraction
    const jpgCommand = new Deno.Command('ffmpeg', {
        args: [
            '-i', videoPath,
            '-sseof', `-${FFMPEG_SEEK_OFFSET}`,
            '-vframes', '1',
            '-f', 'image2',
            '-y',
            join(SNAPSHOTS_DIR, jpgFilename)
        ],
        stderr: "piped"
    });

    const gifCommand = new Deno.Command('ffmpeg', {
        args: [
            '-i', videoPath,
            '-sseof', `-${FFMPEG_GIF_DURATION}`,
            '-t', FFMPEG_GIF_DURATION,
            '-vf', `fps=${GIF_FPS},scale=${GIF_SCALE}:flags=lanczos`,
            '-y',
            join(SNAPSHOTS_DIR, gifFilename)
        ],
        stderr: "piped"
    });

    // Execute both commands in parallel
    const [jpgResult, gifResult] = await Promise.all([
        jpgCommand.output(),
        gifCommand.output()
    ]);
    
    if (!jpgResult.success || !gifResult.success) {
        const jpgError = new TextDecoder().decode(jpgResult.stderr);
        const gifError = new TextDecoder().decode(gifResult.stderr);
        console.error('FFmpeg JPG Error:', jpgError);
        console.error('FFmpeg GIF Error:', gifError);
        throw new Error('Failed to create snapshots from video');
    }
}

/**
 * Safely removes a temporary file, ignoring errors if file doesn't exist
 * @param filename - Path to the file to remove
 */
async function cleanupTempFile(filename: string): Promise<void> {
    try {
        await Deno.remove(filename);
        console.log(`Cleaned up temporary file: ${filename}`);
    } catch (error) {
        // Only log if it's not a "file not found" error
        if (!(error instanceof Deno.errors.NotFound)) {
            console.error('Failed to remove temporary file:', error);
        }
    }
}

/**
 * Downloads YouTube thumbnail and creates GIF from it
 * @param videoId - The YouTube video ID
 * @param timestamp - Timestamp for filename generation
 * @returns Promise<YouTubeSnapshotResult> with generated filenames
 */
async function getYouTubeThumbnail(videoId: string, timestamp: string): Promise<YouTubeSnapshotResult> {
    const jpgFilename = `youtube-${videoId}-${timestamp}.jpg`;
    const gifFilename = `youtube-${videoId}-${timestamp}.gif`;
    
    // Try thumbnail URLs in order of preference
    const response = await fetchBestThumbnail(videoId);
    
    // Save the thumbnail as JPG
    const imageData = new Uint8Array(await response.arrayBuffer());
    await Deno.writeFile(join(SNAPSHOTS_DIR, jpgFilename), imageData);
    
    // Create a static GIF from the JPG using FFmpeg
    await createStaticGifFromImage(jpgFilename, gifFilename);
    
    return { jpgFilename, gifFilename };
}

/**
 * Fetches the best available thumbnail for a YouTube video
 * @param videoId - The YouTube video ID
 * @returns Promise<Response> - The thumbnail response
 * @throws Error if no thumbnail is available
 */
async function fetchBestThumbnail(videoId: string): Promise<Response> {
    for (const thumbnailType of THUMBNAIL_URLS) {
        try {
            const url = `https://img.youtube.com/vi/${videoId}/${thumbnailType}`;
            console.log(`Trying thumbnail: ${thumbnailType}`);
            
            const response = await fetch(url);
            if (response.ok) {
                console.log(`Successfully fetched thumbnail: ${thumbnailType}`);
                return response;
            }
        } catch (error) {
            console.warn(`Failed to fetch ${thumbnailType}:`, error);
        }
    }
    
    throw new Error('Failed to download any YouTube thumbnail');
}

/**
 * Creates a static GIF from a JPG image using FFmpeg
 * @param jpgFilename - Source JPG filename
 * @param gifFilename - Target GIF filename
 */
async function createStaticGifFromImage(jpgFilename: string, gifFilename: string): Promise<void> {
    const ffmpegCommand = new Deno.Command('ffmpeg', {
        args: [
            '-i', join(SNAPSHOTS_DIR, jpgFilename),
            '-vf', `scale=${GIF_SCALE}:flags=lanczos`,
            '-y',
            join(SNAPSHOTS_DIR, gifFilename)
        ],
        stderr: "piped"
    });
    
    const result = await ffmpegCommand.output();
    if (!result.success) {
        const error = new TextDecoder().decode(result.stderr);
        console.error('FFmpeg GIF creation error:', error);
        throw new Error('Failed to create static GIF from thumbnail');
    }
}

/**
 * Clean up old YouTube snapshots, keeping only the latest files
 * @param maxFiles - Maximum number of files to keep (default: MAX_SNAPSHOTS_TO_KEEP)
 * @returns Promise that resolves when cleanup is complete
 */
async function cleanupOldSnapshots(maxFiles = MAX_SNAPSHOTS_TO_KEEP): Promise<void> {
    try {
        const files: string[] = [];
        
        // Collect all YouTube snapshot files
        for await (const entry of Deno.readDir(SNAPSHOTS_DIR)) {
            if (entry.isFile && entry.name.startsWith('youtube-')) {
                files.push(entry.name);
            }
        }
        
        // Sort files by creation time (newest first) and remove old ones
        const sortedFiles = files.sort().reverse();
        const filesToDelete = sortedFiles.slice(maxFiles);
        
        // Delete old files
        for (const file of filesToDelete) {
            try {
                await Deno.remove(join(SNAPSHOTS_DIR, file));
                console.log(`Cleaned up old YouTube snapshot: ${file}`);
            } catch (deleteError) {
                console.error(`Failed to delete ${file}:`, deleteError);
            }
        }
        
        if (filesToDelete.length > 0) {
            console.log(`YouTube cleanup complete: removed ${filesToDelete.length} old snapshots`);
        }
    } catch (error: unknown) {
        console.error('Error during YouTube snapshot cleanup:', error);
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
 * Handles the YouTube snapshot redirect endpoint
 * @param url - The URL object containing search parameters
 * @returns Response with redirect or error
 */
async function handleYouTubeRedirectEndpoint(url: URL): Promise<Response> {
    const videoUrl = url.searchParams.get('url');
    const format = url.searchParams.get('format')?.toLowerCase() || 'jpg';
    
    if (!videoUrl) {
        return new Response('Missing url parameter', { status: 400 });
    }
    
    if (!isValidFormat(format)) {
        return new Response('Format must be either jpg or gif', { status: 400 });
    }
    
    try {
        const { jpgFilename, gifFilename } = await takeYouTubeSnapshot(videoUrl);
        const redirectUrl = `/youtube-snapshot/images/${format === 'jpg' ? jpgFilename : gifFilename}`;
        
        return new Response(null, {
            status: 302,
            headers: { 'Location': redirectUrl }
        });
    } catch (error: unknown) {
        return createErrorResponse(error);
    }
}

/**
 * Handles the main YouTube snapshot endpoint
 * @param url - The URL object containing search parameters
 * @returns Response with JSON containing image URLs or error
 */
async function handleYouTubeSnapshotEndpoint(url: URL): Promise<Response> {
    const videoUrl = url.searchParams.get('url');
    
    if (!videoUrl) {
        return new Response('Missing url parameter', { status: 400 });
    }
    
    try {
        const { jpgFilename, gifFilename } = await takeYouTubeSnapshot(videoUrl);
        const response: YouTubeSnapshotUrls = {
            jpgUrl: `${PUBLIC_URL}/youtube-snapshot/images/${jpgFilename}`,
            gifUrl: `${PUBLIC_URL}/youtube-snapshot/images/${gifFilename}`
        };
        
        return new Response(JSON.stringify(response), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error: unknown) {
        return createErrorResponse(error);
    }
}

/**
 * Serves static YouTube snapshot images
 * @param filename - The filename to serve
 * @returns Response with the image file or 404 error
 */
async function handleYouTubeStaticImageEndpoint(filename: string): Promise<Response> {
    try {
        const file = await Deno.readFile(join(SNAPSHOTS_DIR, filename));
        const contentType = filename.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
        
        return new Response(file, {
            headers: { 'Content-Type': contentType }
        });
    } catch (_error) {
        return new Response('Image not found', { status: 404 });
    }
}

/**
 * Handles the YouTube service information endpoint
 * @returns Response with service documentation
 */
function handleYouTubeRootEndpoint(): Response {
    return new Response(
        'YouTube Snapshot Service\n\n' +
        'Available endpoints:\n\n' +
        '1. JSON Response:\n' +
        '   /youtube-snapshot?url=YOUR_YOUTUBE_URL\n\n' +
        '2. Direct Image Redirect:\n' +
        '   /youtube-snapshot/redirect?url=YOUR_YOUTUBE_URL&format=jpg\n' +
        '   /youtube-snapshot/redirect?url=YOUR_YOUTUBE_URL&format=gif\n', 
        {
            headers: { 'Content-Type': 'text/plain' }
        }
    );
}

/**
 * Main export function that handles YouTube snapshot requests
 * @param request - The incoming HTTP request
 * @returns Promise<Response> - The HTTP response
 */
export function handleYouTubeSnapshot(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle redirect endpoint
    if (url.pathname === '/youtube-snapshot/redirect') {
        return handleYouTubeRedirectEndpoint(url);
    }
    
    // Handle main snapshot endpoint
    if (url.pathname === '/youtube-snapshot') {
        return handleYouTubeSnapshotEndpoint(url);
    }
    
    // Serve static images
    if (url.pathname.startsWith('/youtube-snapshot/images/')) {
        const filename = url.pathname.replace('/youtube-snapshot/images/', '');
        return handleYouTubeStaticImageEndpoint(filename);
    }
    
    // Service information endpoint
    if (url.pathname === '/youtube-snapshot/') {
        return handleYouTubeRootEndpoint();
    }

    return new Response('Not found', { status: 404 });
}

// Setup cleanup interval
setInterval(cleanupOldSnapshots, CLEANUP_INTERVAL_MS); 