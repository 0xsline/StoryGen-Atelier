const test = require('node:test');
const assert = require('node:assert/strict');
const grokTextService = require('../src/services/grokTextService');
const llmService = require('../src/services/llmService');

const restoreEnv = (name, value) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

test('sends text prompts to the Responses API and returns output text', async () => {
  let request;
  const output = await grokTextService.generateContent(
    [{ text: 'Return a JSON array.' }, { text: 'Second part.' }],
    {
      env: { XAI_API_KEY: 'xai-test', XAI_TEXT_MODEL: 'grok-4.5' },
      fetchImpl: async (url, options) => {
        request = { url, options };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'completed',
            output: [
              { type: 'reasoning', summary: [] },
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[]' }] },
            ],
          }),
        };
      },
    }
  );

  assert.equal(request.url, 'https://api.x.ai/v1/responses');
  assert.equal(request.options.headers.Authorization, 'Bearer xai-test');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'grok-4.5');
  assert.equal(body.store, false);
  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Return a JSON array.' },
        { type: 'input_text', text: 'Second part.' },
      ],
    },
  ]);
  assert.equal(output, '[]');
});

test('encodes inline images as input_image data URIs', async () => {
  let body;
  const output = await grokTextService.generateContent(
    [
      { text: 'Compare these frames.' },
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ],
    {
      env: { XAI_API_KEY: 'xai-test' },
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ output_text: '{"duration":6}', output: [] }),
        };
      },
    }
  );

  assert.deepEqual(body.input[0].content, [
    { type: 'input_text', text: 'Compare these frames.' },
    { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=', detail: 'high' },
  ]);
  assert.equal(output, '{"duration":6}');
});

test('rejects when the response carries an error or no text', async () => {
  await assert.rejects(
    grokTextService.generateContent([{ text: 'x' }], {
      env: { XAI_API_KEY: 'xai-test' },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: { message: 'boom' } }) }),
    }),
    /boom/
  );
  await assert.rejects(
    grokTextService.generateContent([{ text: 'x' }], {
      env: { XAI_API_KEY: 'xai-test' },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ output: [] }) }),
    }),
    /no output text/i
  );
});

test('reports the configured Grok text model when LLM_PROVIDER=grok', () => {
  const previousModel = process.env.XAI_TEXT_MODEL;
  const previousProvider = process.env.LLM_PROVIDER;
  try {
    process.env.LLM_PROVIDER = 'grok';
    process.env.XAI_TEXT_MODEL = 'grok-4.5';
    assert.equal(llmService.getConfiguredTextModel('gemini-fallback'), 'grok-4.5');
    delete process.env.XAI_TEXT_MODEL;
    assert.equal(llmService.getConfiguredTextModel('gemini-fallback'), 'grok-4.6');
    process.env.LLM_PROVIDER = 'grok-cli';
    assert.equal(llmService.getConfiguredTextModel('gemini-fallback'), 'grok-build');
    process.env.LLM_PROVIDER = '';
    assert.equal(llmService.getConfiguredTextModel('gemini-fallback'), 'gemini-fallback');
  } finally {
    restoreEnv('XAI_TEXT_MODEL', previousModel);
    restoreEnv('LLM_PROVIDER', previousProvider);
  }
});
