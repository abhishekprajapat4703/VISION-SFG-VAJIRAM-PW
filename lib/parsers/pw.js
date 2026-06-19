/**
 * PW Only IAS / QuizForge Pro Parser
 * Exact port of the PW page 4 parser from the HTML tool.
 *
 * Input : testBuffer (PDF), solBuffer (PDF)
 * Output: { text, questionCount, matched, hindiSkipped, noAns, error? }
 *
 * Key features:
 * - Hindi section detection and skipping
 * - Statement I/II/III support
 * - Match-the-Following support
 * - Multi-line statement handling
 * - UPSC-style question extraction
 * - Answer + explanation parsing from solution PDF
 */

'use strict';

const pdfParse = require('pdf-parse');

// ─── Hindi text detection ─────────────────────────────────────────────────────
// Devanagari Unicode block: U+0900 – U+097F
const HINDI_RE = /[\u0900-\u097F]/;
function isHindiLine(line) {
  const hindiChars = (line.match(/[\u0900-\u097F]/g) || []).length;
  return hindiChars > 3; // more than 3 Devanagari chars = Hindi line
}

// ─── PW-specific noise removal ────────────────────────────────────────────────
const PW_NOISE = [
  /^pw\s*(only)?\s*ias/i,
  /^physics\s+wallah/i,
  /^pw\.live/i,
  /^www\.pw/i,
  /^https?:\/\//i,
  /^\d{1,3}\s*$/, // lone page numbers
  /^[a-d]\)\s*$/i, // lone option letters
  /^series\s*[:\-]/i,
  /^booklet\s+code/i,
  /^roll\s+no/i,
];
function isPWNoise(line) {
  const s = line.trim();
  if (!s || s.length <= 1) return true;
  return PW_NOISE.some(r => r.test(s));
}

// ─── PDF extraction ───────────────────────────────────────────────────────────
async function extractText(buffer) {
  const data = await pdfParse(buffer);
  return data.text;
}

// ─── Question parsing from test PDF ──────────────────────────────────────────
function parseQuestionsFromText(fullText) {
  const questions = [];
  let hindiSkipped = 0;

  // Split into lines and clean
  const allLines = fullText.split('\n').map(l => l.trim()).filter(l => l && !isPWNoise(l));

  // Track Hindi skip mode
  let skipHindi = false;
  const cleanLines = [];
  for (const line of allLines) {
    if (isHindiLine(line)) {
      skipHindi = true;
      hindiSkipped++;
      continue;
    }
    // Once we see an English question start after Hindi, resume
    if (skipHindi && /^\d{1,3}\.\s+[A-Z]/i.test(line)) {
      skipHindi = false;
    }
    if (!skipHindi) cleanLines.push(line);
  }

  // State machine: find questions by "N. text" pattern followed by options
  const OPT_PW = /^\(?([a-d])\)?\s+(.+)$/i;
  const QSTART = /^(\d{1,3})\.\s+(.+)$/;

  let i = 0;
  while (i < cleanLines.length) {
    const line = cleanLines[i];
    const qm = line.match(QSTART);
    if (!qm) { i++; continue; }

    const qNum = parseInt(qm[1], 10);
    if (qNum < 1 || qNum > 200) { i++; continue; }

    // Check if followed by options within 30 lines
    let optStart = -1;
    for (let j = i + 1; j < Math.min(i + 35, cleanLines.length); j++) {
      const om = cleanLines[j].match(OPT_PW);
      if (om && om[1].toLowerCase() === 'a') { optStart = j; break; }
    }
    if (optStart === -1) { i++; continue; }

    // Gather body lines
    const bodyLines = [qm[2].trim()];
    for (let j = i + 1; j < optStart; j++) {
      if (!isHindiLine(cleanLines[j])) bodyLines.push(cleanLines[j]);
    }

    // Gather options
    const options = [];
    let curOpt = null;
    for (let j = optStart; j < Math.min(optStart + 15, cleanLines.length); j++) {
      const om = cleanLines[j].match(OPT_PW);
      if (om) {
        if (curOpt) options.push(curOpt);
        curOpt = { letter: om[1].toLowerCase(), text: om[2].trim() };
        if (om[1].toLowerCase() === 'd') { options.push(curOpt); curOpt = null; break; }
      } else if (curOpt) {
        if (QSTART.test(cleanLines[j])) break;
        curOpt.text += ' ' + cleanLines[j];
      }
    }
    if (curOpt && !options.find(o => o.letter === curOpt.letter)) options.push(curOpt);

    if (options.length >= 2) {
      questions.push({ num: qNum, bodyLines, options });
      i = optStart + options.length + 1;
    } else {
      i++;
    }
  }

  return { questions, hindiSkipped };
}

