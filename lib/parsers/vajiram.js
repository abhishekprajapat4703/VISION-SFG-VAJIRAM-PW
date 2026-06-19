/**
 * Vajiram & Ravi 100Q Parser — v2
 * Fixed: uses pdf-parse plain text only (no pagerender/spatial data).
 * Vercel-safe.
 */

'use strict';

let pdfParse;
try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); }
catch(e) { pdfParse = require('pdf-parse'); }

async function getText(buffer) {
  const data = await pdfParse(buffer);
  if (!data.text || !data.text.trim())
    throw new Error('No text found. PDF may be scanned (image-only) — requires text-based PDF.');
  return data.text;
}

// ─── Noise filter ─────────────────────────────────────────────────────────────
function isNoise(t) {
  const s = t.trim();
  if (!s || s.length <= 1) return true;
  return [
    /^vajiram\s*(&|and)\s*ravi/i, /^www\.vajiramandravi/i, /^copyright/i,
    /^\d{1,3}\s*$/, /^[A-Z]\s*$/, /^page\s+\d+/i,
    /^vajiram/i, /vajiramandravi\.com/i,
    /^for\s+classroom/i, /^target\s+20\d\d/i,
    /^https?:\/\//i,
  ].some(r => r.test(s));
}

// ─── State machine Q parser ───────────────────────────────────────────────────
function parseQuestions(text) {
  const qMap   = {};
  const lines  = text.split('\n').map(l => l.trim()).filter(l => l && !isNoise(l));

  let qId      = null;
  let body     = [];
  let opts     = [];
  let inOpts   = false;

  function flush() {
    if (qId === null) return;
    if (opts.length >= 2) {
      if (!qMap[qId] || opts.length > qMap[qId].opts.length)
        qMap[qId] = { id: qId, body: [...body], opts: [...opts] };
    }
    qId = null; body = []; opts = []; inOpts = false;
  }

  for (const line of lines) {
    // Option: "(a) text"
    const om = line.match(/^\(([a-d])\)\s+(.+)$/i);
    if (om && qId !== null) {
      inOpts = true;
      opts.push({ letter: om[1].toLowerCase(), text: om[2].trim() });
      continue;
    }
    // Question start: "N. text" (N = 1-100)
    const qm = line.match(/^(\d{1,3})\.\s+(.+)$/);
    if (qm) {
      const n = parseInt(qm[1], 10);
      if (n >= 1 && n <= 100) {
        // Distinguish statement lists (1. 2. 3. inside a Q) from new questions
        const isInternal = qId !== null && !inOpts && n <= 6 && n !== qId + 1;
        if (!isInternal) {
          flush();
          qId  = n;
          body = [qm[2].trim()];
          continue;
        }
      }
    }
    // Option continuation
    if (inOpts && opts.length > 0) {
      if (!/^\(([a-d])\)/i.test(line)) { opts[opts.length-1].text += ' ' + line; }
      continue;
    }
    if (qId !== null && !inOpts) body.push(line);
  }
  flush();
  return qMap;
}

// ─── Answer + explanation from solution PDF ───────────────────────────────────
function parseSolution(text) {
  const answers     = {};
  const explanations = {};

  // Answer key: "1. (a)" or "1.(a)"
  const keyRe = /\b(\d{1,3})\.\s*\(([a-d])\)/gi;
  let m;
  while ((m = keyRe.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 100 && !answers[n]) answers[n] = m[2].toLowerCase();
  }

  // Fallback: "1. A" or "1. (A)"
  if (Object.keys(answers).length < 5) {
    const r2 = /^\s*(\d{1,3})\s*[.)]\s*\(?([a-d])\)?$/gim;
    while ((m = r2.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 100 && !answers[n]) answers[n] = m[2].toLowerCase();
    }
  }

  // Explanations: split on "\nQ<n>.\n" blocks
  const blockRe = /\nQ(\d{1,3})\.\s*\n/g;
  const blocks  = [];
  while ((m = blockRe.exec(text)) !== null)
    blocks.push({ n: parseInt(m[1],10), from: m.index + m[0].length });
  for (let i = 0; i < blocks.length; i++) {
    const { n, from } = blocks[i];
    const to  = i+1 < blocks.length ? blocks[i+1].from : text.length;
    explanations[n] = cleanExpl(text.slice(from, to));
  }

  return { answers, explanations };
}

