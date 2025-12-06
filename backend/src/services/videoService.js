// StoryGenApp/backend/src/services/videoService.js

const fs = require('fs');
const path = require('path');
const { fetch } = require('undici');
const { log } = require('../utils/logger');
const { analyzeShotTransition } = require('./llmService');
const { GoogleAuth } = require('google-auth-library');
const videoLogStore = require('./videoLogStore');

const dataDir = path.join(__dirname, '../../data');
const videoDir = path.join(dataDir, 'videos');
const ensureDirs = () => {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
};

// Helper to read image bytes (from URL or Base64 data URI)
const readImageBytes = async (imageUrl) => {
  if (!imageUrl) return null;

  const DATA_URL_REGEX = /^data:(.+?);base64,(.+)$/;
  const dataMatch = DATA_URL_REGEX.exec(imageUrl);

  if (dataMatch) {
    // Already a base64 data URI
    return { bytesBase64Encoded: dataMatch[2], mimeType: dataMatch[1] || 'image/png' };
  }

  if (imageUrl.startsWith('http')) {
    // Fetch from URL
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`Failed to fetch image from URL: ${imageUrl}, Status: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { bytesBase64Encoded: buffer.toString('base64'), mimeType: res.headers.get('content-type') || 'image/png' };
  }
  
  // If it's a local file path (unlikely in this flow now but keep for robustness)
  if (fs.existsSync(imageUrl)) {
    const buffer = await fs.promises.readFile(imageUrl);
    const ext = path.extname(imageUrl).toLowerCase();
    let mimeType = 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    if (ext === '.webp') mimeType = 'image/webp';
    if (ext === '.gif') mimeType = 'image/gif';
    return { bytesBase64Encoded: buffer.toString('base64'), mimeType: mimeType };
  }

  throw new Error(`Unsupported image URL/path format: ${imageUrl}`);
};

// Vertex AI video generation call
const startVideoJobVertex = async ({ prompt, model, firstFrame, lastFrame, durationSeconds }) => {
  const projectId = process.env.VERTEX_PROJECT_ID;
  const location = process.env.VERTEX_LOCATION || 'us-central1';
  if (!projectId) throw new Error('VERTEX_PROJECT_ID is required for Vertex fallback');

  const modelId = model.startsWith('publishers/') ? model : `publishers/google/models/${model}`;
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/${modelId}:predictLongRunning`;

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  // 调试：看看这个 token 属于谁
  // try {
  //   const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token?.token || token}`);
  //   const infoJson = await infoRes.json();
  //   log('vertex_auth_identity', infoJson); // 这里面会有 email / sub 等
  // } catch (e) {
  //   console.warn('Failed to introspect token', e);
  // }
 
  const instance = {
    prompt: prompt,
  };
  
  // Construct image payload for Vertex REST API
  if (firstFrame) {
      instance.image = firstFrame;
  }
  if (lastFrame) {
      instance.lastFrame = lastFrame;
  }

  const body = {
    instances: [instance],
    parameters: {
        aspectRatio: "16:9",
        durationSeconds: durationSeconds,
        resolution: "1080p",
        personGeneration: "allow_all",
        enhancePrompt: true,
        generateAudio: true
    }
  };

  log('vertex_start_request', { url, modelId });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token?.token || token}`,
    },
    body: JSON.stringify(body),
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to start vertex video job: ${res.status} ${text}`);
  }
  
  const json = await res.json();
  return json.name; 
};

const pollOperationVertex = async (name, maxAttempts = 60, delayMs = 40000) => {
  const projectId = process.env.VERTEX_PROJECT_ID;
  const location = process.env.VERTEX_LOCATION || 'us-central1';
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  log('vertex_poll_auth_success', { location, projectId });

  const modelId = process.env.VERTEX_VEO_MODEL_ID || 'veo-3.1-generate-preview';
  const pollUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:fetchPredictOperation`;
  
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(pollUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token?.token || token}`
      },
      body: JSON.stringify({ operationName: name })
    });
    
    if (!res.ok) {
      const text = await res.text();
      log('vertex_poll_error', { status: res.status, message: text });
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    
    const json = await res.json();
    if (json.error) throw new Error(`Vertex operation error: ${json.error.message}`);
    
    if (json.done) {
        if (json.response && json.response.error) {
             throw new Error(`Video generation failed: ${json.response.error.message}`);
        }
        return json;
    }
    
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Vertex video generation timed out');
};