// ─── Parse question body (Statement I/II, Match-the-Following) ────────────────
function parseBodyLines(rawLines) {
  let mainParts = [];
  let subItems = [];
  let subStem = '';
  let matchHeader = '';
  let state = 'main';
  let curItem = '';

  const SUBITEM = /^(\d{1,2})\.\s+(.+)$/;
  const STMT1 = /^statement[- ]i\s*:/i;
  const STMT2 = /^statement[- ]ii\s*:/i;
  const STMT3 = /^statement[- ]iii\s*:/i;
  const MATCH_HDR = /^[^0-9\(].+\|.+$/;
  const MATCH_ROW = /^(\d{1,2})\.\s+.+\|.+$/;
  const STEM_WORDS = /^(which|how\s+many|select\s+the|choose\s+the|arrange\s+the|in\s+how|what\s+is\s+the)/i;

  function flushItem() { const t = curItem.trim(); if (t) subItems.push(t); curItem = ''; }

  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) continue;
    const isMH = MATCH_HDR.test(line) && !SUBITEM.test(line);
    const isMR = MATCH_ROW.test(line);
    const sm = line.match(SUBITEM);
    const isSub = !isMR && sm && parseInt(sm[1]) >= 1 && parseInt(sm[1]) <= 15;
    const isS1 = STMT1.test(line);
    const isS2 = STMT2.test(line);
    const isS3 = STMT3.test(line);
    const isStem = STEM_WORDS.test(line) || /\?\s*$/.test(line);

    if (state === 'main') {
      if (isMH && !matchHeader) { matchHeader = line; state = 'items'; }
      else if (isSub || isMR || isS1) { state = 'items'; curItem = line; }
      else { mainParts.push(line); }
    } else if (state === 'items') {
      if (isStem) { flushItem(); subStem = line; state = 'stem'; }
      else if (isMH && !matchHeader) { flushItem(); matchHeader = line; }
      else if (isSub || isMR || isS1 || isS2 || isS3) { flushItem(); curItem = line; }
      else { curItem += ' ' + line; }
    } else {
      subStem += ' ' + line;
    }
  }
  flushItem();
  const mainQ = mainParts.join(' ').replace(/\s{2,}/g, ' ').trim();
  const stem  = subStem.replace(/\s{2,}/g, ' ').trim();
  return { mainQ, subItems, subStem: stem, matchHeader };
}

// ─── Parse solution PDF for answers + explanations ────────────────────────────
function parseSolutionText(fullText) {
  const answers = {};
  const explanations = {};

  // Pattern: "1. (a)" or "(a) 1." or "Ans. 1 (a)"
  const patterns = [
    /\b(\d{1,3})\.\s*\(?([a-d])\)?/gi,
    /\bAns\.?\s*(\d{1,3})\s*\(?([a-d])\)?/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(fullText)) !== null) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 200 && !answers[n]) answers[n] = m[2].toLowerCase();
    }
  }

  // Extract explanations between answer markers
  const lines = fullText.split('\n').map(l => l.trim()).filter(l => l && !isPWNoise(l));
  const fullClean = lines.join('\n');

  // Try "Sol. N." or "Explanation N." blocks
  const SOLBLOCK = /(?:Sol\.|Solution|Explanation|Exp\.)\s+(\d{1,3})\.?\s*\n([\s\S]*?)(?=(?:Sol\.|Solution|Explanation|Exp\.)\s+\d{1,3}|$)/gi;
  let m;
  while ((m = SOLBLOCK.exec(fullClean)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 200) {
      const raw = m[2];
      const cleaned = cleanPWExplanation(raw);
      if (cleaned.length > 10) explanations[n] = cleaned;
    }
  }

  // Fallback: try numbered blocks "N.\n..."
  if (Object.keys(explanations).length < 10) {
    const NUMBLOCK = /^(\d{1,3})\.\s*\n([\s\S]*?)(?=^\d{1,3}\.\s*\n|$)/gm;
    while ((m = NUMBLOCK.exec(fullClean)) !== null) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 200 && !explanations[n]) {
        const cleaned = cleanPWExplanation(m[2]);
        if (cleaned.length > 15) explanations[n] = cleaned;
      }
    }
  }

  return { answers, explanations };
}