function cleanExpl(raw) {
  let t = raw;
  t = t.replace(/^Answer\s*:\s*[a-d]\s*$/gmi, '');
  t = t.replace(/^Explanation\s*:\s*$/gmi, '');
  t = t.replace(/Therefore[,\s]+option\s*\([a-d]\)[^.\n]*/gi, '');
  t = t.replace(/So[,\s]+option\s*\([a-d]\)[^.\n]*/gi, '');
  t = t.replace(/^(?:Source|Ref|Reference)\s*:[^\n]*/gmi, '');
  t = t.replace(/[●○•▪◆▸▹→\-–—]+/g, '');
  t = t.replace(/^Q\d{1,3}\.\s*/gm, '');
  const lines = t.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  return lines.join(' ').replace(/\s{2,}/g,' ').replace(/\.\s*\./g,'.').trim();
}

// ─── Roman numeral normalizer ─────────────────────────────────────────────────
const RMAP = {I:1,II:2,III:3,IV:4,V:5,VI:6,VII:7,VIII:8,IX:9,X:10,XI:11,XII:12};
function normRoman(l) {
  return l.replace(/^\s*(I{1,3}|IV|V?I{0,3}|IX|XI{0,3})\.\s+/i, (m, r) => {
    const n = RMAP[r.toUpperCase()]; return n ? n + '. ' : m;
  });
}

function smartJoin(rawLines) {
  const norm = rawLines.map(l => normRoman(l.trim())).filter(Boolean);
  if (!norm.length) return [];
  const NEW_RE = [
    /^\d{1,2}\.\s+\S/,
    /^Statement\s+[IVXLC]+\s*:/i,
    /^(Which|How\s+many|What|Select|Arrange|In\s+how|Who\s+|Where\s+|Among\s+|Identify|Of\s+the|With\s+reference|Consider|Regarding|According\s+to)/i,
  ];
  const out = []; let buf = '';
  for (let i = 0; i < norm.length; i++) {
    const l = norm[i];
    const isNew = i === 0 || NEW_RE.some(r => r.test(l));
    if (isNew) { if (buf) out.push(buf.replace(/\s{2,}/g,' ').trim()); buf = l; }
    else buf = (buf + ' ' + l).replace(/\s{2,}/g,' ');
  }
  if (buf) out.push(buf.replace(/\s{2,}/g,' ').trim());
  return out;
}

function unpackOpts(rawOpts) {
  const s   = rawOpts.map(o => `(${o.letter}) ${o.text}`).join(' ');
  const get = (re) => { const m = s.match(re); return m ? m[1].replace(/^\s*\(?[a-d]\)?\s*\.?\s*/i,'').trim() : ''; };
  return [
    { letter:'a', text: get(/\(a\)\s*([\s\S]*?)(?=\s*\(b\)|$)/i) || 'Only one' },
    { letter:'b', text: get(/\(b\)\s*([\s\S]*?)(?=\s*\(c\)|$)/i) || 'Only two' },
    { letter:'c', text: get(/\(c\)\s*([\s\S]*?)(?=\s*\(d\)|$)/i) || 'Only three' },
    { letter:'d', text: get(/\(d\)\s*([\s\S]*?)$/i)              || 'All four' },
  ];
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function parseVajiram(testBuf, solBuf) {
  try {
    const testText = await getText(testBuf);
    const solText  = await getText(solBuf);

    const qMap  = parseQuestions(testText);
    const qKeys = Object.keys(qMap).map(Number).sort((a,b) => a-b);
    if (!qKeys.length)
      return { text:'', questionCount:0, answersMatched:0, answersFound:0,
        error:'No questions found. Ensure Test PDF is text-based with (a)(b)(c)(d) options.' };

    const { answers, explanations } = parseSolution(solText);
    const answersFound = Object.keys(answers).length;

    const lines = [];
    let matched = 0, noAns = 0, noExpl = 0;
    for (const k of qKeys) {
      const q     = qMap[k];
      const ans   = answers[k];
      const expl  = explanations[k] || '';
      if (ans) matched++; else noAns++;
      if (!expl) noExpl++;

      const parts = smartJoin(q.body);
      lines.push(`Q${k}. ${parts[0] || ''}`);
      for (let i = 1; i < parts.length; i++) lines.push(parts[i]);
      lines.push('😂');
      const opts = unpackOpts(q.opts);
      for (const o of opts) {
        lines.push(o.text + (ans && o.letter === ans ? ' ✅' : ''));
      }
      lines.push(expl ? `Ex: ${expl}` : `Ex: [Not found for Q${k}]`);
      lines.push('');
    }

    return {
      text:           lines.join('\n'),
      questionCount:  qKeys.length,
      answersFound,
      answersMatched: matched,
      matched,
      noAns,
      noExpl,
    };
  } catch (err) {
    console.error('parseVajiram:', err);
    return { text:'', questionCount:0, answersMatched:0, answersFound:0, error: err.message };
  }
}

module.exports = { parseVajiram };
