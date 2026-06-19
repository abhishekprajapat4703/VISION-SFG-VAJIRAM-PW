/**
 * VisionIAS 100Q Parser — v2
 * Fixed: uses pdf-parse plain text only. No pagerender/spatial.
 * Anchor-on-(a) method preserved. Vercel-safe.
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

// ─── Noise filter ─────────────────────────────────────────────────────────────
const HF = [
  /visionias/i,/vision\s*ias/i,/www\.visionias/i,/©\s*vision/i,
  /general\s+studies\s*\(p\)/i,/test\s+booklet/i,
  /answers?\s*[&and]*\s*explanations?/i,
  /^https?:\/\//i,/upscpdf\.com/i,/^www\./i,/iasscore/i,
  /time\s+allowed/i,/maximum\s+marks/i,/do\s+not\s+open/i,
  /rough\s+work/i,/invigilator/i,/answer\s+sheet/i,/roll\s+number/i,
  /test\s+booklet\s+series/i,/^\d{1,3}\s*$/,/^[A-D]\s*$/,
  /IMMEDIATELY\s+AFTER/i,/ENCODE\s+CLEARLY/i,
  /this\s+test\s+booklet\s+contains/i,/you\s+have\s+to\s+(mark|enter)/i,
  /all\s+items\s+carry\s+equal/i,/separate\s+answer\s+sheet/i,
  /select\s+the\s+response/i,/each\s+item\s+(is\s+)?printed/i,
];
function isHF(t) { const s = t.trim(); return !s || HF.some(r => r.test(s)); }

// ─── Body parser (Statement I/II, Match-header, sub-items) ───────────────────
const SUBITEM_RE     = /^(\d{1,2})\.\s+(.+)$/;
const MATCH_HDR_RE   = /^[^0-9\(].+\|.+$/;
const MATCH_ROW_RE   = /^(\d{1,2})\.\s+.+\|.+$/;
const STMT1_RE       = /^statement[- ]i\s*:/i;
const STMT2_RE       = /^statement[- ]ii\s*:/i;
const STEM_RE        = /^(which\s+of|how\s+many|select\s+the|choose\s+the|in\s+how\s+many|arrange\s+the|what\s+is\s+the\s+correct|which\s+one\s+of)/i;
const OPT_RE         = /^\(([a-d])\)\s+(.+)$/i;
const QNUM_RE        = /^(\d{1,3})\.\s+(.+)$/;

function isStem(l) { return STEM_RE.test(l) || /\?\s*$/.test(l) || /\bhow\s+many\b/i.test(l); }

function parseBody(rawLines) {
  let main=[], items=[], stem='', mhdr='';
  let state='main', cur='';
  const flush = () => { const t=cur.trim(); if(t) items.push(t); cur=''; };
  for (const raw of rawLines) {
    const l = raw.trim(); if (!l) continue;
    const isMH = MATCH_HDR_RE.test(l) && !SUBITEM_RE.test(l);
    const isMR = MATCH_ROW_RE.test(l);
    const sm   = l.match(SUBITEM_RE);
    const isSb = !isMR && sm && parseInt(sm[1])>=1 && parseInt(sm[1])<=15;
    const isS1 = STMT1_RE.test(l), isS2 = STMT2_RE.test(l);
    if (state==='main') {
      if (isMH && !mhdr) { mhdr=l; state='items'; }
      else if (isSb||isMR||isS1) { state='items'; cur=l; }
      else main.push(l);
    } else if (state==='items') {
      if (isStem(l)) { flush(); stem=l; state='stem'; }
      else if (isMH && !mhdr) { flush(); mhdr=l; }
      else if (isSb||isMR||isS1||isS2) { flush(); cur=l; }
      else cur += ' '+l;
    } else stem += ' '+l;
  }
  flush();
  const mainQ = main.join(' ').replace(/\s{2,}/g,' ').trim();
  const subStem = stem.replace(/\s{2,}/g,' ').trim();
  if (/how\s+many/i.test(mainQ) && items.length && /select\s+the\s+correct\s+answer/i.test(subStem))
    return { mainQ, items, subStem:'How many of the above are correct?', mhdr };
  return { mainQ, items, subStem, mhdr };
}

// ─── Parse test PDF (anchor-on-(a) on plain lines) ────────────────────────────
function parseTestText(fullText) {
  const qMap    = {};
  const allLines = fullText.split('\n').map(l => l.trim()).filter(l => l && !isHF(l));

  // Find every "(a) …" anchor
  const aIdxs = [];
  for (let i = 0; i < allLines.length; i++) {
    const m = allLines[i].match(OPT_RE);
    if (m && m[1].toLowerCase() === 'a') aIdxs.push(i);
  }

  for (let ai = 0; ai < aIdxs.length; ai++) {
    const aIdx = aIdxs[ai];
    // Backtrack to find question number
    const cands = [];
    for (let j = aIdx-1; j >= Math.max(0, aIdx-80); j--) {
      const l  = allLines[j];
      const om = l.match(OPT_RE);
      if (om && om[1].toLowerCase() !== 'a') break;
      const m = l.match(QNUM_RE);
      if (m) { const n=parseInt(m[1]); if(n>=1&&n<=100) cands.push({n,idx:j,text:m[2].trim()}); }
    }
    if (!cands.length) continue;
    const {n:qNum, idx:qIdx, text:qFirst} = cands[cands.length-1];

    // Body lines between question and (a)
    const bodyLines = [qFirst];
    for (let j = qIdx+1; j < aIdx; j++) {
      const l  = allLines[j];
      const om = l.match(OPT_RE);
      if (om && om[1].toLowerCase() !== 'a') break;
      bodyLines.push(l);
    }

    // Collect options
    const opts = [];
    let curOpt = null;
    const nextA  = ai+1 < aIdxs.length ? aIdxs[ai+1] : allLines.length;
    const scanTo = Math.min(nextA, aIdx+40);
    for (let j = aIdx; j < scanTo; j++) {
      const m = allLines[j].match(OPT_RE);
      if (m) {
        if (curOpt) opts.push(curOpt);
        curOpt = { letter: m[1].toLowerCase(), text: m[2].trim() };
        if (m[1].toLowerCase() === 'd') { opts.push(curOpt); curOpt=null; break; }
      } else if (curOpt) {
        if (QNUM_RE.test(allLines[j]) && opts.length<3) break;
        if (aIdxs.includes(j) && j!==aIdx) break;
        curOpt.text += ' '+allLines[j];
      }
    }
    if (curOpt && !opts.find(o=>o.letter===curOpt.letter)) opts.push(curOpt);

    if (opts.length >= 2) {
      const parsed = parseBody(bodyLines);
      if (!qMap[qNum] || opts.length > qMap[qNum].opts.length)
        qMap[qNum] = { parsed, opts };
    }
  }
  return qMap;
}

// ─── Parse solution PDF (Q n.A format) ───────────────────────────────────────
function parseSolText(fullText) {
  const answers={}, explanations={};
  const lines = fullText.split('\n').map(l=>l.trim()).filter(l=>l&&!isHF(l));
  const text  = lines.join('\n');

  // Q 1. A  or  Q1.A
  const markerRe = /^Q\s*(\d{1,3})\s*\.\s*([A-D])\s*$/gm;
  const blocks = [];
  let m;
  while ((m=markerRe.exec(text))!==null)
    blocks.push({num:parseInt(m[1]),letter:m[2].toLowerCase(),start:m.index,end:m.index+m[0].length});

  if (blocks.length < 5) {
    const inlineRe = /\bQ\s*(\d{1,3})\s*\.\s*([A-D])\b/g;
    while ((m=inlineRe.exec(text))!==null) {
      const n=parseInt(m[1]);
      if (n>=1&&n<=100&&!blocks.find(b=>b.num===n))
        blocks.push({num:n,letter:m[2].toLowerCase(),start:m.index,end:m.index+m[0].length});
    }
    blocks.sort((a,b)=>a.start-b.start);
  }

  // Fallback: "1. (a)" pattern in solution
  if (blocks.length < 5) {
    const r2 = /\b(\d{1,3})\.\s*\(([a-d])\)/gi;
    while ((m=r2.exec(text))!==null) {
      const n=parseInt(m[1]);
      if(n>=1&&n<=100&&!blocks.find(b=>b.num===n))
        blocks.push({num:n,letter:m[2].toLowerCase(),start:m.index,end:m.index+m[0].length});
    }
    blocks.sort((a,b)=>a.start-b.start);
  }

  for (const b of blocks) answers[b.num]=b.letter;

  for (let i=0; i<blocks.length; i++) {
    const {num,end} = blocks[i];
    const to = i+1<blocks.length ? blocks[i+1].start : text.length;
    const cl = cleanVisionExpl(text.slice(end,to));
    if (cl.length>10) explanations[num]=cl;
  }
  return { answers, explanations, answersFound: blocks.length };
}

function cleanVisionExpl(raw) {
  let t = raw;
  t = t.replace(/Hence[,\s]+option\s*\(?[a-d]\)?[^.]*\.\s*/gi,'');
  t = t.replace(/Therefore[,\s]+option\s*\(?[a-d]\)?[^.]*\.\s*/gi,'');
  t = t.replace(/Hence\s+the\s+correct\s+(answer|option)[^.]*\.\s*/gi,'');
  t = t.replace(/^(Source|Note|Reference)\s*:[^\n]*/gmi,'');
  t = t.replace(/[●○•▪◆▸▹→‣]/g,'');
  t = t.replace(/^Q\s*\d{1,3}\s*\.\s*[A-D]\s*$/gm,'');
  return t.split('\n').map(l=>l.trim()).filter(l=>l.length>3&&!isHF(l))
    .join(' ').replace(/\s{2,}/g,' ').replace(/\.\s*\./g,'.').trim();
}

