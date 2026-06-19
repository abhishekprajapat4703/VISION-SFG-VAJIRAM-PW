/**
 * PW Only IAS Parser — v3
 * Replicates the state machine question extraction of PW ONLY IAS.html.
 * Vercel-safe.
 */

'use strict';

let pdfParse;
try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); }
catch(e) { pdfParse = require('pdf-parse'); }

async function getText(buffer) {
  const data = await pdfParse(buffer);
  if (!data.text || !data.text.trim())
    throw new Error('No text found. PDF may be scanned — requires text-based PDF.');
  return data.text;
}

const DEVA_RE = /[\u0900-\u097F]/g;
function isHindi(s) {
  if (!s) return false;
  const match = s.match(DEVA_RE);
  const count = match ? match.length : 0;
  return (count / s.length) > 0.18;
}

const SKIP_RES = [
  /srijan\s+(prelims|program|test)/i,
  /sectional\s+full\s+length/i,
  /target\s+-\s+20\d\d/i,
  /test\s+duration/i,
  /total\s+marks/i,
  /sdps\d/i, /spp\s*\d/i,
  /pwonlyias/i,
  /if\s+you\s+have\s+any\s+queries/i,
  /please\s+mail\s+us/i,
  /^\s*\d+\s*$/,
];
function isSkip(s) { return SKIP_RES.some(r => r.test(s)); }

const INSTR_BODY_RES = [
  /^The\s+test\s+paper\s+contains/i,
  /^All\s+items\s+carry/i,
  /^All\s+Questions\s+are\s+objective/i,
  /^Penalty\s+for\s+wrong/i,
  /^THERE\s+WILL\s+BE\s+PENALTY/i,
  /candidate\s+will\s+select\s+the\s+response/i,
  /^Each\s+Question\s+carries/i,
  /^Each\s+item\s+comprises/i,
  /more\s+than\s+one\s+correct\s+response/i,
  /^candidate\s+feels\s+that/i,
  /^four\s+alternatives\s+for/i,
];
function isInstrBody(s) { return INSTR_BODY_RES.some(r => r.test(s)); }

