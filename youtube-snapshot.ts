/// <reference lib="dom" />

import { join } from "std/path/mod.ts";
import { GIF_CONFIG, gifFilterComplex, gifScaleFilter } from "./gif-config.ts";

interface Console {
    log(...data: unknown[]): void;
    error(...data: unknown[]): void;
}

// Configure environment variables
const PORT = parseInt(Deno.env.get("PORT") || "3000");
const PUBLIC_URL = Deno.env.get("PUBLIC_URL") || `http://localhost:${PORT}`;
const SNAPSHOTS_DIR = "youtube-snapshots";

// Ensure snapshots directory exists
try {
    await Deno.mkdir(SNAPSHOTS_DIR, { recursive: true });
} catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw error;
    }
}

// Function to extract video ID from YouTube URL
export function extractYouTubeVideoId(url: string): string | null {
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

// Function to take snapshot from YouTube stream
async function takeYouTubeSnapshot(videoUrl: string): Promise<{jpgFilename: string, gifFilename: string}> {
    console.log('Processing YouTube video:', videoUrl);
    
    const videoId = extractYouTubeVideoId(videoUrl);
    if (!videoId) {
        throw new Error('Invalid YouTube URL');
    }
    
    // Create timestamp for filenames
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Use yt-dlp video download for live/recent snapshots and animated GIFs
    const tempVideoFilename = join(SNAPSHOTS_DIR, `temp_segment-${timestamp}.mp4`);
    const jpgFilename = `youtube-${videoId}-${timestamp}.jpg`;
    const gifFilename = `youtube-${videoId}-${timestamp}.gif`;

    try {
        // Use yt-dlp to download a short segment of the video
        console.log('Downloading video segment using yt-dlp');
        const ytdlp = new Deno.Command('yt-dlp', {
            args: [
                '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                '--output', tempVideoFilename,
                '--downloader', 'ffmpeg',
                '--downloader-args', `ffmpeg:-t ${GIF_CONFIG.duration + 2}`,
                '--force-overwrites',
                '--ignore-no-formats-error',
                '--ignore-errors',
                '--retries', '3',
                '--fragment-retries', '3',
                '--socket-timeout', '15',
                videoUrl
            ],
            stderr: "piped",
            stdout: "piped"
        });

        const ytdlpResult = await ytdlp.output();
        const ytdlpOutput = new TextDecoder().decode(ytdlpResult.stdout);
        const ytdlpError = new TextDecoder().decode(ytdlpResult.stderr);

        // Check if file exists and has content
        let fileExists = false;
        try {
            const fileInfo = await Deno.stat(tempVideoFilename);
            fileExists = fileInfo.size > 0;
        } catch (_e) {
            fileExists = false;
        }

        if (!ytdlpResult.success || !fileExists) {
            console.error('yt-dlp Error:', ytdlpError);
            console.log('yt-dlp Output:', ytdlpOutput);
            throw new Error('Failed to download video segment');
        }

        // Extract last frame as JPG using FFmpeg
        const ffmpegJpgSnapshot = new Deno.Command('ffmpeg', {
            args: [
                '-sseof', '-0.1',
                '-i', tempVideoFilename,
                '-vframes', '1',
                '-f', 'image2',
                '-y',
                join(SNAPSHOTS_DIR, jpgFilename)
            ],
            stderr: "piped"
        });

        // Create animated GIF from the end of the downloaded segment
        const ffmpegGifSnapshot = new Deno.Command('ffmpeg', {
            args: [
                '-sseof', `-${GIF_CONFIG.duration}.0`,
                '-i', tempVideoFilename,
                '-t', String(GIF_CONFIG.duration),
                '-filter_complex', gifFilterComplex(),
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
            const jpgError = new TextDecoder().decode(jpgResult.stderr);
            const gifError = new TextDecoder().decode(gifResult.stderr);
            console.error('FFmpeg JPG Error:', jpgError);
            console.error('FFmpeg GIF Error:', gifError);
            throw new Error('Failed to create snapshots');
        }

        return { jpgFilename, gifFilename };
    } catch (videoError) {
        console.error('Video download failed, falling back to thumbnail:', videoError);

        // Fall back to thumbnail method if video download fails
        try {
            return await getYouTubeThumbnail(videoId, timestamp);
        } catch (thumbnailError) {
            console.error('Thumbnail fallback also failed:', thumbnailError);
            throw new Error('All snapshot methods failed');
        }
    } finally {
        // Clean up temporary file
        try {
            await Deno.remove(tempVideoFilename).catch(() => {});
        } catch (_error) {
            // Ignore cleanup errors
        }
    }
}

// Function to get YouTube thumbnail as fallback
async function getYouTubeThumbnail(videoId: string, timestamp: string): Promise<{jpgFilename: string, gifFilename: string}> {
    // Use live thumbnail URL which updates more frequently
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/live.jpg`;
    const fallbackThumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    const finalFallbackUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    
    const jpgFilename = `youtube-${videoId}-${timestamp}.jpg`;
    const gifFilename = `youtube-${videoId}-${timestamp}.gif`;
    
    // Try to download the thumbnail
    let response;
    try {
        // Try live thumbnail first
        response = await fetch(thumbnailUrl);
        if (!response.ok) {
            console.log('Live thumbnail not available, trying maxresdefault');
            response = await fetch(fallbackThumbnailUrl);
            
            if (!response.ok) {
                console.log('Maxres thumbnail not available, trying hqdefault');
                response = await fetch(finalFallbackUrl);
                
                if (!response.ok) {
                    throw new Error('Failed to download any thumbnail');
                }
            }
        }
    } catch (error) {
        throw new Error(`Failed to fetch YouTube thumbnail: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Write the downloaded thumbnail as JPG
    const imageData = new Uint8Array(await response.arrayBuffer());
    await Deno.writeFile(join(SNAPSHOTS_DIR, jpgFilename), imageData);
    
    // Create a simple static GIF from the JPG
    const ffmpegStaticGif = new Deno.Command('ffmpeg', {
        args: [
            '-i', join(SNAPSHOTS_DIR, jpgFilename),
            '-vf', gifScaleFilter(),
            '-y',
            join(SNAPSHOTS_DIR, gifFilename)
        ],
        stderr: "piped"
    });
    
    const gifResult = await ffmpegStaticGif.output();
    if (!gifResult.success) {
        const gifError = new TextDecoder().decode(gifResult.stderr);
        console.error('FFmpeg GIF Error:', gifError);
        throw new Error('Failed to create static GIF from thumbnail');
    }
    
    return { jpgFilename, gifFilename };
}

// Clean up old snapshots (keep last 100)
async function cleanupOldSnapshots() {
    try {
        const files = [];
        for await (const entry of Deno.readDir(SNAPSHOTS_DIR)) {
            if (entry.isFile && entry.name.startsWith('youtube-')) {
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

// Export the handler function to be used by the main server
export async function handleYouTubeSnapshot(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Add new redirect endpoint
    if (url.pathname === '/youtube-snapshot/redirect') {
        const videoUrl = url.searchParams.get('url');
        const format = url.searchParams.get('format')?.toLowerCase() || 'jpg';
        
        if (!videoUrl) {
            return new Response('Missing url parameter', { status: 400 });
        }
        
        if (format !== 'jpg' && format !== 'gif') {
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
    if (url.pathname === '/youtube-snapshot') {
        const videoUrl = url.searchParams.get('url');
        
        if (!videoUrl) {
            return new Response('Missing url parameter', { status: 400 });
        }
        
        try {
            const { jpgFilename, gifFilename } = await takeYouTubeSnapshot(videoUrl);
            const jpgUrl = `${PUBLIC_URL}/youtube-snapshot/images/${jpgFilename}`;
            const gifUrl = `${PUBLIC_URL}/youtube-snapshot/images/${gifFilename}`;
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
    if (url.pathname.startsWith('/youtube-snapshot/images/')) {
        const filename = url.pathname.replace('/youtube-snapshot/images/', '');
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
    
    // Default route for YouTube snapshot service
    if (url.pathname === '/youtube-snapshot/') {
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

    return new Response('Not found', { status: 404 });
}

// Run cleanup every hour
setInterval(cleanupOldSnapshots, 60 * 60 * 1000); 