const extractVideoUriVertex = (op) => {
    const samples = op?.response?.generateVideoResponse?.generatedSamples;
    if (samples && samples.length > 0 && samples[0].video && samples[0].video.uri) {
        return samples[0].video.uri;
    }
  if (op?.response?.videos && op.response.videos.length > 0 && op.response.videos[0].bytesBase64Encoded) {
        return { base64: op.response.videos[0].bytesBase64Encoded };
    }
    return null;
};

const generateClipWithVertex = async ({ prompt, model, firstFrame, lastFrame, durationSeconds }) => {
  try {
    const opName = await startVideoJobVertex({
      prompt,
      model,
      firstFrame,
      lastFrame,
      durationSeconds
    });
    
    log('vertex_clip_job_started', { opName });
    
    const opResult = await pollOperationVertex(opName);
    const videoData = extractVideoUriVertex(opResult);
    
    if (!videoData) throw new Error("No video data found in Vertex response");
    
    if (videoData.base64) {
        const fileName = `clip_vertex_${Date.now()}.mp4`;
        const outPath = path.join(videoDir, fileName);
        await fs.promises.writeFile(outPath, Buffer.from(videoData.base64, 'base64'));
        return { video_path: outPath, provider: 'vertex' };
    } else if (videoData.startsWith && videoData.startsWith('gs://')) {
        // If it's a GCS URI, log and return the URI for now.
        log('received_gcs_uri', { uri: videoData });
        return { video_uri: videoData, provider: 'vertex' };
    }
    
  } catch (e) {
    console.error("Vertex generation failed:", e);
    throw e;
  }
  return { video_path: null, provider: 'vertex' }; // Should not reach here
};

// Main function: Vertex only (Gemini video path disabled)
const generateClipDirectly = async (params) => {
    const firstFrame = await readImageBytes(params.first_frame_url);
    const lastFrame = await readImageBytes(params.last_frame_url);
    
    const model = params.model || 'veo-3.1-generate-preview';
    const shared = {
      prompt: params.prompt,
      model,
      firstFrame,
      lastFrame,
      durationSeconds: params.duration_seconds
    };

    return await generateClipWithVertex(shared);
};

/**
 * Generate a full video from a storyboard using "Interpolation Chain" (Slide Window).
 * 1. Analyze pairs (Shot A -> Shot B) to get transition prompt & duration.
 * 2. Generate clips in parallel.
 * 3. Stitch clips.
 */
