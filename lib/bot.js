/**
 * Main Bot Logic — VISION + SFG + VAJIRAM + PW
 * v3.0 — Vercel-safe session (3-layer persistence):
 *   Layer 1: /tmp file store (survives warm instances)
 *   Layer 2: reply_to_message text detection (stateless fallback)
 *   Layer 3: Inline keyboard mode picker (ultimate fallback)
 */

'use strict';

const fs      = require('fs');
const fetch   = require('node-fetch');
const FormData = require('form-data');
const { parseSFG }     = require('./parsers/sfg');
const { parseVajiram } = require('./parsers/vajiram');
const { parseVision }  = require('./parsers/vision');
const { parsePW }      = require('./parsers/pw');
const { fixTxtFile }   = require('./fixer');

const TOKEN    = process.env.BOT_TOKEN;
const BASE_URL = `https://api.telegram.org/bot${TOKEN}`;

// ─── Session store: kvdb.io (for Vercel serverless persistence) + /tmp + Memory ───
const BUCKET = 'vspw_sess_bucket_8f7b2c9d';
const KV_URL = `https://kvdb.io/${BUCKET}`;
const SESS_FILE = '/tmp/vspw_sessions.json';
let _sessions   = {};

// Load from /tmp on module init (survives warm Vercel instances)
try { _sessions = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); } catch(_) {}

function saveSessionsLocal() {
  try { fs.writeFileSync(SESS_FILE, JSON.stringify(_sessions)); } catch(_) {}
}

async function getSession(chatId) {
  const id = String(chatId);
  // 1. Try memory
  if (_sessions[id]) return _sessions[id];

  // 2. Try KV store (database fallback for cold starts)
  try {
    const res = await fetch(`${KV_URL}/${id}`);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        _sessions[id] = data;
        return data;
      }
    }
  } catch (_) {}

  // 3. Default session
  _sessions[id] = { mode: null, step: null, files: {}, ts: Date.now() };
  return _sessions[id];
}

