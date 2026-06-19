/**
 * PW Only IAS Parser — v2
 * Fixed: uses pdf-parse plain text. Vercel-safe.
 * Hindi skip, Statement I/II/III, Match-the-Following all preserved.
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

// ─── Hindi detection (Devanagari block U+0900-U+097F) ────────────────────────
function isHindi(line) { return (line.match(/[\u0900-\u097F]/g)||[]).length > 3; }

// ─── PW noise filter ──────────────────────────────────────────────────────────
const PW_NOISE = [
  /^pw\s*(only)?\s*ias/i, /^physics\s+wallah/i, /^pw\.live/i, /^www\.pw/i,
  /^https?:\/\//i, /^\d{1,3}\s*$/, /^series\s*[:\-]/i, /^booklet\s+code/i,
  /^roll\s+no/i, /^time\s+allowed/i, /^maximum\s+marks/i,
];
function isNoise(l) {
  const s = l.trim();
  return !s || s.length <= 1 || PW_NOISE.some(r => r.test(s));
}

// ─── Body parser (Statement I/II/III, Match headers) ─────────────────────────
function parseBodyLines(rawLines) {
  let main=[], items=[], stem='', mhdr='', state='main', cur='';
  const SUBITEM = /^(\d{1,2})\.\s+(.+)$/;
  const STMT1   = /^statement[- ]i\s*:/i;
  const STMT2   = /^statement[- ]ii\s*:/i;
  const STMT3   = /^statement[- ]iii\s*:/i;
  const MH      = /^[^0-9\(].+\|.+$/;
  const MR      = /^(\d{1,2})\.\s+.+\|.+$/;
  const STMW    = /^(which|how\s+many|select\s+the|choose\s+the|arrange\s+the|in\s+how|what\s+is\s+the)/i;
  const flush   = () => { const t=cur.trim(); if(t) items.push(t); cur=''; };
  for (const raw of rawLines) {
    const l = raw.trim(); if (!l||isHindi(l)) continue;
    const isMH=MH.test(l)&&!SUBITEM.test(l), isMR=MR.test(l);
    const sm=l.match(SUBITEM);
    const isSb=!isMR&&sm&&parseInt(sm[1])>=1&&parseInt(sm[1])<=15;
    const isS1=STMT1.test(l),isS2=STMT2.test(l),isS3=STMT3.test(l);
    const isStm=(STMW.test(l)||/\?\s*$/.test(l));
    if (state==='main') {
      if (isMH&&!mhdr) {mhdr=l;state='items';}
      else if (isSb||isMR||isS1) {state='items';cur=l;}
      else main.push(l);
    } else if (state==='items') {
      if (isStm) {flush();stem=l;state='stem';}
      else if (isMH&&!mhdr) {flush();mhdr=l;}
      else if (isSb||isMR||isS1||isS2||isS3) {flush();cur=l;}
      else cur+=' '+l;
    } else stem+=' '+l;
  }
  flush();
  return {
    mainQ: main.join(' ').replace(/\s{2,}/g,' ').trim(),
    items, subStem: stem.replace(/\s{2,}/g,' ').trim(), mhdr,
  };
}

// ─── Parse questions from test PDF ───────────────────────────────────────────
function parseTestText(text) {
  const OPT_PW = /^\(?([a-d])\)?\s+(.+)$/i;
  const QSTART = /^(\d{1,3})\.\s+(.+)$/;

  // Skip Hindi sections
  const rawLines = text.split('\n').map(l => l.trim());
  let   skipHindi = false;
  let   hindiSkipped = 0;
  const lines = [];
  for (const l of rawLines) {
    if (!l || isNoise(l)) continue;
    if (isHindi(l)) { skipHindi = true; hindiSkipped++; continue; }
    if (skipHindi && QSTART.test(l) && /[A-Za-z]/.test(l)) skipHindi = false;
    if (!skipHindi) lines.push(l);
  }

  const questions = [];
  let i = 0;
  while (i < lines.length) {
    const qm = lines[i].match(QSTART);
    if (!qm) { i++; continue; }
    const qNum = parseInt(qm[1], 10);
    if (qNum < 1 || qNum > 300) { i++; continue; }

    // Find (a) anchor within 35 lines
    let aIdx = -1;
    for (let j=i+1; j<Math.min(i+35,lines.length); j++) {
      const om = lines[j].match(OPT_PW);
      if (om && om[1].toLowerCase()==='a') { aIdx=j; break; }
    }
    if (aIdx===-1) { i++; continue; }

    const bodyLines = [qm[2].trim()];
    for (let j=i+1; j<aIdx; j++) {
      if (!isHindi(lines[j])) bodyLines.push(lines[j]);
    }

    // Collect options (a)(b)(c)(d)
    const opts=[]; let curOpt=null;
    for (let j=aIdx; j<Math.min(aIdx+20,lines.length); j++) {
      const om=lines[j].match(OPT_PW);
      if (om) {
        if (curOpt) opts.push(curOpt);
        curOpt={letter:om[1].toLowerCase(),text:om[2].trim()};
        if (om[1].toLowerCase()==='d') {opts.push(curOpt);curOpt=null;break;}
      } else if (curOpt) {
        if (QSTART.test(lines[j])) break;
        curOpt.text+=' '+lines[j];
      }
    }
    if (curOpt&&!opts.find(o=>o.letter===curOpt.letter)) opts.push(curOpt);

    if (opts.length>=2) {
      questions.push({num:qNum,bodyLines,opts});
      i=aIdx+opts.length+1;
    } else i++;
  }
  return { questions, hindiSkipped };
}

// ─── Parse solution PDF ───────────────────────────────────────────────────────
function parseSolText(text) {
  const answers={}, explanations={};

  // Multiple answer patterns
  const patterns = [
    /\b(\d{1,3})\.\s*\(([a-d])\)/gi,
    /\b(\d{1,3})\s*[.)]\s*([a-d])\b/gi,
    /\bAns\.?\s+(\d{1,3})\s*[.)]\s*\(?([a-d])\)?/gi,
  ];
  for (const re of patterns) {
    re.lastIndex=0; let m;
    while ((m=re.exec(text))!==null) {
      const n=parseInt(m[1],10);
      if (n>=1&&n<=300&&!answers[n]) answers[n]=m[2].toLowerCase();
    }
  }

  // Explanation blocks: "Sol. N." or numbered
  const SOLRE = /(?:Sol(?:ution)?|Exp(?:lanation)?|Ans(?:wer)?)\s*\.?\s*(\d{1,3})\s*\.?\s*\n([\s\S]*?)(?=(?:Sol(?:ution)?|Exp(?:lanation)?|Ans(?:wer)?)\s*\.?\s*\d{1,3}|$)/gi;
  let m;
  while ((m=SOLRE.exec(text))!==null) {
    const n=parseInt(m[1],10);
    if (n>=1&&n<=300) {
      const cl=cleanPWExpl(m[2]);
      if (cl.length>10) explanations[n]=cl;
    }
  }
  return { answers, explanations, answersFound: Object.keys(answers).length };
}

function cleanPWExpl(raw) {
  let t=raw;
  t=t.replace(/Hence[,\s]+option\s*\(?[a-d]\)?[^.]*\.\s*/gi,'');
  t=t.replace(/Therefore[,\s]+option\s*\(?[a-d]\)?[^.]*\.\s*/gi,'');
  t=t.replace(/Ans\.?\s*[:\-]?\s*\(?[a-d]\)?\s*/gi,'');
  t=t.replace(/^(Source|Reference|Note)\s*:[^\n]*/gmi,'');
  t=t.replace(/[●○•▪◆▸→]/g,'');
  t=t.replace(/[\u0900-\u097F]+/g,''); // strip Hindi chars
  return t.split('\n').map(l=>l.trim()).filter(l=>l.length>3&&!isNoise(l))
    .join(' ').replace(/\s{2,}/g,' ').replace(/\.\s*\./g,'.').trim();
}