exports.generateFullVideoFromShots = async (storyboard) => {
  ensureDirs();
  const startTime = Date.now();
  
  const logId = videoLogStore.createLog(storyboard);
  log('video_generation_start', { shot_count: storyboard.length, logId });

  if (!storyboard || storyboard.length < 2) {
    const error = "Need at least 2 shots to generate a video sequence.";
    videoLogStore.updateLog(logId, { status: 'error', errorMessage: error });
    throw new Error(error);
  }

  try {
    // --- PHASE 1: PLAN (Analyze Transitions) ---
    const transitionPlans = [];
    // Sliding window: [0,1], [1,2], [2,3]...
    for (let i = 0; i < storyboard.length - 1; i++) {
      const shotA = storyboard[i];
      const shotB = storyboard[i+1];
      
      log('analyzing_transition', { from: shotA.shot, to: shotB.shot });
      
      try {
         // Call LLM to analyze visual transition
         const analysis = await analyzeShotTransition(shotA, shotB);
         
         transitionPlans.push({
           index: i,
           shotA: { shot: shotA.shot, description: shotA.description, imageUrl: shotA.imageUrl },
           shotB: { shot: shotB.shot, description: shotB.description, imageUrl: shotB.imageUrl },
           prompt: analysis.transition_prompt,
           duration: analysis.duration
         });
      } catch (e) {
          console.error(`Failed to analyze transition for shots ${shotA.shot}->${shotB.shot}`, e);
          // Fallback plan
          transitionPlans.push({
            index: i,
            shotA: { shot: shotA.shot, description: shotA.description, imageUrl: shotA.imageUrl },
            shotB: { shot: shotB.shot, description: shotB.description, imageUrl: shotB.imageUrl },
            prompt: "Cinematic transition, smooth camera movement.",
            duration: 6
          });
      }
    }

    // Add a closing clip for the final shot (no trailing frame).
    const closingShot = storyboard[storyboard.length - 1];
    const parsedClosingDuration = parseInt(closingShot.duration, 10);
    const validDurations = [4, 6, 8];
    const closingDuration = validDurations.includes(parsedClosingDuration) ? parsedClosingDuration : 6;
    const closingPrompt = `${closingShot.prompt || closingShot.description || "Final lingering shot."} Hold on the final frame with a gentle cinematic finish.`;
    transitionPlans.push({
      index: transitionPlans.length,
      shotA: { shot: closingShot.shot, description: closingShot.description, imageUrl: closingShot.imageUrl },
      shotB: null,
      prompt: closingPrompt,
      duration: closingDuration,
      isClosing: true
    });

    log('transition_plans_ready', { count: transitionPlans.length });
    videoLogStore.updateLog(logId, { status: 'generating', transitionPlans });

    // --- PHASE 2: GENERATE (Parallel Execution) ---
    // We map plans to promises
    const generatePromises = transitionPlans.map(async (plan) => {
        const { index, shotA, shotB, prompt, duration } = plan;
        
        try {
            log('generating_clip_start', { index, duration, closing: !!plan.isClosing });
            
            // Use direct Node.js implementation instead of Python
            const result = await generateClipDirectly({
                prompt: prompt,
                duration_seconds: duration,
                first_frame_url: shotA.imageUrl, // Pass URLs directly
                last_frame_url: shotB ? shotB.imageUrl : null, // Pass URLs directly (may be null for closing shot)
                enhance_prompt: true,
                generate_audio: true
            });
            
            let videoPath = null;
            if (result.video_path) {
                videoPath = result.video_path;
            } else if (result.video_uri) {
                console.warn(`GCS URI returned: ${result.video_uri}. Direct download not implemented. If this is unexpected, ensure Vertex is configured to return video_bytes or an accessible URL.`);
                throw new Error("GCS URI returned, direct download not fully supported in current implementation.");
            }
            
            return { index, videoPath, prompt, duration, provider: result.provider || 'vertex' };
            
        } catch (e) {
            console.error(`Error generating clip for index ${index}:`, e);
            throw e; 
        }
    });

    // Execute all generations
    const clipResults = await Promise.all(generatePromises);
    
    // Sort by index just to be safe
    clipResults.sort((a, b) => a.index - b.index);
    const videoFiles = clipResults.map(r => r.videoPath);
    
    videoLogStore.updateLog(logId, { status: 'stitching', clipResults });

    // --- PHASE 3: STITCH (Assembly) ---
    log('stitching_videos', { files: videoFiles });
    
    const outputName = `full_story_${Date.now()}.mp4`;
    const outputPath = path.join(videoDir, outputName);
    
    // Create concat list
    const concatListPath = path.join(videoDir, `concat_list_${Date.now()}.txt`);
    const concatContent = videoFiles.filter(Boolean).map(f => `file '${f}'`).join('\n'); // Filter out nulls
    if (!concatContent) {
        throw new Error("No video files to stitch.");
    }
    await fs.promises.writeFile(concatListPath, concatContent);

    const ffmpeg = require('fluent-ffmpeg');
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy']) // Fast stream copy
        .on('end', () => {
          log('ffmpeg_stitch_complete', { outputPath });
          resolve();
        })
        .on('error', (err) => {
          log('ffmpeg_stitch_error', { error: err.message });
          reject(err);
        })
        .save(outputPath);
    });
    
    const finalVideoUrl = `http://localhost:${process.env.PORT || 3005}/videos/${outputName}`;
    const duration = Date.now() - startTime;
    
    videoLogStore.updateLog(logId, { 
      status: 'completed', 
      finalVideoUrl, 
      duration 
    });
    
    log('full_video_complete', { output: outputPath, logId, duration });
    return finalVideoUrl;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    videoLogStore.updateLog(logId, { 
      status: 'error', 
      errorMessage: error.message,
      duration 
    });
    throw error;
  }
};

// --- Backwards Compatibility Exports (Optional/Deprecated) ---
exports.generateVideo = async (storyboard) => {
    return exports.generateFullVideoFromShots(storyboard);
};

exports.generateSequencedVideo = async (storyboard, segments) => {
    return exports.generateFullVideoFromShots(storyboard);
};

exports.generateVideosForSegments = async (storyboard, segments) => {
    return exports.generateFullVideoFromShots(storyboard);
};
// Removed exports.stitchVideos as it's now internal to generateFullVideoFromShots