async function saveSession(chatId, sessionData) {
  const id = String(chatId);
  _sessions[id] = sessionData;
  saveSessionsLocal();
  try {
    await fetch(`${KV_URL}/${id}`, {
      method: 'POST',
      body: JSON.stringify(sessionData),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (_) {}
}

async function setSession(chatId, mode, step, files = {}) {
  const data = { mode, step, files, ts: Date.now() };
  await saveSession(chatId, data);
  return data;
}

async function patchSession(chatId, patch) {
  const cur = await getSession(chatId);
  const data = { ...cur, ...patch, ts: Date.now() };
  await saveSession(chatId, data);
  return data;
}

async function clearSession(chatId) {
  const data = { mode: null, step: null, files: {}, ts: Date.now() };
  await saveSession(chatId, data);
}

// Stale session cleanup (older than 2 hours)
async function pruneOldSessions() {
  const now = Date.now();
  for (const id of Object.keys(_sessions)) {
    if (now - (_sessions[id].ts || 0) > 2 * 60 * 60 * 1000) {
      delete _sessions[id];
      try {
        await fetch(`${KV_URL}/${id}`, { method: 'DELETE' });
      } catch (_) {}
    }
  }
  saveSessionsLocal();
}

// ─── Mode detection from bot reply text (Layer 2 fallback) ───────────────────
function detectModeFromReply(replyText) {
  if (!replyText) return null;
  if (/ForumIAS\s*SFG/i.test(replyText))        return { mode: 'sfg',     step: 'wait_pdf' };
  if (/Vajiram.*Test Booklet/i.test(replyText))  return { mode: 'vajiram', step: 'wait_test' };
  if (/Vajiram.*Solution/i.test(replyText))      return { mode: 'vajiram', step: 'wait_sol' };
  if (/VisionIAS.*Test/i.test(replyText))        return { mode: 'vision',  step: 'wait_test' };
  if (/VisionIAS.*Solution/i.test(replyText))    return { mode: 'vision',  step: 'wait_sol' };
  if (/PW\s*Only.*Test/i.test(replyText))        return { mode: 'pw',      step: 'wait_test' };
  if (/PW\s*Only.*Solution/i.test(replyText))    return { mode: 'pw',      step: 'wait_sol' };
  if (/TXT\s*Fixer|\.txt\s*file/i.test(replyText)) return { mode: 'fixer', step: 'wait_txt' };
  return null;
}

// ─── Telegram API helpers ─────────────────────────────────────────────────────
async function tgPost(method, body) {
  const r = await fetch(`${BASE_URL}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function sendMessage(chatId, text, opts = {}) {
  const d = await tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...opts });
  return d.result;  // has .message_id
}

async function editMessage(chatId, msgId, text) {
  try {
    await tgPost('editMessageText', {
      chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML',
    });
  } catch(_) {}
}

async function answerCBQ(id, text = '') {
  await tgPost('answerCallbackQuery', { callback_query_id: id, text });
}

async function sendDocument(chatId, buffer, filename) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', buffer, { filename, contentType: 'text/plain' });
  await fetch(`${BASE_URL}/sendDocument`, { method: 'POST', body: form });
}

async function sendChatAction(chatId) {
  await tgPost('sendChatAction', { chat_id: chatId, action: 'upload_document' });
}

async function downloadFile(fileId) {
  const d    = await tgPost('getFile', { file_id: fileId });
  if (!d.ok) throw new Error(`getFile failed: ${d.description || 'unknown'}`);
  const url  = `https://api.telegram.org/file/bot${TOKEN}/${d.result.file_path}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
  return resp.buffer();
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
const pb = (p) => '█'.repeat(Math.round(p/10)) + '░'.repeat(10-Math.round(p/10)) + ` ${p}%`;

// ─── Report card ──────────────────────────────────────────────────────────────
function reportCard(mode, s) {
  const L = '━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const M = { sfg:'⚡ ForumIAS SFG', vajiram:'⚙️ Vajiram &amp; Ravi', vision:'🔮 VisionIAS', pw:'🔥 PW Only IAS', fixer:'🔧 TXT Fixer' };
  let c = `📊 <b>REPORT CARD</b>\n${L}\n📌 <b>Mode:</b> ${M[mode]||mode}\n${L}\n`;
  if (s.testFile)       c += `📄 <b>Test PDF:</b> ${s.testFile}\n`;
  if (s.solFile)        c += `📄 <b>Solution PDF:</b> ${s.solFile}\n`;
  if (s.inputFile)      c += `📄 <b>Input:</b> ${s.inputFile}\n`;
  c += `${L}\n`;
  if (s.testQuestions  != null) c += `📝 <b>Questions (Test PDF):</b>   ${s.testQuestions}\n`;
  if (s.answersFound   != null) c += `🔑 <b>Answers (Solution PDF):</b> ${s.answersFound}\n`;
  if (s.matched        != null) c += `✅ <b>Fully Matched:</b>          ${s.matched}\n`;
  if (s.noAns          != null) c += `⚠️ <b>No Answer Found:</b>        ${s.noAns}\n`;
  if (s.noExpl         != null) c += `⚠️ <b>No Explanation:</b>         ${s.noExpl}\n`;
  if (s.hindiSkipped   != null) c += `⏭️ <b>Hindi Skipped:</b>       ${s.hindiSkipped}\n`;
  if (s.txtQuestions   != null) c += `📤 <b>Questions in .txt:</b>      ${s.txtQuestions}\n`;
  if (s.questionsFixed != null) c += `🔧 <b>Added To:</b>         ${s.questionsFixed} Qs\n`;
  if (s.total          != null && s.questionsFixed != null) c += `📊 <b>Total Qs in File:</b>     ${s.total}\n`;
  if (s.outputLines    != null) c += `📏 <b>Output Lines:</b>           ${s.outputLines}\n`;
  if (s.processingTime != null) c += `⏱️  <b>Processing Time:</b>        ${s.processingTime}s\n`;
  c += L;
  if (s.matched != null && s.testQuestions) {
    const acc = Math.round((s.matched / s.testQuestions) * 100);
    c += `\n🎯 <b>Match Rate:</b> ${acc}%\n`;
    c += acc === 100 ? '🏆 Perfect!\n' : acc >= 90 ? '✨ Excellent result!\n' : acc >= 70 ? '👍 Good result!\n' : '⚠️ Check output manually.\n';
  }
  return c;
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
const MAIN_MENU = {
  reply_markup: JSON.stringify({
    keyboard: [
      ['⚡ ForumIAS SFG — 50Q', '⚙️ Vajiram & Ravi — 100Q'],
      ['🔮 VisionIAS — 100Q',   '🔥 PW Only IAS — 100Q'],
      ['🔧 TXT File Fixer',     '❓ Help'],
    ],
    resize_keyboard: true, one_time_keyboard: false,
  }),
};

// Inline keyboard: shown when PDF arrives but no session found
const MODE_PICKER_INLINE = (prefix = '') => ({
  reply_markup: JSON.stringify({
    inline_keyboard: [
      [
        { text: '⚡ SFG 50Q',      callback_data: `${prefix}sfg` },
        { text: '⚙️ Vajiram Test', callback_data: `${prefix}vajiram_test` },
      ],
      [
        { text: '🔮 Vision Test',  callback_data: `${prefix}vision_test` },
        { text: '🔥 PW Test',      callback_data: `${prefix}pw_test` },
      ],
      [
        { text: '⚙️ Vajiram Sol',  callback_data: `${prefix}vajiram_sol` },
        { text: '🔮 Vision Sol',   callback_data: `${prefix}vision_sol` },
      ],
      [
        { text: '🔥 PW Sol',       callback_data: `${prefix}pw_sol` },
        { text: '❌ Cancel',        callback_data: `${prefix}cancel` },
      ],
    ]
  }),
});

// Removed FORCE_REPLY as requested so users do not need to reply to messages
const FORCE_REPLY = {};

const WELCOME = `🚀 <b>VISION + SFG + VAJIRAM + PW Bot</b>

Convert UPSC PDFs → formatted <code>.txt</code> instantly!

<b>Converters:</b>
⚡ <b>ForumIAS SFG</b> — 50Q (1 PDF)
⚙️ <b>Vajiram &amp; Ravi</b> — 100Q (Test + Solution)
🔮 <b>VisionIAS</b> — 100Q (Test + Solution)
🔥 <b>PW Only IAS</b> — 100Q (Test + Solution)
🔧 <b>TXT Fixer</b> — Add 😂 to existing .txt files

Select below 👇`;

const HELP_TEXT = `<b>📖 How to use:</b>

<b>SFG (1 PDF only):</b>
→ Tap "⚡ ForumIAS SFG" → Send PDF

<b>Vajiram / Vision / PW (2 PDFs):</b>
→ Tap converter → Send <b>Test PDF</b> first → then <b>Solution PDF</b>

<b>TXT Fixer:</b>
→ Tap "🔧 TXT Fixer" → Send .txt file

<b>Commands:</b>
/start /sfg /vajiram /vision /pw /fixer /cancel

<b>⚠️ PDFs must be text-based (not scanned images)</b>`;

// ─── Mode text maps ───────────────────────────────────────────────────────────
const ASK_TEST = {
  vajiram: '📚 <b>Vajiram &amp; Ravi Mode</b>\n\nSend me the <b>Test Booklet PDF</b> (questions) now.',
  vision:  '🔮 <b>VisionIAS Mode</b>\n\nSend me the <b>Test Booklet PDF</b> (questions) now.',
  pw:      '🔥 <b>PW Only IAS Mode</b>\n\nSend me the <b>Test PDF</b> (questions) now.\n<i>Hindi sections auto-skipped.</i>',
};
const ASK_SOL = {
  vajiram: (name) => `✅ Got Test PDF: <code>${name}</code>\n\nNow send the <b>Solution / Answer Key PDF</b>.`,
  vision:  (name) => `✅ Got Test PDF: <code>${name}</code>\n\nNow send the <b>Solution PDF</b> (with Q 1.A answers).`,
  pw:      (name) => `✅ Got Test PDF: <code>${name}</code>\n\nNow send the <b>Solution PDF</b> (answers + explanations).`,
};

// ─── Core PDF processor ───────────────────────────────────────────────────────
async function processSFG(chatId, fileId, filename, progMsg) {
  const t0 = Date.now();
  await editMessage(chatId, progMsg.message_id, `⏳ <b>ForumIAS SFG Processing...</b>\n${pb(30)}\n\nDownloading PDF...`);
  const pdfBuf = await downloadFile(fileId);
  await editMessage(chatId, progMsg.message_id, `⏳ <b>ForumIAS SFG Processing...</b>\n${pb(60)}\n\nParsing questions...`);
  const result = await parseSFG(pdfBuf);
  if (result.error) { await editMessage(chatId, progMsg.message_id, `❌ ${result.error}`); return; }
  await editMessage(chatId, progMsg.message_id, `⏳ <b>ForumIAS SFG Processing...</b>\n${pb(95)}\n\nPreparing .txt file...`);
  const outBuf  = Buffer.from(result.text, 'utf8');
  const outName = filename.replace(/\.pdf$/i, '') + '_SFG_CONVERTED.txt';
  const secs    = ((Date.now()-t0)/1000).toFixed(1);
  await editMessage(chatId, progMsg.message_id, `✅ <b>SFG — Done!</b>`);
  await sendDocument(chatId, outBuf, outName);
  await sendMessage(chatId, reportCard('sfg', {
    testFile: filename, testQuestions: result.questionCount,
    answersFound: result.answersFound, matched: result.answersFound,
    noAns: result.noAns, txtQuestions: result.questionCount,
    outputLines: result.text.split('\n').length, processingTime: secs,
  }));
  clearSession(chatId);
  return sendMessage(chatId, '✅ Done! Choose another converter 👇', MAIN_MENU);
}

async function processTwoPDF(chatId, mode, testId, testName, solId, solName, progMsg) {
  const t0       = Date.now();
  const LABEL    = { vajiram:'Vajiram &amp; Ravi', vision:'VisionIAS', pw:'PW Only IAS' }[mode];
  const SUFFIX   = { vajiram:'VAJIRAM', vision:'VISION', pw:'PW' }[mode];

  await editMessage(chatId, progMsg.message_id, `⏳ <b>${LABEL} Processing...</b>\n${pb(10)}\n\nDownloading Test PDF...`);
  const testBuf = await downloadFile(testId);
  await editMessage(chatId, progMsg.message_id, `⏳ <b>${LABEL} Processing...</b>\n${pb(25)}\n\nDownloading Solution PDF...`);
  const solBuf  = await downloadFile(solId);
  await editMessage(chatId, progMsg.message_id, `⏳ <b>${LABEL} Processing...</b>\n${pb(50)}\n\nParsing questions...`);

  let result;
  if (mode === 'vajiram') result = await parseVajiram(testBuf, solBuf);
  if (mode === 'vision')  result = await parseVision(testBuf, solBuf);
  if (mode === 'pw')      result = await parsePW(testBuf, solBuf);

  if (result.error) { await editMessage(chatId, progMsg.message_id, `❌ ${result.error}`); return; }

  await editMessage(chatId, progMsg.message_id, `⏳ <b>${LABEL} Processing...</b>\n${pb(90)}\n\nBuilding .txt file...`);
  const secs    = ((Date.now()-t0)/1000).toFixed(1);
  const outBuf  = Buffer.from(result.text, 'utf8');
  const outName = testName.replace(/\.pdf$/i, '') + `_${SUFFIX}_CONVERTED.txt`;
  await editMessage(chatId, progMsg.message_id, `✅ <b>${LABEL} — Done!</b>`);
  await sendDocument(chatId, outBuf, outName);

  const stats = {
    testFile: testName, solFile: solName,
    testQuestions: result.questionCount, answersFound: result.answersFound,
    matched: result.matched, noAns: result.noAns, noExpl: result.noExpl,
    hindiSkipped: result.hindiSkipped, txtQuestions: result.questionCount,
    outputLines: result.text.split('\n').length, processingTime: secs,
  };
  Object.keys(stats).forEach(k => (stats[k] == null) && delete stats[k]);
  await sendMessage(chatId, reportCard(mode, stats));
  clearSession(chatId);
  return sendMessage(chatId, '✅ Done! Choose another converter 👇', MAIN_MENU);
}

// ─── Callback query handler (inline keyboard) ─────────────────────────────────
async function handleCallbackQuery(cbq) {
  await answerCBQ(cbq.id);
  const chatId  = cbq.message.chat.id;
  const data    = cbq.data || '';
  const session = await getSession(chatId);

  if (data === 'cancel' || data.endsWith('cancel')) {
    await clearSession(chatId);
    return sendMessage(chatId, '✅ Cancelled.', MAIN_MENU);
  }

  // Mode pick from inline keyboard (when PDF arrived without session)
  const modeMap = {
    'sfg':         { mode:'sfg',     step:'wait_pdf' },
    'vajiram_test':{ mode:'vajiram', step:'wait_test' },
    'vision_test': { mode:'vision',  step:'wait_test' },
    'pw_test':     { mode:'pw',      step:'wait_test' },
    'vajiram_sol': { mode:'vajiram', step:'wait_sol' },
    'vision_sol':  { mode:'vision',  step:'wait_sol' },
    'pw_sol':      { mode:'pw',      step:'wait_sol' },
  };

  if (modeMap[data]) {
    const { mode, step } = modeMap[data];
    const pending = session.files && session.files.pendingId;

    if (pending && mode === 'sfg') {
      // Process SFG immediately with pending file
      const pname = session.files.pendingName || 'file.pdf';
      await setSession(chatId, 'sfg', 'processing', {});
      const prog = await sendMessage(chatId, `⏳ <b>ForumIAS SFG Processing...</b>\n${pb(10)}\n\nStarting...`);
      return processSFG(chatId, pending, pname, prog);
    }

    if (pending && step === 'wait_test') {
      // This PDF is the Test PDF for 2-step mode
      await setSession(chatId, mode, 'wait_sol', { testId: pending, testName: session.files.pendingName || 'test.pdf' });
      return sendMessage(chatId, ASK_SOL[mode](session.files.pendingName || 'test.pdf'), FORCE_REPLY);
    }

    if (pending && step === 'wait_sol') {
      // This PDF is the Solution PDF — need Test PDF too
      // We have the sol but not test — ask for test first
      await setSession(chatId, mode, 'wait_test', {});
      return sendMessage(chatId,
        `⚠️ I need the <b>Test PDF</b> first, then Solution.\n\n${ASK_TEST[mode]}`, FORCE_REPLY);
    }

    // No pending — just set mode and ask for PDF
    await setSession(chatId, mode, step, {});
    if (mode === 'sfg') {
      return sendMessage(chatId,
        '📄 <b>ForumIAS SFG Mode</b>\n\nSend me the <b>Solutions PDF</b> (50 questions).', FORCE_REPLY);
    }
    return sendMessage(chatId, ASK_TEST[mode], FORCE_REPLY);
  }
}

// ─── Main webhook handler ─────────────────────────────────────────────────────
async function handleWebhook(update) {
  if (!update) return;
  await pruneOldSessions();

  // Callback queries (inline keyboard)
  if (update.callback_query) return handleCallbackQuery(update.callback_query);

  const message = update.message || update.edited_message;
  if (!message) return;

  const chatId  = message.chat.id;
  let session   = await getSession(chatId);

  // ── Text commands ────────────────────────────────────────────────────────────
  if (message.text) {
    const text  = message.text.trim();
    const lower = text.toLowerCase();

    if (lower === '/start') { await clearSession(chatId); return sendMessage(chatId, WELCOME, MAIN_MENU); }
    if (lower === '/help' || text === '❓ Help') return sendMessage(chatId, HELP_TEXT);
    if (lower === '/cancel') { await clearSession(chatId); return sendMessage(chatId, '✅ Cancelled.', MAIN_MENU); }

    const MODE_TRIGGERS = {
      '/sfg': 'sfg', '⚡ forumias sfg — 50q': 'sfg',
      '/vajiram': 'vajiram', '⚙️ vajiram & ravi — 100q': 'vajiram',
      '/vision': 'vision', '🔮 visionias — 100q': 'vision',
      '/pw': 'pw', '🔥 pw only ias — 100q': 'pw',
      '/fixer': 'fixer', '🔧 txt file fixer': 'fixer',
    };
    const mode = MODE_TRIGGERS[lower];
    if (mode) {
      await clearSession(chatId);
      if (mode === 'sfg') {
        await setSession(chatId, 'sfg', 'wait_pdf', {});
        return sendMessage(chatId,
          '📄 <b>ForumIAS SFG Mode</b>\n\nSend me the <b>Solutions PDF</b> (50 questions).', FORCE_REPLY);
      }
      if (mode === 'fixer') {
        await setSession(chatId, 'fixer', 'wait_txt', {});
        return sendMessage(chatId,
          '🔧 <b>TXT Fixer Mode</b>\n\nSend me your <b>.txt file</b>. I\'ll add 😂 where missing.', FORCE_REPLY);
      }
      await setSession(chatId, mode, 'wait_test', {});
      return sendMessage(chatId, ASK_TEST[mode], FORCE_REPLY);
    }

    if (!session.mode) return sendMessage(chatId, 'Choose a converter 👇', MAIN_MENU);
    return;
  }

  // ── Documents ────────────────────────────────────────────────────────────────
  if (!message.document) return;

  const doc      = message.document;
  const filename = doc.file_name || 'file';
  const fileId   = doc.file_id;
  const mime     = doc.mime_type || '';
  const isPDF    = mime.includes('pdf') || filename.toLowerCase().endsWith('.pdf');
  const isTXT    = mime.includes('text') || filename.toLowerCase().endsWith('.txt');

  // ── Layer 2: reply_to_message mode detection ────────────────────────────────
  if (!session.mode && message.reply_to_message) {
    const replyTxt = message.reply_to_message.text || '';
    const detected = detectModeFromReply(replyTxt);
    if (detected) {
      await patchSession(chatId, detected);
      session = await getSession(chatId);
    }
  }

  // ── Layer 3: no session — show inline keyboard ───────────────────────────────
  if (!session.mode) {
    // Store pending file so after mode pick we can process it
    await patchSession(chatId, { files: { pendingId: fileId, pendingName: filename } });
    return sendMessage(chatId,
      `📄 Got file: <code>${filename}</code>\n\n❓ <b>Which converter should I use?</b>`,
      MODE_PICKER_INLINE(''));
  }

  // ── TXT Fixer ────────────────────────────────────────────────────────────────
  if (session.mode === 'fixer') {
    if (!isTXT) return sendMessage(chatId, '❌ Please send a <b>.txt file</b>.');
    await sendChatAction(chatId);
    const prog = await sendMessage(chatId, `⏳ <b>Fixing TXT File...</b>\n${pb(20)}\n\nReading file...`);
    const t0   = Date.now();
    try {
      const buf    = await downloadFile(fileId);
      await editMessage(chatId, prog.message_id, `⏳ <b>Fixing TXT File...</b>\n${pb(70)}\n\nAdding 😂 markers...`);
      const result = fixTxtFile(buf.toString('utf8'));
      if (result.error) { await editMessage(chatId, prog.message_id, `❌ ${result.error}`); return; }
      const outBuf  = Buffer.from(result.text, 'utf8');
      const outName = filename.replace(/\.txt$/i, '') + '_FIXED.txt';
      const secs    = ((Date.now()-t0)/1000).toFixed(1);
      await editMessage(chatId, prog.message_id, `✅ <b>TXT Fixed!</b>`);
      await sendDocument(chatId, outBuf, outName);
      await sendMessage(chatId, reportCard('fixer', {
        inputFile: filename, questionsFixed: result.questionsFixed,
        total: result.total, outputLines: result.text.split('\n').length, processingTime: secs,
      }));
      await clearSession(chatId);
      return sendMessage(chatId, '✅ Done!', MAIN_MENU);
    } catch(err) {
      console.error(err);
      await editMessage(chatId, prog.message_id, `❌ Failed: ${err.message}`);
    }
    return;
  }

  // ── SFG ──────────────────────────────────────────────────────────────────────
  if (session.mode === 'sfg') {
    if (!isPDF) return sendMessage(chatId, '❌ Please send a <b>PDF file</b>.');
    await sendChatAction(chatId);
    const prog = await sendMessage(chatId, `⏳ <b>ForumIAS SFG Processing...</b>\n${pb(10)}\n\nStarting...`);
    await patchSession(chatId, { step: 'processing' });
    return processSFG(chatId, fileId, filename, prog);
  }

  // ── Vajiram / Vision / PW ─────────────────────────────────────────────────
  if (['vajiram','vision','pw'].includes(session.mode)) {
    if (!isPDF) return sendMessage(chatId, '❌ Please send a <b>PDF file</b>.');

    if (session.step === 'wait_test' || !session.step) {
      await patchSession(chatId, { step: 'wait_sol', files: { testId: fileId, testName: filename } });
      session = await getSession(chatId);
      return sendMessage(chatId, ASK_SOL[session.mode](filename), FORCE_REPLY);
    }

    if (session.step === 'wait_sol') {
      const testId   = session.files.testId;
      const testName = session.files.testName;
      if (!testId) {
        // Lost test PDF — ask again
        await patchSession(chatId, { step: 'wait_test', files: {} });
        return sendMessage(chatId,
          `⚠️ I lost the Test PDF. Please send the <b>Test PDF</b> again.`, FORCE_REPLY);
      }
      await sendChatAction(chatId);
      const LABEL = { vajiram:'Vajiram &amp; Ravi', vision:'VisionIAS', pw:'PW Only IAS' }[session.mode];
      const prog  = await sendMessage(chatId, `⏳ <b>${LABEL} Processing...</b>\n${pb(5)}\n\nStarting...`);
      await patchSession(chatId, { step: 'processing' });
      return processTwoPDF(chatId, session.mode, testId, testName, fileId, filename, prog);
    }
  }
}

module.exports = { handleWebhook };
