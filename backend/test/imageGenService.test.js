const test = require('node:test');
const assert = require('node:assert/strict');
const imageGenService = require('../src/services/imageGenService');

test('returns a placeholder when no API key is configured', async () => {
  const url = await imageGenService.generateImage('a quiet lake', '', '', null, '', { env: { IMAGE_PROVIDER: 'grok' } });
  assert.match(url, /^https:\/\/placehold\.co\//);
  const cliUrl = await imageGenService.generateImage('a quiet lake', '', '', null, '', { env: { IMAGE_PROVIDER: 'grok-cli', GROK_CLI_BIN: '/nope/grok' } });
  assert.match(cliUrl, /^https:\/\/placehold\.co\//);
});

test('routes IMAGE_PROVIDER=grok-cli through the Grok Build CLI', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-cli-'));
  const out = path.join(workDir, 'images', '1.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from('iVBORw0KGgo=', 'base64'));
  let args;
  const url = await imageGenService.generateImage('a quiet lake', '', 'Watercolor', null, '', {
    env: { IMAGE_PROVIDER: 'grok-cli', GROK_CLI_BIN: process.execPath, GROK_CLI_WORKDIR: workDir },
    execImpl: async (_bin, a) => { args = a; return { code: 0, stdout: JSON.stringify({ structuredOutput: { path: out } }), stderr: '' }; },
  });
  assert.equal(url, 'data:image/png;base64,iVBORw0KGgo=');
  assert.match(args[args.indexOf('-p') + 1], /Watercolor/);
});

test('generates a frame with Grok Imagine and returns a data URI', async () => {
  let request;
  const url = await imageGenService.generateImage('a quiet lake', '', 'Watercolor', null, 'A red fox', {
    env: { IMAGE_PROVIDER: 'grok', XAI_API_KEY: 'xai-test', XAI_IMAGE_RESOLUTION: '2k' },
    fetchImpl: async (reqUrl, options) => {
      request = { url: reqUrl, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'aW1hZ2U=' }] }) };
    },
  });

  assert.equal(request.url, 'https://api.x.ai/v1/images/generations');
  assert.equal(request.body.model, 'grok-imagine-image-2.0');
  assert.equal(request.body.aspect_ratio, '16:9');
  assert.equal(request.body.resolution, '2k');
  assert.equal(request.body.response_format, 'b64_json');
  assert.equal(request.body.n, 1);
  assert.match(request.body.prompt, /a quiet lake/);
  assert.match(request.body.prompt, /Watercolor/);
  assert.match(request.body.prompt, /A red fox/);
  assert.equal(url, 'data:image/jpeg;base64,aW1hZ2U=');
});

test('uses the edits endpoint with the reference frame for character consistency', async () => {
  let request;
  const url = await imageGenService.generateImage('the fox jumps', 'prev', '', 'cmVm', 'A red fox', {
    env: { IMAGE_PROVIDER: 'grok', XAI_API_KEY: 'xai-test' },
    fetchImpl: async (reqUrl, options) => {
      request = { url: reqUrl, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ data: [{ url: 'https://imgen.x.ai/out.png' }] }) };
    },
  });

  assert.equal(request.url, 'https://api.x.ai/v1/images/edits');
  assert.deepEqual(request.body.image, { type: 'image_url', url: 'data:image/png;base64,cmVm' });
  assert.match(request.body.prompt, /SAME character/);
  assert.equal(url, 'https://imgen.x.ai/out.png');
});

test('falls back to a placeholder when the API fails', async () => {
  const url = await imageGenService.generateImage('a quiet lake', '', '', null, '', {
    env: { IMAGE_PROVIDER: 'grok', XAI_API_KEY: 'xai-test' },
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'oops' }),
  });
  assert.match(url, /^https:\/\/placehold\.co\//);
});