// ─── Assemble output ──────────────────────────────────────────────────────────
function buildOutput(qMap, answers, explanations) {
  const nums = Object.keys(qMap).map(Number).sort((a,b)=>a-b);
  const lines=[]; let matched=0,noAns=0,noExpl=0;
  for (const num of nums) {
    const {parsed,opts} = qMap[num];
    const {mainQ,items,subStem,mhdr} = parsed;
    const ans  = answers[num];
    const expl = explanations[num]||'';
    if (!ans) noAns++; if (!expl) noExpl++; if (ans&&expl) matched++;

    if (mainQ) {
      lines.push(`Q${num}.${mainQ}`);
      if (mhdr) lines.push(mhdr);
      items.forEach(it=>lines.push(it));
      if (subStem) lines.push(subStem);
    } else if (subStem) {
      lines.push(`Q${num}.${subStem}`);
      if (mhdr) lines.push(mhdr);
      items.forEach(it=>lines.push(it));
    } else lines.push(`Q${num}.`);

    lines.push('😂');
    for (const lt of ['a','b','c','d']) {
      const o = opts.find(o=>o.letter===lt);
      if (!o) continue;
      const txt = o.text.replace(/\s{2,}/g,' ').replace(/^\s*\(([a-d])\)\s*/i,'').trim();
      lines.push(txt + (ans&&o.letter===ans?' ✅':''));
    }
    lines.push(expl?`Ex: ${expl}`:`Ex: [Not extracted for Q${num}]`);
    lines.push('');
  }
  return { text:lines.join('\n'), total:nums.length, matched, noAns, noExpl };
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function parseVision(testBuf, solBuf) {
  try {
    const testText = await getText(testBuf);
    const qMap     = parseTestText(testText);
    const qCount   = Object.keys(qMap).length;
    if (!qCount)
      return { text:'',questionCount:0,matched:0,noAns:0,noExpl:0,answersFound:0,
        error:'No questions found. Ensure PDF has text-based (a)(b)(c)(d) options.' };

    const solText  = await getText(solBuf);
    const { answers, explanations, answersFound } = parseSolText(solText);

    if (!Object.keys(answers).length)
      return { text:'',questionCount:qCount,matched:0,noAns:qCount,noExpl:qCount,answersFound:0,
        error:'No answers found. Solution PDF should have "Q 1.A" style headers.' };

    const { text, total, matched, noAns, noExpl } = buildOutput(qMap, answers, explanations);
    return { text, questionCount:total, answersFound, matched, noAns, noExpl };
  } catch(err) {
    console.error('parseVision:',err);
    return { text:'',questionCount:0,matched:0,noAns:0,noExpl:0,answersFound:0,error:err.message };
  }
}

module.exports = { parseVision };