// ─── Body parser (Statement I/II/III, Match headers) ─────────────────────────
function parseBodyLines(rawLines) {
  let main=[], items=[], stem='', mhdr='', state='main', cur='';
const OPT_RE = /^\(\s*([a-d])\s*\)\s+([\s\S]+)/i;
const NUM_RE = /^(\d{1,3})\.\s+([\s\S]+)/;
const STMT_RE = /^Statement\s+(I{1,3}|IV|V|VI)\s*:/i;
const AR_RE = /^(Assertion|Reason)\s*[: (]/i;
const PAIRS_HDR_RE = /^consider\s+the\s+following\s+pairs/i;

const STEM_RES = [
  /^which\s+(one\s+)?of\s+the\s+(above|following)/i,
  /^which\s+of\s+the\s+statements/i,
  /^which\s+of\s+the\s+(pairs|countries|items)/i,
  /^how\s+many\s+(of\s+the|pairs|statements|rows|items|above|countries)/i,
  /^select\s+the\s+(correct|most)/i,
  /^identify\s+the\s+(correct|incorrect)/i,
  /^given\s+the\s+above\s+(statements|context)/i,
  /^in\s+the\s+light\s+of\s+the\s+above/i,
  /^which\s+(of\s+the\s+)?above\s+statement/i,
  /^arrange\s+the\s+following/i,
  /^choose\s+the\s+(correct|best)\s+(option|answer)/i,
];
function isStem(s) { return STEM_RES.some(r => r.test(s.trim())); }

const TBL_HDR_SKIP = /^(Phenomenon|Description|Experiment|Characteristic|Mission|System|Trajectory|Orbital|Period|Column)\s*(I{0,3}|[1-9])?\s*$/i;

function cleanStr(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

function getPairText(si) {
  const raw = (si.text || '').replace(/\s+/g, ' ').trim();
  if (raw.includes('|')) return raw.replace(/\s*\|\s*/g, ' | ');
  if (/[—–]/.test(raw)) return raw.replace(/\s*[—–]\s*/g, ' — ');
  return raw;
}

function mkQ(num, introText) {
  return {
    num,
    intro: [introText],
    stmts: [],
    subs: [],
    stem: '',
    opts: [],
    isPairs: false,
  };
}

let activeQ = null;
let parserState = 'SEEKING';

function classifyNum(num) {
  if (!activeQ || parserState === 'SEEKING') return 'NEW_Q';
  if (parserState === 'IN_OPTS') return num > activeQ.num ? 'NEW_Q' : 'BODY';

  const sc = activeQ.subs.length;
  if (num === 1 && sc === 0) return 'SUB';
  if (sc > 0 && num === sc + 1) return 'SUB';

  if (num > activeQ.num) return 'NEW_Q';
  return 'BODY';
}

function appendToBody(text) {
  if (activeQ.stem) { activeQ.stem = cleanStr(activeQ.stem + ' ' + text); return; }
  if (isStem(text)) { activeQ.stem = text; return; }

  if (activeQ.stmts.length > 0) {
    const ls = activeQ.stmts[activeQ.stmts.length - 1];
    if (!/[.!?]\s*$/.test(ls) && !STMT_RE.test(text) && !AR_RE.test(text)) {
      activeQ.stmts[activeQ.stmts.length - 1] = cleanStr(ls + ' ' + text);
      return;
    }
  }

  if (activeQ.subs.length > 0) {
    const ls = activeQ.subs[activeQ.subs.length - 1];
    ls.text = cleanStr(ls.text + ' ' + text);
    return;
  }

  const lastIntro = activeQ.intro[activeQ.intro.length - 1] || '';
  if (lastIntro.trim().endsWith(':') || text.includes('|')) {
    activeQ.intro.push(text);
  } else {
    activeQ.intro[activeQ.intro.length - 1] = cleanStr(lastIntro + ' ' + text);
  }
}

function finalise(arr) {
  if (!activeQ) return;
  if (activeQ.subs.length > 0 && !activeQ.stem) {
    const ls = activeQ.subs[activeQ.subs.length - 1];
    for (const sr of STEM_RES) {
      const m = ls.text.match(new RegExp('(.+?)\\s+(' + sr.source + '.*)', 'i'));
      if (m) { ls.text = cleanStr(m[1]); activeQ.stem = cleanStr(m[2]); break; }
    }
  }
  arr.push(activeQ);
}

function parseTest(text) {
  const qs = [];
  activeQ = null;
  parserState = 'SEEKING';

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (isHindi(line) || isSkip(line)) continue;

    const optM = line.match(OPT_RE);
    if (optM) {
      if (!activeQ) continue;
      parserState = 'IN_OPTS';
      activeQ.opts.push({ letter: optM[1].toLowerCase(), text: optM[2].trim() });
      continue;
    }

    const numM = line.match(NUM_RE);
    if (numM) {
      const num = parseInt(numM[1], 10);
      const body = numM[2].trim();
      if (isInstrBody(body)) continue;

      const cls = classifyNum(num);
      if (cls === 'NEW_Q') {
        finalise(qs);
        activeQ = mkQ(num, body);
        activeQ.isPairs = PAIRS_HDR_RE.test(body);
        parserState = 'IN_BODY';
      } else if (cls === 'SUB') {
        if (activeQ) activeQ.subs.push({ num, text: body });
      } else {
        if (activeQ) appendToBody(body);
      }
      continue;
    }

    if (STMT_RE.test(line) || AR_RE.test(line)) {
      if (activeQ) activeQ.stmts.push(line);
      continue;
    }

    if (isStem(line)) {
      if (activeQ) {
        if (activeQ.stem) activeQ.stem = cleanStr(activeQ.stem + ' ' + line);
        else activeQ.stem = line;
      }
      continue;
    }

    if (TBL_HDR_SKIP.test(line)) continue;

    if (activeQ) {
      if (parserState === 'IN_OPTS') {
        const lo = activeQ.opts[activeQ.opts.length - 1];
        if (lo) lo.text = cleanStr(lo.text + ' ' + line);
      } else {
        appendToBody(line);
      }
    }
  }
  finalise(qs);
  return qs;
}

function buildDisplayLines(q) {
  const lines = [];
  for (const il of q.intro) { const s = cleanStr(il); if (s) lines.push(s); }
  for (const st of q.stmts) lines.push(cleanStr(st));
  for (const si of q.subs) {
    lines.push(si.num + '. ' + (q.isPairs ? getPairText(si) : cleanStr(si.text)));
  }
  if (q.stem) lines.push(cleanStr(q.stem));
  return lines;
}

function parseAnswerKey(text) {
  const map = {};
  const reAns = /(\d+)\.\s*Ans\s*[:\-]\s*\(?([a-d])\)?/i;
  const reTable = /(\d+)\.\s*\(([a-d])\)/gi;

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Pattern 1: Explicit Explanation Header (e.g., "1. Ans: (b)")
    const mAns = line.match(reAns);
    if (mAns) {
      map[parseInt(mAns[1], 10)] = mAns[2].toLowerCase();
      continue;
    }

    // Pattern 2: Scorecard/Table Grid Rows (e.g., "1. (b) 26. (a)")
    let mTable;
    while ((mTable = reTable.exec(line)) !== null) {
      map[parseInt(mTable[1], 10)] = mTable[2].toLowerCase();
    }
  }
  return map;
}

function parseExplanations(text) {
  const map = {};
  const allLines = text.split('\n').map(l => l.trim()).filter(l => l && !isHindi(l));
  
  let curNum = null, inExp = false, buf = [];
  const flush = () => { if (curNum && buf.length) map[curNum] = buf.join(' ').replace(/\s+/g, ' ').trim(); };
  const ANS_RE = /^(\d+)\.\s*Ans\s*[:\-]\s*\(([a-dA-D])\)/i;
  const EXP_RE = /^Exp\s*[:\-]/i;

  for (const line of allLines) {
    const am = line.match(ANS_RE);
    if (am) { flush(); curNum = parseInt(am[1], 10); inExp = false; buf = []; continue; }
    if (EXP_RE.test(line)) { inExp = true; const a = line.replace(EXP_RE, '').trim(); if (a) buf.push(a); continue; }
    if (inExp && curNum) buf.push(line);
  }
  flush();
  return map;
}

function generateTxt(qs, answers, exps) {
  return qs.map(q => {
    const body = buildDisplayLines(q);
    let block = `Q${q.num}. ${body[0] || ''}\n`;
    for (let i = 1; i < body.length; i++) block += body[i] + '\n';
    block += '😂\n';
    const ans = answers[q.num] || '';
    for (const opt of q.opts) block += opt.text + (opt.letter === ans ? ' ✅' : '') + '\n';
    const exp = exps[q.num] || '';
    if (exp) block += `Ex: ${exp}\n`;
    return block.trimEnd();
  }).join('\n\n') + '\n';
}

async function parsePW(testBuf, solBuf) {
  try {
    const testText = await getText(testBuf);
    const questions = parseTest(testText);
    if (!questions.length)
      return { text: '', questionCount: 0, matched: 0, hindiSkipped: 0, noAns: 0, answersFound: 0,
        error: 'No English questions found. Ensure PDF has text-based (a)(b)(c)(d) options.' };

    const solText = await getText(solBuf);
    const answers = parseAnswerKey(solText);
    const explanations = parseExplanations(solText);
    const answersFound = Object.keys(answers).length;

    const outText = generateTxt(questions, answers, explanations);
    let matched = 0, noAns = 0;
    for (const q of questions) {
      if (answers[q.num]) matched++; else noAns++;
    }

    return { text: outText, questionCount: questions.length, answersFound, matched, hindiSkipped: 0, noAns };
  } catch (err) {
    console.error('parsePW:', err);
    return { text: '', questionCount: 0, matched: 0, hindiSkipped: 0, noAns: 0, answersFound: 0, error: err.message };
  }
}

module.exports = { parsePW };
