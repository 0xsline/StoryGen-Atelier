// Grok Imagine video generation (POST /v1/videos/generations + polling
// GET /v1/videos/{request_id}). Clips are generated image-to-video from the
// storyboard frame, optionally pinning the next frame as `last_frame` so each
// transition lands exactly on the following shot.
const grokClient = require('./grokClient');
const { log } = require('../utils/logger');

const MIN_DURATION = 1;
const MAX_DURATION = 15;
const DEFAULT_DURATION = 6;
const DEFAULT_RESOLUTION = '720p';
const DEFAULT_POLL_DELAY_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 120; // 10 minutes at the default poll interval

const toDataUri = (frame) => (
  frame && frame.bytesBase64Encoded
    ? `data:${frame.mimeType || 'image/png'};base64,${frame.bytesBase64Encoded}`
    : null
);

const normalizeDuration = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return DEFAULT_DURATION;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, parsed));
};

const buildRequestBody = ({ prompt, firstFrame, lastFrame, durationSeconds }, env = process.env) => {
  const text = (prompt || '').trim();
  if (!text) throw new Error('A prompt is required for Grok video generation');

  const { videoModel } = grokClient.getConfig(env);
  const first = toDataUri(firstFrame);
  const last = toDataUri(lastFrame);
  return {
    model: videoModel,
    prompt: text,
    ...(first ? { image: { url: first } } : {}),
    ...(last ? { last_frame: { url: last } } : {}),
    duration: normalizeDuration(durationSeconds),
    aspect_ratio: (env.XAI_VIDEO_ASPECT_RATIO || '').trim() || '16:9',
    resolution: (env.XAI_VIDEO_RESOLUTION || '').trim() || DEFAULT_RESOLUTION,
    generate_audio: (env.XAI_VIDEO_GENERATE_AUDIO || '').trim().toLowerCase() !== 'false',
  };
};

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

const pollUntilDone = async (requestId, options) => {
  const { env, fetchImpl, pollDelayMs, maxAttempts } = options;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const json = await grokClient.request(`/videos/${encodeURIComponent(requestId)}`, {
      method: 'GET',
      env,
      fetchImpl,
    });
    const status = String(json?.status || '').toLowerCase();

    if (status === 'done' || status === 'completed' || status === 'succeeded') {
      const url = json?.video?.url;
      if (!url) throw new Error('Grok video job finished but returned no video URL');
      return url;
    }
    if (status === 'failed' || status === 'expired' || status === 'cancelled') {
      const message = json?.error?.message || json?.video?.error || status;
      throw new Error(`Grok video generation ${status}: ${message}`);
    }
    await sleep(pollDelayMs);
  }
  throw new Error('Grok video generation timed out');
};

// Start a video job and wait for the download URL.
const generateVideo = async (params, options = {}) => {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl;
  const pollDelayMs = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const body = buildRequestBody(params, env);
  log('grok_video_create_request', {
    model: body.model,
    duration: body.duration,
    resolution: body.resolution,
    hasLastFrame: Boolean(body.last_frame),
  });

  const started = await grokClient.request('/videos/generations', {
    method: 'POST',
    env,
    fetchImpl,
    body: JSON.stringify(body),
  });

  const requestId = started?.request_id || started?.id;
  if (!requestId) throw new Error('Grok did not return a video request_id');
  log('grok_video_task_started', { requestId });

  return await pollUntilDone(requestId, { env, fetchImpl, pollDelayMs, maxAttempts });
};

module.exports = {
  buildRequestBody,
  generateVideo,
  normalizeDuration,
};
