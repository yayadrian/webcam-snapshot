import { serve } from "https://deno.land/std/http/server.ts";
import { join } from "https://deno.land/std/path/mod.ts";

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
        const playlist = await response.text();
        
        // Parse m3u8 to get the first video segment
        const lines = playlist.split('\n');
        const videoSegment = lines.find(line => {
            const trimmedLine = line.trim();
            return trimmedLine && trimmedLine.endsWith('.ts') && !trimmedLine.startsWith('#');
        });
        
        if (!videoSegment) {
            throw new Error('No video segments found in playlist');
        }

        const videoUrl = videoSegment.trim();
        const videoResponse = await fetch(videoUrl);
        const videoBuffer = await videoResponse.arrayBuffer();
        
        // Create timestamp for filenames
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const tempVideoFilename = join(SNAPSHOTS_DIR, `temp_segment-${timestamp}.ts`);
        const jpgFilename = `snapshot-${timestamp}.jpg`;
        const gifFilename = `snapshot-${timestamp}.gif`;
        
        // Save the video segment temporarily
        await Deno.writeFile(tempVideoFilename, new Uint8Array(videoBuffer));
        
        // Extract first frame as JPG using FFmpeg
        const ffmpegJpgSnapshot = new Deno.Command('ffmpeg', {
            args: [
                '-i', tempVideoFilename,
                '-vframes', '1',
                '-f', 'image2',
                join(SNAPSHOTS_DIR, jpgFilename)
            ]
        });

        // Create a 1-second GIF using FFmpeg
        const ffmpegGifSnapshot = new Deno.Command('ffmpeg', {
            args: [
                '-i', tempVideoFilename,
                '-t', '1',
                '-vf', 'fps=10,scale=320:-1:flags=lanczos',
                join(SNAPSHOTS_DIR, gifFilename)
            ]
        });

        const [jpgResult, gifResult] = await Promise.all([
            ffmpegJpgSnapshot.output(),
            ffmpegGifSnapshot.output()
        ]);
        
        if (!jpgResult.success || !gifResult.success) {
            throw new Error('Failed to create snapshots');
        }

        // Clean up temporary file
        await Deno.remove(tempVideoFilename);
        
        return { jpgFilename, gifFilename };
    } catch (error) {
        throw new Error(`Failed to process video: ${error.message}`);
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
    } catch (error) {
        console.error('Error cleaning up snapshots:', error);
    }
}

// Start the HTTP server
serve(async (req: Request) => {
    const url = new URL(req.url);
    
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
            const redirectUrl = `${PUBLIC_URL}/images/${format === 'jpg' ? jpgFilename : gifFilename}`;
            
            return new Response(null, {
                status: 302,
                headers: { 'Location': redirectUrl }
            });
        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
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
        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
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
        '1. JSON Response:\n' +
        '   /snapshot?url=YOUR_WEBCAM_URL\n\n' +
        '2. Direct Image Redirect:\n' +
        '   /redirect?url=YOUR_WEBCAM_URL&format=jpg\n' +
        '   /redirect?url=YOUR_WEBCAM_URL&format=gif\n', 
        {
            headers: { 'Content-Type': 'text/plain' }
        }
    );
}, { port: PORT });

// Run cleanup every hour
setInterval(cleanupOldSnapshots, 60 * 60 * 1000);

console.log(`Server running on port ${PORT}`);
