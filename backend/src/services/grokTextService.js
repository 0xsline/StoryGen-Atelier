// Grok text generation via the xAI Responses API (POST /v1/responses).
// Accepts the same prompt-part shape the storyboard prompts are built with:
// { text } for text and { inlineData: { mimeType, data } } for base64 images.
const grokClient = require('./grokClient');

const toInputContent = (promptParts) => promptParts.map((part) => {
  if (typeof part?.text === 'string') {
    return { type: 'input_text', text: part.text };
  }
  if (part?.inlineData?.data) {
    const mimeType = part.inlineData.mimeType || 'image/jpeg';
    return {
      type: 'input_image',
      image_url: `data:${mimeType};base64,${part.inlineData.data}`,
      detail: 'high',
    };
  }
  throw new Error('Unsupported Grok prompt part');
});

// The Responses API returns output as a list of items; assistant text lives in
// items of type "message" under content[].type === "output_text". Some SDK
// shapes also surface a convenience `output_text` string, so accept both.
const extractOutputText = (json) => {
  if (typeof json?.output_text === 'string' && json.output_text.trim() !== '') {
    return json.output_text.trim();
  }
  const output = Array.isArray(json?.output) ? json.output : [];
  const text = output
    .filter((item) => item && item.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part && (part.type === 'output_text' || typeof part.text === 'string'))
    .map((part) => part.text || '')
    .join('')
    .trim();
  return text;
};

const generateContent = async (promptParts, options = {}) => {
  const env = options.env || process.env;
  const { textModel } = grokClient.getConfig(env);

  const json = await grokClient.request('/responses', {
    method: 'POST',
    env,
    fetchImpl: options.fetchImpl,
    body: JSON.stringify({
      model: textModel,
      input: [{ role: 'user', content: toInputContent(promptParts) }],
      // Requests carry inline frame images; xAI advises against server-side
      // history storage when sending images.
      store: false,
    }),
  });

  if (json?.status === 'failed' || json?.status === 'incomplete') {
    const reason = json?.incomplete_details?.reason || json?.status;
    throw new Error(`Grok text response ${reason}`);
  }

  const text = extractOutputText(json);
  if (!text) {
    throw new Error('Grok text response contained no output text');
  }
  return text;
};

const getModel = (env = process.env) => grokClient.getConfig(env).textModel;

module.exports = {
  generateContent,
  extractOutputText,
  getModel,
  hasApiKey: grokClient.hasApiKey,
};
