const { GoogleGenerativeAI } = require("@google/generative-ai");
const { fetch } = require("undici");
const grokClient = require('./grokClient');
const grokCliService = require('./grokCliService');
const { normalizeProvider } = require('./providers');

const BASE_IMAGE_STYLE = process.env.GEMINI_IMAGE_STYLE || "Cinematic neon-noir, teal-magenta palette, volumetric rain and fog, soft bloom, anamorphic lens, shallow depth of field, subtle film grain, 16:9 composition";

const buildImagePrompt = (prompt, previousStyleHint, styleOverride, heroSubject) => {
  const appliedStyle = styleOverride && styleOverride.trim() !== '' ? styleOverride.trim() : BASE_IMAGE_STYLE;

  // Build character consistency instruction
  const heroInstruction = heroSubject
    ? `CRITICAL - Main Character Description (MUST match exactly): ${heroSubject}.`
    : "";

  // Slightly tighten the prompt for visual fidelity and cross-shot consistency.
  const styleGlue = previousStyleHint
    ? `Maintain exact style continuity with previous shot: "${previousStyleHint}".`
    : "Establish the base look; following shots must keep this style.";

  return `
    Role: Cinematic frame artist.
    Goal: Render a single storyboard frame that matches the shared style and camera feel.
    ${heroInstruction}
    Style: ${appliedStyle}.
    Continuity: ${styleGlue}
    Frame description: ${prompt}.
    Constraints: no text, no captions, 16:9, high fidelity. The main character MUST look identical to the reference image if provided.
  `;
};

const placeholderImage = (prompt) => {
  const encodedPrompt = encodeURIComponent(prompt.substring(0, 50) + "...");
  return `https://placehold.co/600x400/222/FFF?text=${encodedPrompt}`;
};

// MiniMax text-to-image (image-01 / image-01-live) generation.
// Regional hosts: global (English) and CN (Chinese) OpenAPI roots.
const MINIMAX_REGION_HOSTS = {
  global_en: 'https://api.minimax.io/v1',
  cn_zh: 'https://api.minimaxi.com/v1',
};

const getMiniMaxBaseUrl = () => {
  const explicit = process.env.MINIMAX_IMAGE_API_HOST;
  if (explicit && explicit.trim() !== '') return explicit.trim().replace(/\/+$/, '');
  const region = (process.env.MINIMAX_API_REGION || 'global_en').trim();
  return MINIMAX_REGION_HOSTS[region] || MINIMAX_REGION_HOSTS.global_en;
};

// POST /v1/image_generation with Bearer auth. Returns the first generated
// image: a data URI when response_format=base64 (the frontend renders data
// URIs directly), or the image URL otherwise. Returns null when no API key
// is configured.
const generateImageWithMiniMax = async (prompt) => {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey.startsWith('your_')) {
    return null;
  }

  const model = process.env.MINIMAX_IMAGE_MODEL || 'image-01';
  const responseFormat = process.env.MINIMAX_IMAGE_RESPONSE_FORMAT || 'base64';
  const body = {
    model,
    prompt,
    aspect_ratio: '16:9',
    response_format: responseFormat,
    n: 1,
  };
  if (process.env.MINIMAX_PROMPT_OPTIMIZER === 'true') body.prompt_optimizer = true;

  const url = `${getMiniMaxBaseUrl()}/image_generation`;
  console.log('Generating image via MiniMax:', { model, responseFormat });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MiniMax image generation request failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  if (json.base_resp && json.base_resp.status_code !== 0) {
    throw new Error(`MiniMax image generation error: ${json.base_resp.status_code} ${json.base_resp.status_msg}`);
  }

  // MiniMax returns the two formats under different keys: data.image_base64
  // (raw base64 strings) for response_format=base64, data.image_urls (links
  // that expire after 24h) for response_format=url.
  const data = json?.data || {};
  const images = responseFormat === 'base64' ? data.image_base64 || [] : data.image_urls || [];
  if (images.length === 0) {
    const field = responseFormat === 'base64' ? 'image_base64' : 'image_urls';
    throw new Error(`MiniMax image generation returned no ${field}`);
  }

  const firstImage = images[0];
  if (responseFormat === 'base64') {
    // Wrap the raw JPEG payload in a data URI so the frontend can render it
    // directly (same contract as the existing provider path).
    return firstImage.startsWith('data:') ? firstImage : `data:image/jpeg;base64,${firstImage}`;
  }
  return firstImage;
};

// xAI Grok Imagine: text-to-image for the first frame, image-edits with the
// first frame as reference for later shots (keeps the hero consistent).
// Both endpoints answer { data: [{ url }] } or { data: [{ b64_json }] }.
const extractGrokImage = (json) => {
  const first = Array.isArray(json?.data) ? json.data[0] : null;
  if (!first) throw new Error('Grok image response contained no data');
  if (first.b64_json) {
    return first.b64_json.startsWith('data:') ? first.b64_json : `data:image/jpeg;base64,${first.b64_json}`;
  }
  if (first.url) return first.url;
  throw new Error('Grok image response contained neither b64_json nor url');
};

