// Grok Build CLI provider. Drives the locally installed `grok` binary in
// headless mode so text, image, and video generation run through the user's
// Grok Build session (SuperGrok / X Premium+) instead of a raw API key.
//
//   text  : `grok --prompt-file <prompt.txt> --tools read_file` (images are
//           written to disk and the agent reads them; inline base64 in argv
//           trips the 128 KB per-argument limit, spawn E2BIG)
//   image : `grok -p "<instruction>" --tools image_gen,image_edit`
//   video : `grok -p "<instruction>" --tools image_to_video,reference_to_video`
// (No --json-schema: structured output constrains the first reply to JSON,
// which stops the agent from calling the tool at all.)
//
// Every call is a fresh headless session with --always-approve, a tool
// allowlist, and a bounded --max-turns, so the agent can only do the one
// Imagine call we ask for. Generated files land in a per-app work dir that
// the caller reads back.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { log } = require('../utils/logger');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_WORKDIR = path.join(__dirname, '../../data/grok-cli');

const clean = (value) => (value || '').trim();

const getConfig = (env = process.env) => ({
  binary: clean(env.GROK_CLI_BIN) || 'grok',
  model: clean(env.GROK_CLI_MODEL),
  workDir: path.resolve(clean(env.GROK_CLI_WORKDIR) || DEFAULT_WORKDIR),
  timeoutMs: Number.parseInt(env.GROK_CLI_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
  imageAspectRatio: clean(env.GROK_CLI_IMAGE_ASPECT_RATIO) || '16:9',
  videoResolution: clean(env.GROK_CLI_VIDEO_RESOLUTION) || '720p',
  videoAspectRatio: clean(env.GROK_CLI_VIDEO_ASPECT_RATIO) || '16:9',
  maxParallel: Math.max(1, Number.parseInt(env.GROK_CLI_MAX_PARALLEL, 10) || 4),
});

// Simple semaphore so a 12-shot storyboard does not spawn 12 grok processes
// at once (each one is a full agent session hitting the Imagine API).
let inFlight = 0;
const waiters = [];
const acquire = (limit) => new Promise((resolve) => {
  const tryAcquire = () => {
    if (inFlight < limit) { inFlight += 1; resolve(); return true; }
    return false;
  };
  if (!tryAcquire()) waiters.push(tryAcquire);
});
const release = () => {
  inFlight -= 1;
  while (waiters.length && waiters[0]()) waiters.shift();
};

// Resolve the binary: an explicit GROK_CLI_BIN path, or `grok` on PATH.
const WINDOWS_EXTS = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
const resolveBinary = (env = process.env) => {
  const { binary } = getConfig(env);
  if (/[\\/]/.test(binary)) return fs.existsSync(binary) ? binary : null;
  const searchPath = env.PATH || process.env.PATH || '';
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of WINDOWS_EXTS) {
      const candidate = path.join(dir, binary + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
};

const isAvailable = (env = process.env) => resolveBinary(env) !== null;

const defaultExec = (bin, args, options) => new Promise((resolve) => {
  execFile(bin, args, options, (error, stdout, stderr) => {
    let code = 0;
    let failure = null;
    if (error) {
      code = typeof error.code === 'number' ? error.code : 1;
      // Timeout kills report killed=true with a null code; spawn failures
      // (ENOENT, E2BIG, EACCES) carry a string code. Keep that context.
      if (error.killed) failure = `killed by ${error.signal || 'timeout'} after ${options.timeout || 0} ms`;
      else if (typeof error.code === 'string') failure = `${error.code}: ${error.message}`;
    }
    resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || ''), failure });
  });
});

const parseHeadlessOutput = (stdout) => {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // The CLI may print an error event before the final object; use the last JSON line.
    const lines = trimmed.split('\n').filter((l) => l.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch (_e) { /* keep looking */ }
    }
    return null;
  }
};

