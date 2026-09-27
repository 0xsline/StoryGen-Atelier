const test = require('node:test');
const assert = require('node:assert/strict');
const grokVideoService = require('../src/services/grokVideoService');

const frame = (data) => ({ bytesBase64Encoded: data, mimeType: 'image/png' });

test('builds an image-to-video request with first and last frames', () => {
  const body = grokVideoService.buildRequestBody(
    { prompt: 'slow dolly in', firstFrame: frame('QQ=='), lastFrame: frame('Qg=='), durationSeconds: 6 },
    { XAI_VIDEO_RESOLUTION: '1080p' }
  );
  assert.deepEqual(body, {
    model: 'grok-imagine-video-1.5',
    prompt: 'slow dolly in',
    image: { url: 'data:image/png;base64,QQ==' },
    last_frame: { url: 'data:image/png;base64,Qg==' },
    duration: 6,
    aspect_ratio: '16:9',
    resolution: '1080p',
    generate_audio: true,
  });
});

test('omits last_frame for closing shots, clamps duration, and defaults resolution', () => {
  const body = grokVideoService.buildRequestBody(
    { prompt: 'hold', firstFrame: frame('QQ=='), lastFrame: null, durationSeconds: 40 },
    { XAI_VIDEO_GENERATE_AUDIO: 'false' }
  );
  assert.equal(body.last_frame, undefined);
  assert.equal(body.duration, 15);
  assert.equal(body.resolution, '720p');
  assert.equal(body.generate_audio, false);
  assert.throws(() => grokVideoService.buildRequestBody({ prompt: '  ', firstFrame: frame('QQ==') }, {}), /prompt/i);
});

test('starts a job, polls until done, and returns the video URL', async () => {
  const calls = [];
  let polls = 0;
  const url = await grokVideoService.generateVideo(
    { prompt: 'pan right', firstFrame: frame('QQ=='), lastFrame: frame('Qg=='), durationSeconds: 4 },
    {
      env: { XAI_API_KEY: 'xai-test' },
      pollDelayMs: 0,
      fetchImpl: async (reqUrl, options) => {
        calls.push({ url: reqUrl, method: options.method });
        if (options.method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ request_id: 'req_123', status: 'pending' }) };
        }
        polls += 1;
        if (polls < 3) return { ok: true, status: 200, json: async () => ({ request_id: 'req_123', status: 'pending' }) };
        return { ok: true, status: 200, json: async () => ({ status: 'done', video: { url: 'https://vidgen.x.ai/clip.mp4', duration: 4 } }) };
      },
    }
  );

  assert.equal(url, 'https://vidgen.x.ai/clip.mp4');
  assert.equal(calls[0].url, 'https://api.x.ai/v1/videos/generations');
  assert.equal(calls[1].url, 'https://api.x.ai/v1/videos/req_123');
  assert.equal(calls[1].method, 'GET');
  assert.equal(polls, 3);
});

test('rejects when the job fails or times out', async () => {
  await assert.rejects(
    grokVideoService.generateVideo(
      { prompt: 'x', firstFrame: frame('QQ=='), durationSeconds: 4 },
      {
        env: { XAI_API_KEY: 'xai-test' },
        pollDelayMs: 0,
        fetchImpl: async (_url, options) => (options.method === 'POST'
          ? { ok: true, status: 200, json: async () => ({ request_id: 'r' }) }
          : { ok: true, status: 200, json: async () => ({ status: 'failed', error: { message: 'moderated' } }) }),
      }
    ),
    /moderated/
  );
  await assert.rejects(
    grokVideoService.generateVideo(
      { prompt: 'x', firstFrame: frame('QQ=='), durationSeconds: 4 },
      {
        env: { XAI_API_KEY: 'xai-test' },
        pollDelayMs: 0,
        maxAttempts: 2,
        fetchImpl: async (_url, options) => (options.method === 'POST'
          ? { ok: true, status: 200, json: async () => ({ request_id: 'r' }) }
          : { ok: true, status: 200, json: async () => ({ status: 'pending' }) }),
      }
    ),
    /timed out/i
  );
});
