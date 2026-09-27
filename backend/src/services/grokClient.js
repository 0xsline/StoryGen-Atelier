// Shared xAI (Grok) API client: config, key detection, and an authenticated
// JSON request helper. Every Grok service (text, image, video) goes through
// here so credentials and base URL live in one place.
const { fetch } = require('undici');

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_TEXT_MODEL = 'grok-4.6';
const DEFAULT_IMAGE_MODEL = 'grok-imagine-image-2.0';
const DEFAULT_VIDEO_MODEL = 'grok-imagine-video-1.5';

const clean = (value) => (value || '').trim();

const getConfig = (env = process.env) => ({
  apiKey: clean(env.XAI_API_KEY),
  baseUrl: (clean(env.XAI_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  textModel: clean(env.XAI_TEXT_MODEL) || DEFAULT_TEXT_MODEL,
  imageModel: clean(env.XAI_IMAGE_MODEL) || DEFAULT_IMAGE_MODEL,
  videoModel: clean(env.XAI_VIDEO_MODEL) || DEFAULT_VIDEO_MODEL,
});

const hasApiKey = (env = process.env) => {
  const { apiKey } = getConfig(env);
  return apiKey !== '' && !apiKey.startsWith('your_');
};

// Perform a JSON request against the xAI API. `pathSuffix` is appended to the
// configured base URL. Throws on missing key, non-2xx status, or a JSON body
// carrying an `error` object.
const request = async (pathSuffix, options = {}) => {
  const { env = process.env, fetchImpl = fetch, headers = {}, ...rest } = options;
  const { apiKey, baseUrl } = getConfig(env);
  if (!hasApiKey(env)) {
    throw new Error('XAI_API_KEY is required for Grok requests');
  }

  const res = await fetchImpl(`${baseUrl}${pathSuffix}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!res.ok) {
    const text = typeof res.text === 'function' ? (await res.text()).slice(0, 500) : '';
    throw new Error(`Grok request failed (${pathSuffix}): ${res.status} ${text}`);
  }

  const json = await res.json();
  if (json && json.error) {
    const message = typeof json.error === 'string' ? json.error : json.error.message || JSON.stringify(json.error);
    throw new Error(`Grok request failed (${pathSuffix}): ${message}`);
  }
  return json;
};

// Wrap a bare base64 payload in a data URI, sniffing the real image type
// (callers often strip the header and guess PNG for JPEG bytes).
const toImageDataUri = (base64OrDataUri) => {
  if (!base64OrDataUri) return null;
  if (base64OrDataUri.startsWith('data:')) return base64OrDataUri;
  const head = Buffer.from(base64OrDataUri.slice(0, 32), 'base64');
  let mime = 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) mime = 'image/jpeg';
  else if (head.subarray(0, 4).toString('ascii') === 'RIFF') mime = 'image/webp';
  else if (head.subarray(0, 4).toString('ascii') === 'GIF8') mime = 'image/gif';
  return `data:${mime};base64,${base64OrDataUri}`;
};

module.exports = {
  DEFAULT_BASE_URL,
  toImageDataUri,
  DEFAULT_TEXT_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  getConfig,
  hasApiKey,
  request,
};