// Run one headless grok invocation and return the parsed JSON result object.
const runGrok = async (args, options = {}) => {
  const env = options.env || process.env;
  const execImpl = options.execImpl || defaultExec;
  const cfg = getConfig(env);
  const bin = resolveBinary(env);
  if (!bin) throw new Error(`Grok Build CLI not found (looked for "${cfg.binary}"). Install it: curl -fsSL https://x.ai/cli/install.sh | bash`);

  fs.mkdirSync(cfg.workDir, { recursive: true });
  const fullArgs = [...args, '--output-format', 'json', '--no-auto-update', '--cwd', cfg.workDir];
  if (cfg.model) fullArgs.push('--model', cfg.model);

  log('grok_cli_exec', { bin, args: fullArgs.filter((a) => a.length < 120) });
  await acquire(cfg.maxParallel);
  let code; let stdout; let stderr; let failure;
  try {
    ({ code, stdout, stderr, failure } = await execImpl(bin, fullArgs, {
      cwd: cfg.workDir,
      env: { ...process.env, ...env },
      timeout: cfg.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } finally {
    release();
  }

  const parsed = parseHeadlessOutput(stdout);
  if (parsed && parsed.type === 'error') {
    throw new Error(`Grok CLI error: ${parsed.message || 'unknown error'}`);
  }
  if (failure) throw new Error(`Grok CLI failed to run: ${failure}`);
  if (code !== 0) {
    const detail = (stderr || stdout || '').trim().split('\n').slice(-3).join(' ');
    throw new Error(`Grok CLI exited with code ${code}: ${detail}`);
  }
  if (!parsed) throw new Error('Grok CLI returned no JSON output');
  return parsed;
};

// ---------- text ----------

const toAcpBlocks = (promptParts) => promptParts.map((part) => {
  if (typeof part?.text === 'string') return { type: 'text', text: part.text };
  if (part?.inlineData?.data) {
    return { type: 'image', data: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/jpeg' };
  }
  throw new Error('Unsupported Grok CLI prompt part');
});

// The headless `text` field concatenates every assistant message of the run,
// so a tool-using turn can prepend narration ("I'll read both frames first")
// to the JSON answer. Return the longest embedded JSON value, so an object is
// not mistaken for its inner array and bracketed narration ("[image 1]") is skipped.
const matchBracket = (s, start) => {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth += 1;
    else if ((c === ']' || c === '}') && --depth === 0) return i;
  }
  return -1;
};

const stripToJson = (text) => {
  const trimmed = String(text || '').trim();
  try { JSON.parse(trimmed); return trimmed; } catch (_) { /* fall through */ }
  const cleaned = trimmed.replace(/```json/gi, '').replace(/```/g, '');
  let best = null;
  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '[' && cleaned[start] !== '{') continue;
    const end = matchBracket(cleaned, start);
    if (end === -1) continue;
    const candidate = cleaned.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      if (!best || candidate.length > best.length) best = candidate;
      start = end; // values nested inside this one are shorter
    } catch (_) { /* not JSON; try the next bracket */ }
  }
  return best || trimmed;
};

// Build a plain-text prompt: text parts verbatim, image parts saved to disk
// and referenced by path for the agent's read_file tool.
const buildTextPrompt = (promptParts, workDir) => {
  const files = [];
  const body = promptParts.map((part) => {
    if (typeof part?.text === 'string') return part.text;
    if (part?.inlineData?.data) {
      const file = writeFrameFile(workDir, 'prompt', {
        bytesBase64Encoded: part.inlineData.data, mimeType: part.inlineData.mimeType,
      });
      files.push(file);
      return `[Attached image file: ${file}]`;
    }
    throw new Error('Unsupported Grok CLI prompt part');
  }).join('\n\n');

  const preamble = files.length
    ? `${files.length} image file(s) are attached below by absolute path. Before answering, read EVERY one of them with the read_file tool so you can see the pictures. Do not narrate what you are doing; after reading, output only the requested answer.\n\n`
    : 'Output only the requested answer, with no narration.\n\n';
  return { prompt: preamble + body, files };
};

