const test = require('node:test');
const assert = require('node:assert/strict');
const miniMaxTextService = require('../src/services/minimaxTextService');
const llmService = require('../src/services/llmService');

const restoreEnv = (name, value) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

test('selects MiniMax regional endpoints', () => {
  assert.equal(
    miniMaxTextService.getConfig({ MINIMAX_API_REGION: 'global_en' }).baseUrl,
    'https://api.minimax.io/v1'
  );
  assert.equal(
    miniMaxTextService.getConfig({ MINIMAX_API_REGION: 'cn_zh' }).baseUrl,
    'https://api.minimaxi.com/v1'
  );
  assert.equal(
    miniMaxTextService.getConfig({ MINIMAX_TEXT_BASE_URL: 'https://example.test/v1/' }).baseUrl,
    'https://example.test/v1'
  );
  assert.equal(
    miniMaxTextService.getConfig({ MINIMAX_TEXT_MODEL: '   ' }).model,
    'MiniMax-M3'
  );
});

test('sends MiniMax text completions to the configured region', async () => {
  let request;
  const output = await miniMaxTextService.generateContent(
    [{ text: 'Return a JSON array.' }],
    {
      env: {
        MINIMAX_API_KEY: 'test-key',
        MINIMAX_API_REGION: 'cn_zh',
      },
      fetchImpl: async (url, options) => {
        request = { url, options };
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '[]' } }] }),
        };
      },
    }
  );

  assert.equal(request.url, 'https://api.minimaxi.com/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'MiniMax-M3',
    messages: [{ role: 'user', content: 'Return a JSON array.' }],
    stream: false,
  });
  assert.equal(output, '[]');
});

test('encodes image prompt parts for MiniMax multimodal input', async () => {
  let requestBody;
  const output = await miniMaxTextService.generateContent(
    [
      { text: 'Compare these frames.' },
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ],
    {
      env: { MINIMAX_API_KEY: 'test-key' },
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: [{ type: 'text', text: '{"duration":6}' }] } }],
          }),
        };
      },
    }
  );

  assert.deepEqual(requestBody.messages[0].content, [
    { type: 'text', text: 'Compare these frames.' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
    },
  ]);
  assert.equal(output, '{"duration":6}');
});

test('reports the configured MiniMax text model', () => {
  const previousProvider = process.env.LLM_PROVIDER;
  const previousModel = process.env.MINIMAX_TEXT_MODEL;

  try {
    process.env.LLM_PROVIDER = 'minimax';
    process.env.MINIMAX_TEXT_MODEL = 'MiniMax-M3';
    assert.equal(llmService.getConfiguredTextModel('fallback'), 'MiniMax-M3');
  } finally {
    restoreEnv('LLM_PROVIDER', previousProvider);
    restoreEnv('MINIMAX_TEXT_MODEL', previousModel);
  }
});