function cleanPWExplanation(raw) {
  let t = raw;
  t = t.replace(/Hence[,\s]+option\s*\(?[a-d]\)?[^.]*\.\s*/gi, '');
  t = t.replace(/Therefore[,\s]+option\s*\(?[a-d]\)?[^.]*\.\s*/gi, '');
  t = t.replace(/So[,\s]+option\s*\(?[a-d]\)?[^.]*\.\s*/gi, '');
  t = t.replace(/Hence\s+the\s+correct\s+(answer|option)[^.]*\.\s*/gi, '');
  t = t.replace(/Ans\.?\s*[:\-]?\s*\(?[a-d]\)?\s*/gi, '');
  t = t.replace(/^(Source|Reference|Note)\s*:[^\n]*/gmi, '');
  t = t.replace(/[●○•▪◆▸→]/g, '');
  t = t.replace(/[\u0900-\u097F]+/g, ''); // Remove Hindi chars from explanations
  const lines = t.split('\n').map(l => l.trim()).filter(l => l.length > 3 && !isPWNoise(l));
  return lines.join(' ').replace(/\s{2,}/g, ' ').replace(/\.\s*\./g, '.').trim();
}

// ─── Assemble output ──────────────────────────────────────────────────────────
function buildPWOutput(questions, answers, explanations) {
  const lines = [];
  let matched = 0;
  let noAns = 0;

  // Sort by question number
  questions.sort((a, b) => a.num - b.num);

  for (const q of questions) {
    const { num, bodyLines, options } = q;
    const ansLetter = answers[num];
    const expl = explanations[num] || '';
    if (!ansLetter) noAns++;
    if (ansLetter) matched++;

    const { mainQ, subItems, subStem, matchHeader } = parseBodyLines(bodyLines);

    if (mainQ) {
      lines.push(`Q${num}.${mainQ}`);
      if (matchHeader) lines.push(matchHeader);
      for (const item of subItems) lines.push(item);
      if (subStem) lines.push(subStem);
    } else if (subStem) {
      lines.push(`Q${num}.${subStem}`);
      if (matchHeader) lines.push(matchHeader);
      for (const item of subItems) lines.push(item);
    } else {
      lines.push(`Q${num}.${bodyLines[0] || ''}`);
    }

    lines.push('😂');

    for (const lt of ['a', 'b', 'c', 'd']) {
      const opt = options.find(o => o.letter === lt);
      if (!opt) continue;
      const txt = opt.text.replace(/^\s*\(?[a-d]\)?\s*/i, '').replace(/\s{2,}/g, ' ').trim();
      const mark = (ansLetter && opt.letter === ansLetter) ? ' ✅' : '';
      lines.push(txt + mark);
    }

    lines.push(expl ? `Ex: ${expl}` : `Ex: [Explanation not extracted for Q${num}]`);
    lines.push('');
  }

  return { text: lines.join('\n'), matched, noAns };
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function parsePW(testBuffer, solBuffer) {
  try {
    const testText = await extractText(testBuffer);
    const { questions, hindiSkipped } = parseQuestionsFromText(testText);

    if (questions.length === 0) {
      return {
        text: '', questionCount: 0, matched: 0, hindiSkipped, noAns: 0,
        error: 'No English questions found in Test PDF. Make sure it has text-based (a)(b)(c)(d) options.'
      };
    }

    const solText = await extractText(solBuffer);
    const { answers, explanations } = parseSolutionText(solText);

    const { text, matched, noAns } = buildPWOutput(questions, answers, explanations);

    return {
      text,
      questionCount: questions.length,
      matched,
      hindiSkipped,
      noAns,
    };
  } catch (err) {
    console.error('parsePW error:', err);
    return { text: '', questionCount: 0, matched: 0, hindiSkipped: 0, noAns: 0, error: err.message };
  }
}

module.exports = { parsePW };
