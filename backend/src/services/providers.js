// Shared provider-selection helpers so the text, image and video services
// agree on names and aliases.
//   ''          -> upstream default (Gemini / Vertex, or MiniMax auto-detect where applicable)
//   'minimax'   -> MiniMax
//   'grok'      -> xAI API (alias: 'xai')
//   'grok-cli'  -> Grok Build CLI (alias: 'grok_cli')
const ALIASES = { xai: 'grok', grok_cli: 'grok-cli' };

const normalizeProvider = (value) => {
  const key = (value || '').trim().toLowerCase();
  return ALIASES[key] || key;
};

// True when the key is set and is not the .env.example placeholder.
const hasValidApiKey = (apiKey) => Boolean(apiKey && apiKey.trim() !== '' && !apiKey.trim().startsWith('your_'));

module.exports = { normalizeProvider, hasValidApiKey };
