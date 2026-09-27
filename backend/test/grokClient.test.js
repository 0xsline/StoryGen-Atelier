const test = require('node:test');
const assert = require('node:assert/strict');
const grokClient = require('../src/services/grokClient');

test('resolves base URL and models from env with defaults', () => {
  const cfg = grokClient.getConfig({});
  assert.equal(cfg.baseUrl, 'https://api.x.ai/v1');
  assert.equal(cfg.textModel, 'grok-4.6');
  assert.equal(cfg.imageModel, 'grok-imagine-image-2.0');
  assert.equal(cfg.videoModel, 'grok-imagine-video-1.5');

  const custom = grokClient.getConfig({
    XAI_BASE_URL: 'https://proxy.test/v1/',
    XAI_TEXT_MODEL: 'grok-4.5',
    XAI_IMAGE_MODEL: 'grok-imagine-image',
    XAI_VIDEO_MODEL: 'grok-imagine-video',
  });
  assert.equal(custom.baseUrl, 'https://proxy.test/v1');
  assert.equal(custom.textModel, 'grok-4.5');
  assert.equal(custom.imageModel, 'grok-imagine-image');
  assert.equal(custom.videoModel, 'grok-imagine-video');
});

test('detects a usable API key', () => {
  assert.equal(grokClient.hasApiKey({}), false);
  assert.equal(grokClient.hasApiKey({ XAI_API_KEY: '   ' }), false);
  assert.equal(grokClient.hasApiKey({ XAI_API_KEY: 'your_xai_api_key_here' }), false);
  assert.equal(grokClient.hasApiKey({ XAI_API_KEY: 'xai-abc' }), true);
});

test('request adds bearer auth and surfaces HTTP errors', async () => {
  let captured;
  const json = await grokClient.request('/images/generations', {
    method: 'POST',
    body: JSON.stringify({ a: 1 }),
    env: { XAI_API_KEY: 'xai-test' },
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.deepEqual(json, { ok: true });
  assert.equal(captured.url, 'https://api.x.ai/v1/images/generations');
  assert.equal(captured.options.headers.Authorization, 'Bearer xai-test');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');

  await assert.rejects(
    grokClient.request('/videos/generations', {
      method: 'POST',
      env: { XAI_API_KEY: 'xai-test' },
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad key' }),
    }),
    /401 bad key/
  );

  await assert.rejects(
    grokClient.request('/responses', { method: 'POST', env: {}, fetchImpl: async () => ({}) }),
    /XAI_API_KEY/
  );
});