const generateImageWithGrok = async (imagePrompt, referenceImageBase64, { env, fetchImpl }) => {
  const { imageModel } = grokClient.getConfig(env);
  const common = {
    model: imageModel,
    aspect_ratio: '16:9',
    resolution: (env.XAI_IMAGE_RESOLUTION || '').trim() || '1k',
    response_format: 'b64_json',
    n: 1,
  };

  if (referenceImageBase64) {
    const body = {
      ...common,
      prompt: `Reference image shows the main character. Generate a new image where this SAME character (identical appearance, clothing, colors) performs the action described below:\n\n${imagePrompt}`,
      image: { type: 'image_url', url: grokClient.toImageDataUri(referenceImageBase64) },
    };
    return extractGrokImage(await grokClient.request('/images/edits', { method: 'POST', env, fetchImpl, body: JSON.stringify(body) }));
  }
  return extractGrokImage(await grokClient.request('/images/generations', {
    method: 'POST', env, fetchImpl, body: JSON.stringify({ ...common, prompt: imagePrompt }),
  }));
};

const getImageProvider = (env) => normalizeProvider(env.IMAGE_PROVIDER);

// Use Gemini 3 Pro Image Preview to generate frame-level artwork.
// referenceImageBase64: base64 string of the first shot image (for character consistency)
// heroSubject: detailed character description from shot 1
// options: { env, fetchImpl, execImpl } for tests.
exports.generateImage = async (prompt, previousStyleHint = "", styleOverride, referenceImageBase64 = null, heroSubject = "", options = {}) => {
  const env = options.env || process.env;
  const imagePrompt = buildImagePrompt(prompt, previousStyleHint, styleOverride, heroSubject);

  // Provider selection: IMAGE_PROVIDER = minimax | grok (xAI API) | grok-cli
  // (Grok Build). Leave it empty to auto-detect MiniMax when MINIMAX_API_KEY
  // is configured; otherwise the Gemini path below is used.
  const provider = getImageProvider(env);

  if (provider === 'grok') {
    if (!grokClient.hasApiKey(env)) {
      console.log('No valid XAI_API_KEY found. Using placeholder image.');
      return placeholderImage(prompt);
    }
    try {
      const imageUrl = await generateImageWithGrok(imagePrompt, referenceImageBase64, { env, fetchImpl: options.fetchImpl });
      console.log('Image generated successfully via Grok Imagine.');
      return imageUrl;
    } catch (error) {
      console.error('Error generating image with Grok Imagine:', error);
      console.log('Falling back to placeholder.');
      return placeholderImage(prompt);
    }
  }

  if (provider === 'grok-cli') {
    if (!grokCliService.isAvailable(env)) {
      console.log('Grok Build CLI not found. Using placeholder image.');
      return placeholderImage(prompt);
    }
    try {
      const imageUrl = await grokCliService.generateImage(
        { prompt: imagePrompt, referenceImage: referenceImageBase64 },
        { env, execImpl: options.execImpl }
      );
      console.log('Image generated successfully via Grok Build CLI.');
      return imageUrl;
    } catch (error) {
      console.error('Error generating image with Grok Build CLI:', error);
      console.log('Falling back to placeholder.');
      return placeholderImage(prompt);
    }
  }
  const useMiniMax = provider === 'minimax'
    || (provider === '' && env.MINIMAX_API_KEY && env.MINIMAX_API_KEY.trim() !== '');

  if (useMiniMax) {
    try {
      const imageUrl = await generateImageWithMiniMax(imagePrompt);
      if (imageUrl) {
        console.log('Image generated successfully via MiniMax.');
        return imageUrl;
      }
      console.log('No valid MINIMAX_API_KEY found. Using placeholder image.');
    } catch (error) {
      console.error('Error generating image with MiniMax:', error);
      console.log('Falling back to placeholder.');
    }
    return placeholderImage(prompt);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === "" || apiKey.startsWith("your_")) {
    console.log("No valid GEMINI_API_KEY found. Using placeholder image.");
    return placeholderImage(prompt);
  }

  const imageModel = process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image-preview";
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: imageModel });

  // Build content parts - include reference image if available
  const contentParts = [];
  if (referenceImageBase64) {
    contentParts.push({
      inlineData: {
        mimeType: "image/png",
        data: referenceImageBase64,
      },
    });
    contentParts.push({ text: "Reference image above shows the main character. Generate a new image where this SAME character (identical appearance, clothing, colors) performs the action described below:\n\n" + imagePrompt });
  } else {
    contentParts.push({ text: imagePrompt });
  }

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: contentParts,
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig:{
          aspectRatio: "16:9"
        }
      },
    });

    const candidates = result?.response?.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const mimeType = part.inlineData.mimeType || "image/png";
          const base64 = part.inlineData.data;
          console.log("Image generated successfully via Gemini.");
          // Return a data URL so the frontend can render directly.
          return `data:${mimeType};base64,${base64}`;
        }
      }
    }

    console.log("Gemini did not return inline image data; using placeholder.");
  } catch (error) {
    console.error("Error generating image with Gemini:", error);
    console.log("Falling back to placeholder.");
  }

  // Fallback Placeholder
  return placeholderImage(prompt);
};
