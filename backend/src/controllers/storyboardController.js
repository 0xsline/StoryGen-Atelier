const llmService = require('../services/llmService');
const imageGenService = require('../services/imageGenService');
const videoService = require('../services/videoService');
const storyboardLogStore = require('../services/storyboardLogStore');
const { log } = require('../utils/logger');

exports.generateStoryboard = async (req, res) => {
  const { sentence, shotCount, style } = req.body;

  if (!sentence) {
    return res.status(400).json({ error: 'Sentence is required' });
  }

  const normalizedShotCount = Number.isInteger(shotCount) ? Math.min(Math.max(shotCount, 2), 12) : undefined;
  const requestedShots = normalizedShotCount || 6;
  const startTime = Date.now();
  const logId = storyboardLogStore.createLog({
    sentence,
    requestedShots,
    style,
    model: llmService.getConfiguredTextModel(
      process.env.GEMINI_TEXT_MODEL || "gemini-3-pro-preview"
    ),
  });

  try {
    log('storyboard_generate_start', { sentencePreview: sentence.slice(0, 80), requestedShots: shotCount, style, storyboardLogId: logId });

    // Step 1: Generate storyboard prompts using LLM service
    const storyboardPrompts = await llmService.generatePrompts(sentence, requestedShots, style);

    // Step 2: Generate images for each prompt using image generation service
    const storyboardWithImages = [];
    let previousStyleHint = '';
    let referenceImageBase64 = null;
    let heroSubject = '';
    
    // Extract heroSubject from first shot if available
    if (storyboardPrompts.length > 0 && storyboardPrompts[0].heroSubject) {
      heroSubject = storyboardPrompts[0].heroSubject;
    }
    
    for (let i = 0; i < storyboardPrompts.length; i++) {
      const shot = storyboardPrompts[i];
      let imageUrl = shot.imageUrl;
      if (!imageUrl) {
        // For shot 1, no reference image; for subsequent shots, use first shot's image as reference
        imageUrl = await imageGenService.generateImage(
          shot.prompt, 
          previousStyleHint, 
          style,
          i > 0 ? referenceImageBase64 : null,
          heroSubject
        );
        
        // Store first shot's image as reference for subsequent shots
        if (i === 0 && imageUrl && imageUrl.startsWith('data:')) {
          referenceImageBase64 = imageUrl.split(',')[1];
        }
      }
      storyboardWithImages.push({ ...shot, imageUrl });
      previousStyleHint = shot.prompt;
    }

    const duration = Date.now() - startTime;
    storyboardLogStore.updateLog(logId, {
      status: 'completed',
      storyboard: storyboardWithImages,
      generatedShots: storyboardWithImages.length,
      duration,
    });

    log('storyboard_generate_success', { shots: storyboardWithImages.length, style, requestedShots: shotCount, storyboardLogId: logId });

    res.json({ storyboard: storyboardWithImages });
  } catch (error) {
    console.error('Error generating storyboard:', error);
    const duration = Date.now() - startTime;
    storyboardLogStore.updateLog(logId, {
      status: 'error',
      errorMessage: error.message,
      duration,
    });
    log('storyboard_generate_error', { message: error.message, storyboardLogId: logId });
    res.status(500).json({ error: 'Failed to generate storyboard' });
  }
};

exports.generateVideoFromStoryboard = async (req, res) => {
  const { storyboard } = req.body;

  if (!storyboard || !Array.isArray(storyboard) || storyboard.length === 0) {
    return res.status(400).json({ error: 'Valid storyboard is required' });
  }

  try {
    log('generate_video_from_storyboard_start', { shots: storyboard.length });
    
    // Use the new full video generation logic (Interpolation Chain)
    // This replaces the old planSegments + generateSequencedVideo flow
    const videoUrl = await videoService.generateFullVideoFromShots(storyboard);
    
    log('generate_video_from_storyboard_success', { shots: storyboard.length, videoUrl });
    res.json({ videoUrl });
  } catch (error) {
    console.error('Error generating video:', error);
    res.status(500).json({ error: error.message || 'Failed to generate video' });
  }
};

// Deprecated/Legacy endpoints - can be removed or stubbed
exports.planChunks = async (req, res) => {
    res.status(410).json({ error: "Endpoint deprecated. Auto-planning is now internal." });
};

exports.generateVideosForSegments = async (req, res) => {
     res.status(410).json({ error: "Endpoint deprecated. Use generateVideoFromStoryboard." });
};

exports.stitchVideos = async (req, res) => {
    // Keep stitch endpoint if frontend uses it separately, otherwise deprecate
  const { videoUrls } = req.body;
  if (!Array.isArray(videoUrls) || videoUrls.length === 0) {
    return res.status(400).json({ error: 'videoUrls array is required' });
  }
  try {
    const stitchedUrl = await videoService.stitchVideos(videoUrls);
    log('stitch_request', { parts: videoUrls.length, stitchedUrl });
    res.json({ stitchedUrl });
  } catch (error) {
    console.error('Error stitching videos:', error);
    res.status(500).json({ error: error.message || 'Failed to stitch videos' });
  }
};

exports.regenerateShotImage = async (req, res) => {
  const { shot, style, referenceImageBase64, heroSubject, previousStyleHint } = req.body;

  if (!shot || !shot.prompt) {
    return res.status(400).json({ error: 'Shot with prompt is required' });
  }

  try {
    const imageUrl = await imageGenService.generateImage(
      shot.prompt,
      previousStyleHint || '',
      style || '',
      referenceImageBase64 || null,
      heroSubject || ''
    );

    res.json({ imageUrl });
  } catch (error) {
    console.error('Error regenerating shot image:', error);
    res.status(500).json({ error: 'Failed to regenerate image' });
  }
};