// ─── Assemble output ──────────────────────────────────────────────────────────
function buildOutput(questions, answers, explanations) {
  const lines=[]; let matched=0,noAns=0;
  questions.sort((a,b)=>a.num-b.num);
  for (const q of questions) {
    const {num,bodyLines,opts} = q;
    const ans  = answers[num];
    const expl = explanations[num]||'';
    if (!ans) noAns++; else matched++;

    const {mainQ,items,subStem,mhdr} = parseBodyLines(bodyLines);
    if (mainQ) {
      lines.push(`Q${num}.${mainQ}`);
      if (mhdr) lines.push(mhdr);
      items.forEach(it=>lines.push(it));
      if (subStem) lines.push(subStem);
    } else if (subStem) {
      lines.push(`Q${num}.${subStem}`);
      if (mhdr) lines.push(mhdr);
      items.forEach(it=>lines.push(it));
    } else lines.push(`Q${num}.${bodyLines[0]||''}`);

    lines.push('😂');
    for (const lt of ['a','b','c','d']) {
      const o=opts.find(o=>o.letter===lt);
      if (!o) continue;
      const txt=o.text.replace(/^\s*\(?[a-d]\)?\s*/i,'').replace(/\s{2,}/g,' ').trim();
      lines.push(txt+(ans&&o.letter===ans?' ✅':''));
    }
    lines.push(expl?`Ex: ${expl}`:`Ex: [Not extracted for Q${num}]`);
    lines.push('');
  }
  return { text:lines.join('\n'), matched, noAns };
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function parsePW(testBuf, solBuf) {
  try {
    const testText = await getText(testBuf);
    const { questions, hindiSkipped } = parseTestText(testText);
    if (!questions.length)
      return { text:'',questionCount:0,matched:0,hindiSkipped,noAns:0,answersFound:0,
        error:'No English questions found. Ensure PDF has text-based (a)(b)(c)(d) options.' };

    const solText = await getText(solBuf);
    const { answers, explanations, answersFound } = parseSolText(solText);

    const { text, matched, noAns } = buildOutput(questions, answers, explanations);
    return { text, questionCount:questions.length, answersFound, matched, hindiSkipped, noAns };
  } catch(err) {
    console.error('parsePW:',err);
    return { text:'',questionCount:0,matched:0,hindiSkipped:0,noAns:0,answersFound:0,error:err.message };
  }
}

module.exports = { parsePW };