const generateText = async (promptParts, options = {}) => {
  const env = options.env || process.env;
  const cfg = getConfig(env);
  fs.mkdirSync(cfg.workDir, { recursive: true });
  const { prompt, files } = buildTextPrompt(promptParts, cfg.workDir);
  const promptFile = path.join(cfg.workDir, 'inputs', `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt);

  try {
    const result = await runGrok([
      '--prompt-file', promptFile,
      '--tools', 'read_file',
      '--always-approve', '--no-plan', '--no-subagents',
      '--max-turns', files.length ? '4' : '1',
    ], options);
    const text = typeof result.text === 'string' ? stripToJson(result.text) : '';
    if (!text) throw new Error('Grok CLI text response was empty');
    return text;
  } finally {
    cleanupFiles([promptFile, ...files]);
  }
};

// ---------- shared file helpers ----------

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

// Callers often pass a bare base64 string with a guessed MIME type (the
// frontend strips the data-URI header), so trust the magic bytes first.
const sniffMime = (buffer) => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  return null;
};

// Persist a base64 frame so the CLI tools can reference it by absolute path.
const writeFrameFile = (workDir, label, { bytesBase64Encoded, mimeType }) => {
  const dir = path.join(workDir, 'inputs');
  fs.mkdirSync(dir, { recursive: true });
  const buffer = Buffer.from(bytesBase64Encoded, 'base64');
  const mime = sniffMime(buffer) || (mimeType || '').split(';')[0];
  const ext = EXT_BY_MIME[mime] || '.png';
  const file = path.join(dir, `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(file, buffer);
  return file;
};

// Input frames are only needed for the duration of one CLI call.
const cleanupFiles = (files) => {
  for (const file of files) {
    if (!file) continue;
    try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
  }
};

const dataUriToFrame = (dataUri) => {
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUri || '');
  if (!match) return null;
  return { mimeType: match[1], bytesBase64Encoded: match[2] };
};

// Grok Build writes tool output under its own session folder:
//   ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/{images,videos}/N.ext
// The model usually reports that absolute path, but sometimes echoes the
// session-relative form ("images/1.jpg") or guesses it lives under cwd, so
// resolve every candidate against the session folder and, failing that, take
// the newest matching file the session produced.
const grokHome = (env) => clean(env.GROK_CLI_HOME) || path.join(os.homedir(), '.grok');

const sessionDir = (result, env) => {
  const { workDir } = getConfig(env);
  if (!result?.sessionId) return null;
  return path.join(grokHome(env), 'sessions', encodeURIComponent(workDir), String(result.sessionId));
};

const newestFile = (dir, extensions) => {
  if (!dir || !fs.existsSync(dir)) return null;
  const exts = new Set(extensions.map((e) => `.${e.toLowerCase()}`));
  const files = fs.readdirSync(dir)
    .filter((f) => exts.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(dir, f))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].f : null;
};

const extractPath = (result, extensions, env = process.env) => {
  const { workDir } = getConfig(env);
  const inputsDir = path.join(workDir, 'inputs');
  const text = typeof result.text === 'string' ? result.text : '';
  const kind = extensions.includes('mp4') ? 'videos' : 'images';

  // 1. Every call is a fresh headless session, so the file the tool saved is
  //    simply the newest one in that session's images/ or videos/ folder.
  const session = sessionDir(result, env);
  const produced = session ? newestFile(path.join(session, kind), extensions) : null;
  if (produced) return produced;

  // 2. Fall back to whatever path the model wrote, ignoring our own inputs.
  const candidates = [];
  const structured = result.structuredOutput || result.structured_output;
  if (structured && typeof structured.path === 'string') candidates.push(structured.path);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.path === 'string') candidates.push(parsed.path);
  } catch (_) { /* not JSON */ }
  const re = new RegExp(`(/[^\\s"'\`]*\\.(?:${extensions.join('|')}))`, 'gi');
  for (const m of text.matchAll(re)) candidates.push(m[1]);

  const found = candidates.find((p) => p
    && !path.resolve(p).startsWith(inputsDir + path.sep)
    && fs.existsSync(p) && fs.statSync(p).isFile());
  if (found) {
    log('grok_cli_path_from_text', { used: found, sessionId: result.sessionId || null });
    return found;
  }
  throw new Error(`Grok CLI did not report a saved file. Response: ${text.slice(0, 200)}`);
};

const fileToDataUri = (file) => {
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] || 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
};

// ---------- image ----------

const buildImageInstruction = ({ prompt, referencePath, aspectRatio }) => {
  const tool = referencePath
    ? `Call the image_edit tool exactly once with image="${referencePath}" and aspect_ratio="${aspectRatio}". The reference image shows the main character; render a NEW frame where this SAME character (identical appearance, clothing, colors) performs the action in the prompt.`
    : `Call the image_gen tool exactly once with aspect_ratio="${aspectRatio}".`;
  return [
    'You are a rendering worker. Do not ask questions, do not plan, do not write files yourself.',
    tool,
    'Use this prompt verbatim:',
    '<<<PROMPT',
    prompt,
    'PROMPT>>>',
    'You MUST actually invoke the tool; never answer without a tool result.',
    'When the tool returns, reply with a single line containing only the absolute path of the saved image, exactly as the tool reported it.',
  ].join('\n');
};

