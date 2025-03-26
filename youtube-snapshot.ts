/// <reference lib="dom" />

import { join } from "std/path/mod.ts";

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

// Function to get HLS stream URL from YouTube video ID
async function getYouTubeStreamUrl(videoId: string): Promise<string> {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    const html = await response.text();
    
    // Extract player config
    const playerConfigMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;/);
    if (!playerConfigMatch) {
        throw new Error('Could not find player configuration');
    }

    const playerConfig = JSON.parse(playerConfigMatch[1]);
    
    // Find the highest quality HLS stream
    const formats = playerConfig.streamingData?.formats || [];
    const hlsFormats = formats.filter((f: any) => f.mimeType?.includes('application/x-mpegURL'));
    
    if (hlsFormats.length === 0) {
        throw new Error('No HLS streams found');
    }

    // Sort by quality and get the highest quality stream
    hlsFormats.sort((a: any, b: any) => (b.height || 0) - (a.height || 0));
    return hlsFormats[0].url;
}

// Function to take snapshot from YouTube stream
async function takeYouTubeSnapshot(videoUrl: string): Promise<{jpgFilename: string, gifFilename: string}> {
    console.log('Processing YouTube video:', videoUrl);
    
    const videoId = extractYouTubeVideoId(videoUrl);
    if (!videoId) {
        throw new Error('Invalid YouTube URL');
    }

    const streamUrl = await getYouTubeStreamUrl(videoId);
    
    // Create timestamp for filenames
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempVideoFilename = join(SNAPSHOTS_DIR, `temp_segment-${timestamp}.mp4`);
    const jpgFilename = `youtube-${videoId}-${timestamp}.jpg`;
    const gifFilename = `youtube-${videoId}-${timestamp}.gif`;

    // Download the stream segment
    const response = await fetch(streamUrl);
    const playlist = await response.text();
    
    // Parse m3u8 to get first video segment
    const lines = playlist.split('\n');
    let videoSegment: string | undefined;

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine && !trimmedLine.startsWith('#')) {
            videoSegment = trimmedLine;
            break;
        }
    }
    
    if (!videoSegment) {
        throw new Error('No video segments found in playlist');
    }

    // Get the base URL from the stream URL
    const baseUrl = new URL(streamUrl).href.split('/').slice(0, -1).join('/');
    const segmentUrl = videoSegment.startsWith('http') ? videoSegment : `${baseUrl}/${videoSegment}`;
    
    // Download the video segment
    const videoResponse = await fetch(segmentUrl);
    const videoBuffer = await videoResponse.arrayBuffer();
    
    // Save the video segment temporarily
    await Deno.writeFile(tempVideoFilename, new Uint8Array(videoBuffer));
    
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