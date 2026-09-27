const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../src/services/grokCliService');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-cli-test-'));
// Point GROK_CLI_BIN at a file that exists so resolveBinary succeeds without a real install.
const env = { GROK_CLI_BIN: process.execPath, GROK_CLI_WORKDIR: workDir };
const ok = (obj) => ({ code: 0, stdout: JSON.stringify(obj), stderr: '' });

test('detects the binary from GROK_CLI_BIN or PATH', () => {
  assert.equal(cli.isAvailable(env), true);
  assert.equal(cli.isAvailable({ GROK_CLI_BIN: '/definitely/not/here/grok' }), false);
  assert.equal(cli.isAvailable({ GROK_CLI_BIN: 'grok', PATH: '/nonexistent-dir' }), false);
});

test('generateText writes the prompt and images to files and returns the answer', async () => {
  let call; let promptText; let imageExisted;
  const text = await cli.generateText(
    [{ text: 'Return JSON.' }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }],
    {
      env,
      execImpl: async (bin, args) => {
        call = { bin, args };
        const promptFile = args[args.indexOf('--prompt-file') + 1];
        promptText = fs.readFileSync(promptFile, 'utf8');
        const imgPath = /\[Attached image file: ([^\]]+)\]/.exec(promptText)[1];
        imageExisted = fs.existsSync(imgPath);
        return ok({ text: 'I will read the frame first. [{"shot":1}]', stopReason: 'end_turn' });
      },
    }
  );
  assert.equal(text, '[{"shot":1}]', 'narration before the JSON is stripped');
  assert.equal(call.bin, process.execPath);
  assert.ok(!call.args.includes('--prompt-json'), 'no base64 in argv (E2BIG)');
  assert.match(promptText, /read EVERY one of them with the read_file tool/);
  assert.match(promptText, /Return JSON\./);
  assert.equal(imageExisted, true, 'image file present during the call');
  assert.equal(call.args[call.args.indexOf('--max-turns') + 1], '4');
  assert.equal(call.args[call.args.indexOf('--tools') + 1], 'read_file');
  assert.ok(call.args.includes('--output-format') && call.args.includes('json'));
  assert.equal(call.args[call.args.indexOf('--cwd') + 1], workDir);
  assert.equal(fs.readdirSync(path.join(workDir, 'inputs')).length, 0, 'prompt and image files cleaned up');

  // Text-only prompts stay single-turn and pass through untouched.
  const plain = await cli.generateText([{ text: 'hi' }], {
    env, execImpl: async (_b, args) => { call = { args }; return ok({ text: ' plain answer ' }); },
  });
  assert.equal(plain, 'plain answer');
  assert.equal(call.args[call.args.indexOf('--max-turns') + 1], '1');
});

test('sniffs the real image type of reference frames', () => {
  const { sniffMime } = cli._internal;
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(sniffMime(Buffer.from('RIFF....WEBPVP8 ')), 'image/webp');
  assert.equal(sniffMime(Buffer.from('nope')), null);
});

test('caps concurrent CLI processes', async () => {
  let running = 0; let peak = 0;
  const slow = async () => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    return ok({ text: 'x' });
  };
  await Promise.all(Array.from({ length: 6 }, () => cli.generateText([{ text: 'hi' }], {
    env: { ...env, GROK_CLI_MAX_PARALLEL: '2' }, execImpl: slow,
  })));
  assert.equal(peak, 2);
});

test('surfaces CLI error events and non-zero exits', async () => {
  await assert.rejects(
    cli.generateText([{ text: 'x' }], { env, execImpl: async () => ({ code: 1, stdout: '{"type":"error","message":"Not signed in"}', stderr: '' }) }),
    /Not signed in/
  );
  await assert.rejects(
    cli.generateText([{ text: 'x' }], { env, execImpl: async () => ({ code: 1, stdout: '', stderr: 'boom' }) }),
    /exited with code 1: boom/
  );
  await assert.rejects(
    cli.generateText([{ text: 'x' }], { env: { GROK_CLI_BIN: '/nope/grok' }, execImpl: async () => ok({}) }),
    /not found/
  );
});