// The agent occasionally answers without invoking the tool. Retry once when
// no file was produced; a real API failure surfaces on the first attempt.
const withOneRetry = async (label, fn) => {
  try {
    return await fn();
  } catch (error) {
    if (!/did not report a saved file/.test(error.message)) throw error;
    log('grok_cli_retry', { label, reason: error.message.slice(0, 160) });
    return await fn();
  }
};

// Returns a data URI of the generated frame.
const generateImage = async ({ prompt, referenceImage = null }, options = {}) => withOneRetry('image', async () => {
  const env = options.env || process.env;
  const cfg = getConfig(env);
  fs.mkdirSync(cfg.workDir, { recursive: true });

  let referencePath = null;
  if (referenceImage) {
    const frame = referenceImage.startsWith('data:')
      ? dataUriToFrame(referenceImage)
      : { mimeType: 'image/png', bytesBase64Encoded: referenceImage };
    referencePath = writeFrameFile(cfg.workDir, 'ref', frame);
  }

  try {
    const result = await runGrok([
      '-p', buildImageInstruction({ prompt, referencePath, aspectRatio: cfg.imageAspectRatio }),
      '--tools', referencePath ? 'image_gen,image_edit' : 'image_gen',
      '--always-approve', '--no-plan', '--no-subagents', '--max-turns', '4',
    ], options);

    const file = extractPath(result, ['png', 'jpg', 'jpeg', 'webp'], env);
    return fileToDataUri(file);
  } finally {
    cleanupFiles([referencePath]);
  }
});

// ---------- video ----------

const buildVideoInstruction = ({ prompt, firstPath, lastPath, duration, aspectRatio, resolution }) => {
  const call = lastPath
    ? `Call the reference_to_video tool exactly once with first_frame="${firstPath}", last_frame="${lastPath}", duration=${duration}, aspect_ratio="${aspectRatio}", resolution_name="${resolution}". The clip must start exactly on the first frame and end exactly on the last frame.`
    : `Call the image_to_video tool exactly once with image="${firstPath}", duration=${duration}, aspect_ratio="${aspectRatio}", resolution_name="${resolution}".`;
  return [
    'You are a rendering worker. Do not ask questions, do not plan, do not generate new images.',
    call,
    'Use this prompt verbatim:',
    '<<<PROMPT',
    prompt,
    'PROMPT>>>',
    'You MUST actually invoke the tool; never answer without a tool result.',
    'When the tool returns, reply with a single line containing only the absolute path of the saved video, exactly as the tool reported it.',
  ].join('\n');
};

// Returns the absolute path of the generated .mp4 (inside the CLI work dir).
const generateVideo = async ({ prompt, firstFrame, lastFrame = null, durationSeconds }, options = {}) => withOneRetry('video', async () => {
  const env = options.env || process.env;
  const cfg = getConfig(env);
  if (!firstFrame) throw new Error('A first frame is required for Grok CLI video generation');
  fs.mkdirSync(cfg.workDir, { recursive: true });

  const firstPath = writeFrameFile(cfg.workDir, 'first', firstFrame);
  const lastPath = lastFrame ? writeFrameFile(cfg.workDir, 'last', lastFrame) : null;
  const parsed = Number.parseInt(durationSeconds, 10);
  const duration = Number.isInteger(parsed) ? Math.min(15, Math.max(1, parsed)) : 6;

  try {
    const result = await runGrok([
      '-p', buildVideoInstruction({
        prompt, firstPath, lastPath, duration,
        aspectRatio: cfg.videoAspectRatio, resolution: cfg.videoResolution,
      }),
      '--tools', lastPath ? 'reference_to_video' : 'image_to_video',
      '--always-approve', '--no-plan', '--no-subagents', '--max-turns', '4',
    ], options);

    return extractPath(result, ['mp4', 'mov', 'webm'], env);
  } finally {
    cleanupFiles([firstPath, lastPath]);
  }
});

module.exports = {
  getConfig,
  resolveBinary,
  isAvailable,
  runGrok,
  toAcpBlocks,
  generateText,
  generateImage,
  generateVideo,
  buildImageInstruction,
  buildVideoInstruction,
  _internal: { parseHeadlessOutput, extractPath, sessionDir, stripToJson, sniffMime },
};
