const { fetch } = require('undici');

const REGION_BASE_URLS = Object.freeze({
  global_en: 'https://api.minimax.io/v1',
  cn_zh: 'https://api.minimaxi.com/v1',
});

const DEFAULT_MODEL = 'MiniMax-M3';

const normalizeBaseUrl = (value) => value.replace(/\/+$/, '');

const getConfig = (env = process.env) => {
  const region = (env.MINIMAX_API_REGION || 'global_en').trim();
  const configuredBaseUrl = (env.MINIMAX_TEXT_BASE_URL || '').trim();
  const configuredModel = (env.MINIMAX_TEXT_MODEL || '').trim();
  const baseUrl = configuredBaseUrl || REGION_BASE_URLS[region] || REGION_BASE_URLS.global_en;

  return {
    apiKey: (env.MINIMAX_API_KEY || '').trim(),
    baseUrl: normalizeBaseUrl(baseUrl),
    model: configuredModel || DEFAULT_MODEL,
  };
};

const hasApiKey = (env = process.env) => {
  const { apiKey } = getConfig(env);
  return apiKey !== '' && !apiKey.startsWith('your_');
};

const getModel = (env = process.env) => getConfig(env).model;

const buildThinkingParam = (env = process.env) => {
  const value = (env.MINIMAX_TEXT_THINKING || '').trim().toLowerCase();
  return value === 'disabled' || value === 'adaptive' ? { thinking: { type: value } } : {};
};

const toMessageContent = (promptParts) => {
  const content = promptParts.map((part) => {
    if (typeof part?.text === 'string') {
      return { type: 'text', text: part.text };
    }

    if (part?.inlineData?.data) {
      const mimeType = part.inlineData.mimeType || 'image/jpeg';
      return {
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${part.inlineData.data}`,
        },
      };
    }

    throw new Error('Unsupported MiniMax prompt part');
  });

  if (content.every((part) => part.type === 'text')) {
    return content.map((part) => part.text).join('\n\n');
  }

  return content;
};

const responseContentToText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .join('')
    .trim();
};

const generateContent = async (promptParts, options = {}) => {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const { apiKey, baseUrl, model } = getConfig(env);

  if (!hasApiKey(env)) {
    throw new Error('MINIMAX_API_KEY is required for MiniMax text generation');
  }

  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: toMessageContent(promptParts),
        },
      ],
      stream: false,
      // M3 defaults to adaptive thinking; set MINIMAX_TEXT_THINKING=disabled to
      // skip reasoning for structured-JSON calls. Omitted for M2.x, which cannot
      // disable thinking (llmService strips inline <think> blocks instead).
      ...buildThinkingParam(env),
    }),
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    throw new Error(`MiniMax text request failed: ${response.status} ${details}`);
  }

  const json = await response.json();
  if (json.base_resp && json.base_resp.status_code !== 0) {
    throw new Error(`MiniMax text request failed: ${json.base_resp.status_code} ${json.base_resp.status_msg || ''}`);
  }
  if (json.error) {
    throw new Error(`MiniMax text request failed: ${json.error.message || JSON.stringify(json.error)}`);
  }

  const text = responseContentToText(json?.choices?.[0]?.message?.content);
  if (!text) {
    throw new Error('MiniMax text response did not include message content');
  }

  return text;
};

module.exports = {
  REGION_BASE_URLS,
  generateContent,
  getConfig,
  getModel,
  hasApiKey,
};