test('generateImage uses image_gen, then image_edit with a reference, and reads the file back', async () => {
  const out = path.join(workDir, 'images', '1.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from('iVBORw0KGgo=', 'base64'));

  let call;
  const uri = await cli.generateImage({ prompt: 'a fox on a hill' }, {
    env, execImpl: async (_b, args) => { call = args; return ok({ structuredOutput: { path: out }, text: '' }); },
  });
  assert.equal(uri, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(call[call.indexOf('--tools') + 1], 'image_gen');
  assert.ok(call.includes('--always-approve') && !call.includes('--json-schema'));
  assert.match(call[call.indexOf('-p') + 1], /a fox on a hill/);
  assert.match(call[call.indexOf('-p') + 1], /aspect_ratio="16:9"/);

  const uri2 = await cli.generateImage({ prompt: 'the fox jumps', referenceImage: 'data:image/png;base64,iVBORw0KGgo=' }, {
    env, execImpl: async (_b, args) => { call = args; return ok({ text: `{"path":"${out}"}` }); },
  });
  assert.equal(uri2, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(call[call.indexOf('--tools') + 1], 'image_gen,image_edit');
  const instruction = call[call.indexOf('-p') + 1];
  const refMatch = /image="([^"]+)"/.exec(instruction);
  assert.ok(refMatch && refMatch[1].endsWith('.png'), 'reference frame passed by path');
  assert.equal(fs.existsSync(refMatch[1]), false, 'reference frame cleaned up after the call');
});

test('generateVideo pins first/last frames or animates a single image', async () => {
  const out = path.join(workDir, 'videos', '1.mp4');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'mp4');
  const frame = { bytesBase64Encoded: 'iVBORw0KGgo=', mimeType: 'image/png' };

  let call;
  const file = await cli.generateVideo({ prompt: 'dolly in', firstFrame: frame, lastFrame: frame, durationSeconds: 6 }, {
    env: { ...env, GROK_CLI_VIDEO_RESOLUTION: '1080p' },
    execImpl: async (_b, args) => { call = args; return ok({ text: `Saved to ${out}` }); },
  });
  assert.equal(file, out);
  assert.equal(call[call.indexOf('--tools') + 1], 'reference_to_video');
  const instr = call[call.indexOf('-p') + 1];
  assert.match(instr, /first_frame="[^"]+"/);
  assert.match(instr, /last_frame="[^"]+"/);
  assert.match(instr, /duration=6/);
  assert.match(instr, /resolution_name="1080p"/);

  await cli.generateVideo({ prompt: 'hold', firstFrame: frame, durationSeconds: 40 }, {
    env, execImpl: async (_b, args) => { call = args; return ok({ structuredOutput: { path: out } }); },
  });
  assert.equal(call[call.indexOf('--tools') + 1], 'image_to_video');
  assert.match(call[call.indexOf('-p') + 1], /duration=15/);

  let attempts = 0;
  await assert.rejects(
    cli.generateVideo({ prompt: 'x', firstFrame: frame, durationSeconds: 4 }, { env, execImpl: async () => { attempts += 1; return ok({ text: 'done, no file' }); } }),
    /did not report a saved file/
  );
  assert.equal(attempts, 2, 'retries once when the agent skipped the tool');
});

test('resolves session-relative or misreported paths against the Grok session folder', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
  const sessionId = '01a0c494-199f-72c3-80f6-c9d577191d08';
  const session = path.join(home, 'sessions', encodeURIComponent(workDir), sessionId);
  fs.mkdirSync(path.join(session, 'images'), { recursive: true });
  fs.mkdirSync(path.join(session, 'videos'), { recursive: true });
  const img = path.join(session, 'images', '1.jpg');
  fs.writeFileSync(img, Buffer.from('/9j/', 'base64'));
  const vid = path.join(session, 'videos', '1.mp4');
  fs.writeFileSync(vid, 'mp4');
  const envHome = { ...env, GROK_CLI_HOME: home };

  // Model guessed a cwd-relative path that does not exist.
  const uri = await cli.generateImage({ prompt: 'x' }, {
    env: envHome,
    execImpl: async () => ok({ sessionId, text: `{"path": "${path.join(workDir, 'images', '1.jpg')}"}` }),
  });
  assert.equal(uri, `data:image/jpeg;base64,${fs.readFileSync(img).toString('base64')}`);

  // Model reported only the short session-relative form.
  const uri2 = await cli.generateImage({ prompt: 'x' }, {
    env: envHome, execImpl: async () => ok({ sessionId, text: 'Saved to images/1.jpg' }),
  });
  assert.equal(uri2, uri);

  // Model reported nothing usable: fall back to the newest video in the session.
  const frame = { bytesBase64Encoded: 'iVBORw0KGgo=', mimeType: 'image/png' };
  const file = await cli.generateVideo({ prompt: 'x', firstFrame: frame, durationSeconds: 4 }, {
    env: envHome, execImpl: async () => ok({ sessionId, text: 'Done.' }),
  });
  assert.equal(file, vid);

  // Model echoed our own input path: never return the reference frame as output.
  let echoed;
  await assert.rejects(
    cli.generateImage({ prompt: 'x', referenceImage: 'data:image/png;base64,iVBORw0KGgo=' }, {
      env, execImpl: async (_b, args) => {
        echoed = /image="([^"]+)"/.exec(args[args.indexOf('-p') + 1])[1];
        return ok({ text: `Edited ${echoed}` });
      },
    }),
    /did not report a saved file/
  );
});

test('reports spawn failures and timeouts with their cause', async () => {
  await assert.rejects(
    cli.generateText([{ text: 'x' }], { env, execImpl: async () => ({ code: 1, stdout: '', stderr: '', failure: 'killed by SIGTERM after 5 ms' }) }),
    /failed to run: killed by SIGTERM/
  );
});

test('stripToJson extracts the outermost JSON value from narrated output', () => {
  const { stripToJson } = cli._internal;
  const obj = '{"shots":[{"id":1},{"id":2}]}';
  assert.equal(stripToJson(obj), obj);
  assert.equal(stripToJson(`I'll read both frames first.\n${obj}`), obj);
  assert.equal(stripToJson('```json\n' + obj + '\n```'), obj);
  const arr = '[{"id":1},{"id":2}]';
  assert.equal(stripToJson(`Read [image 1] and [image 2].\n${arr}`), arr);
  assert.equal(stripToJson(`See note [1].\n${arr}\nDone [ok].`), arr);
  assert.equal(stripToJson('{"prompt":"pan [left] to {right}"}'), '{"prompt":"pan [left] to {right}"}');
  assert.equal(stripToJson('no json here'), 'no json here');
});
