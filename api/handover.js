import zlib from 'node:zlib';
import { createClient } from '@supabase/supabase-js';
// Import the library file directly: in some pdf-parse 1.1.x releases the package
// entry point runs a debug self-test when it isn't require()d from CommonJS.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { extractText as unpdfExtractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

export const config = { maxDuration: 300 };

// Token limit safety — truncate text if too long (~150k chars ≈ ~37k tokens, safe buffer)
const MAX_CHARS_PER_BUCKET = 150000;

// A document with less readable text than this is treated as unreadable and skipped
const MIN_TEXT_CHARS = 50;

// Per-file extraction limit so one pathological file can't eat the 300s budget
const EXTRACTION_TIMEOUT_MS = 60000;

function truncateText(text, maxChars = MAX_CHARS_PER_BUCKET) {
  if (text.length <= maxChars) return text;
  // Re-sanitize so the cut can't leave half a surrogate pair behind
  return sanitizeText(text.slice(0, maxChars)) + '\n\n[Document truncated due to length — remaining content omitted]';
}

// ── SYSTEM PROMPTS ──────────────────────────────────────────────────────────

const PROMPT_FUND_DOCS = `You are the Verivest Handover Brief Agent analyzing fund documents for a new client handover.

Read the form data and any uploaded fund documents (PPM, operating agreement, subscription docs, financials, prior admin documents, Agora setup docs) and produce TWO sections:

---

WARNINGS
Check for these conditions and output a warning block for each triggered. Skip entirely if none triggered.

- AGORA MIGRATION — NO EFFECTIVE DATE: Agora migration in scope but no effective date set
- MID-CYCLE START: Client starting mid-quarter or mid-year, prior-period catch-up may be needed
- GREENFIELD WITH NEAR-TERM DEADLINE: Greenfield deal with any deadline or investor close date mentioned
- ACCRUED OR UNRESOLVED ITEMS: Any open accounting issue, arrears, or unreconciled items in any document
- NON-STANDARD TERMS IN DOCUMENTS: Any term in uploaded contracts or PPMs that differs from what was entered in the form
- ACCOUNTING FLAG: Anything Accounting needs to know — unusual fee structures, complex waterfall, accruals, audit issues, prior period adjustments, unusual investor structures
- MISSING EFFECTIVE DATE (BROWNFIELD): Entity type is Brownfield but no effective date of first accounting period is set

Format each warning as:
⚠️ [WARNING TYPE]
One sentence explaining what was flagged, which document it came from if relevant, and why it matters.

---

DOCUMENT STATUS
List each document and its status from the form. Use exactly this format:

- PPM: [Final / Draft / Unknown / Not Applicable]
- Operating Agreement: [Final / Draft / Unknown / Not Applicable]
- Subscription Agreement: [Final / Draft / Unknown / Not Applicable]
- Offering Memorandum / Pitch Deck: [Final / Draft / Unknown / Not Applicable]
- EIN / SS-4 Letter: [Final / Draft / Unknown / Not Applicable]
- Financials (brownfield): [Final / Draft / Unknown / Not Applicable]
- Other: [status or Not Applicable]

If Egnyte folder link provided: Egnyte Folder: [link]
If uploaded documents provided: Uploaded Fund Documents: [list filenames]

RULES:
- Focus on accounting flags, document gaps, and structural complexity
- Do not reproduce data already in ClickUp custom fields
- Be concise and specific`;

const PROMPT_TRANSCRIPTS = `You are the Verivest Handover Brief Agent analyzing sales call transcripts for a new client handover.

Transcripts are your primary source. The form fields are a starting point — the transcripts are the truth. Read every transcript carefully and produce ONE section:

---

CLIENT CONTEXT
Write 3-5 paragraphs in plain English. No bullet points. No headers within this section.

Cover the following, pulling from transcripts first, form fields second:

1. WHAT THE CLIENT IS TRYING TO ACCOMPLISH
Why did they come to Verivest? What problem are they solving? What does success look like for them? Use the client's own words and framing from transcripts where possible.

2. WHAT THEY ARE LEAVING BEHIND
What failed with their prior admin, accountant, or internal process? What frustrated them? What do they never want to experience again? Clients say things on calls they don't write in forms — surface those.

3. PROMISES AND COMMITMENTS MADE
This is the most critical part. Read every transcript for any commitment made by the Verivest Sales rep — verbal promises about timelines, turnaround times, deliverables, pricing, service inclusions, or anything starting with "we'll", "we can", "I'll make sure", "you'll have", "we'll take care of", "don't worry about". If the form says "none" but transcripts contain commitments, transcripts win. List every commitment found, attributed to which call it came from.

4. HOW THE CLIENT WANTS THIS TO FEEL
Communication style, responsiveness expectations, hands-on vs hands-off preference, what makes them anxious. Read the tone — is the client rushed? Skeptical? Detail-oriented? This tells Onboarding how to show up on the first call.

5. SENSITIVITY FLAGS
Anything Onboarding should know before the first call not obvious from the form — things mentioned in passing, investor dynamics, timeline pressures, relationship context.

After the CLIENT CONTEXT section, always append this section:

---

EXTRACTED FIELDS
Key Promises: [List every specific commitment or promise made by Verivest Sales in the transcripts, one per line. If none found write "None identified in transcripts."]
Scope of Services: [Summarize the agreed scope of services as discussed in transcripts and form — what Verivest is specifically doing for this client. 2-3 sentences max.]

RULES:
- Transcripts always win over form fields if they conflict — note both and flag the discrepancy
- Never invent commitments — only flag what is explicitly stated
- Do not reproduce structured data already in ClickUp fields
- Do not pad or repeat information
- Tone: plain English, written for a colleague preparing for a first client call`;

const PROMPT_SYNDICATION = `You are the Verivest Handover Brief Agent analyzing syndication documents for a new client handover.

Read the uploaded syndication documents and form data and produce ONE section:

---

SYNDICATION NOTES
Write a concise summary covering:

1. Syndication structure — new or existing, key terms, investor count if mentioned
2. Any non-standard syndication terms or structures found in the documents
3. Flags for Onboarding or Accounting — anything unusual about the syndication structure, fee arrangements, or investor dynamics
4. Any commitments or promises made specifically about the syndication setup

Format as plain English paragraphs. Flag anything that deviates from standard Verivest syndication admin.

RULES:
- Be specific and concise
- Flag anything Onboarding or Accounting needs to know before kickoff
- Do not reproduce data already in ClickUp fields`;

// ── TEXT EXTRACTION ─────────────────────────────────────────────────────────

// Remove characters that break the Claude API request or add noise: lone UTF-16
// surrogates (invalid JSON for the API), control chars, replacement chars, and
// runs of whitespace left behind by PDF layout.
function sanitizeText(text) {
  if (!text) return '';
  let s = String(text);
  s = typeof s.toWellFormed === 'function'
    ? s.toWellFormed()
    : s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F�￾￿]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// Text is usable if it has enough characters and is mostly real letters/digits
// (PDFs with broken font maps often "extract" as symbol soup).
function isUsableText(text) {
  if (!text || text.length < MIN_TEXT_CHARS) return false;
  const visible = text.replace(/\s/g, '');
  const alnum = (visible.match(/[\p{L}\p{N}]/gu) || []).length;
  return alnum >= MIN_TEXT_CHARS && alnum / visible.length >= 0.4;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

// Decode a PDF literal string body: \n \r \t \b \f \( \) \\ \ddd and line continuations.
function unescapePdfString(s) {
  return s.replace(/\\(\r\n|\r|\n|[0-7]{1,3}|.)/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === 't') return '\t';
    if (c === 'b' || c === 'f') return '';
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    if (c[0] === '\r' || c[0] === '\n') return '';
    return c;
  });
}

// Pull text-showing operators (Tj, TJ, ', ") out of a PDF content stream.
function textFromContentStream(content) {
  const out = [];
  const opRe = /\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|\b(T\*|Td|TD|ET)\b/g;
  let m;
  while ((m = opRe.exec(content))) {
    if (m[1] !== undefined) {
      const parts = [];
      const partRe = /\(((?:\\.|[^\\)])*)\)|(-?\d+(?:\.\d+)?)/g;
      let p;
      while ((p = partRe.exec(m[1]))) {
        if (p[1] !== undefined) parts.push(unescapePdfString(p[1]));
        else if (parseFloat(p[2]) <= -200) parts.push(' ');
      }
      out.push(parts.join(''));
    } else if (m[2] !== undefined) {
      out.push(unescapePdfString(m[2]));
    } else {
      out.push('\n');
    }
  }
  return out.join('').replace(/[ \t]*\n[ \t]*/g, '\n');
}

function decodeAscii85(str) {
  const data = str.replace(/^<~/, '').replace(/~>[\s\S]*$/, '').replace(/\s/g, '');
  const out = [];
  let group = [];
  for (const ch of data) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) {
      const n = group.reduce((acc, d) => acc * 85 + d, 0);
      out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const pad = 5 - group.length;
    const n = [...group, 84, 84, 84, 84].slice(0, 5).reduce((acc, d) => acc * 85 + d, 0);
    out.push(...[(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].slice(0, 4 - pad));
  }
  return Buffer.from(out);
}

// Last-resort PDF extraction: inflate every stream and scan for text operators.
// Works on PDFs whose structure the parsers reject (bad xref, truncated files)
// as long as the content isn't encrypted or font-encoded.
function extractRawPdfText(buffer) {
  const src = buffer.toString('latin1');
  const chunks = [];
  const streamRe = /stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end === -1) break;
    let raw = buffer.subarray(start, end);
    const dict = src.slice(Math.max(0, m.index - 400), m.index);
    const filters = dict.slice(dict.lastIndexOf('<<'));
    if (filters.includes('/ASCII85Decode') || filters.includes('/A85')) {
      raw = decodeAscii85(raw.toString('latin1'));
    } else if (filters.includes('/ASCIIHexDecode') || filters.includes('/AHx')) {
      raw = Buffer.from(raw.toString('latin1').replace(/[^0-9a-f]/gi, ''), 'hex');
    }
    let content = null;
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        content = inflate(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1');
        break;
      } catch { /* not this encoding */ }
    }
    chunks.push(textFromContentStream(content ?? raw.toString('latin1')));
    streamRe.lastIndex = end;
  }
  let text = chunks.filter(Boolean).join('\n');
  if (!text.trim()) text = textFromContentStream(src);
  return text;
}

// Try each PDF strategy in order, stopping at the first one that yields usable text.
async function extractPdf(buffer) {
  const attempts = [];

  const strategies = [
    ['pdf-parse', async () => (await pdfParse(buffer)).text],
    ['pdf.js', async () => {
      // unpdf transfers the array's buffer to pdf.js, so hand it a copy
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      try {
        return (await unpdfExtractText(pdf, { mergePages: true })).text;
      } finally {
        pdf.destroy?.();
      }
    }],
    ['raw', async () => extractRawPdfText(buffer)],
  ];

  for (const [method, run] of strategies) {
    try {
      const text = sanitizeText(await run());
      if (isUsableText(text)) return { text, method };
      attempts.push(`${method}: ${text.length ? 'unreadable text' : 'no text'}`);
    } catch (err) {
      const msg = err?.name === 'PasswordException' ? 'password-protected' : (err?.message || String(err));
      attempts.push(`${method}: ${msg}`);
      if (err?.name === 'PasswordException') break; // no strategy can read a locked file
    }
  }

  console.warn(`[extract] PDF strategies exhausted: ${attempts.join('; ')}`);
  const locked = attempts.some(a => a.includes('password-protected'));
  throw new Error(locked
    ? 'PDF is password-protected'
    : 'no readable text found (likely a scanned image or unsupported font encoding)');
}

async function extractSingle(buffer, filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'pdf') return extractPdf(buffer);
  if (ext === 'docx') return { text: (await mammoth.extractRawText({ buffer })).value, method: 'mammoth' };
  if (ext === 'txt' || ext === 'csv' || ext === 'md') return { text: buffer.toString('utf-8'), method: 'text' };
  if (ext === 'xlsx' || ext === 'xls') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const text = workbook.SheetNames.map(name => {
      const sheet = workbook.Sheets[name];
      return `Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`;
    }).join('\n\n');
    return { text, method: 'xlsx' };
  }
  if (ext === 'pptx') {
    const zip = await JSZip.loadAsync(buffer);
    const slideNum = f => parseInt(f.match(/slide(\d+)\.xml/)[1], 10);
    const slideFiles = Object.keys(zip.files)
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => slideNum(a) - slideNum(b));
    const texts = await Promise.all(slideFiles.map(async f => {
      const xml = await zip.files[f].async('string');
      return xml.replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
    }));
    return { text: texts.join('\n\n'), method: 'pptx' };
  }
  throw new Error(`unsupported file type (.${ext})`);
}

// Returns one result per readable document: { name, text, error }.
// ZIPs are expanded so each file inside is reported (and skipped) individually.
async function extractFile(buffer, filename, depth = 0) {
  const ext = filename.split('.').pop().toLowerCase();

  if (ext === 'zip') {
    if (depth > 1) return [{ name: filename, text: '', error: 'nested ZIP too deep' }];
    let zip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch (err) {
      return [{ name: filename, text: '', error: `could not open ZIP: ${err.message}` }];
    }
    const entries = Object.keys(zip.files).filter(f => {
      const base = f.split('/').pop();
      return !zip.files[f].dir && !f.startsWith('__MACOSX/') && base && !base.startsWith('.');
    });
    if (!entries.length) return [{ name: filename, text: '', error: 'ZIP is empty' }];
    const nested = await Promise.all(entries.map(async entry => {
      const entryBuffer = Buffer.from(await zip.files[entry].async('arraybuffer'));
      const results = await extractFile(entryBuffer, entry.split('/').pop(), depth + 1);
      return results.map(r => ({ ...r, name: `${filename} → ${r.name}` }));
    }));
    return nested.flat();
  }

  try {
    const { text, method } = await withTimeout(extractSingle(buffer, filename), EXTRACTION_TIMEOUT_MS, 'extraction');
    const clean = sanitizeText(text);
    if (!isUsableText(clean)) {
      return [{ name: filename, text: '', error: clean.length ? `too little readable text (${clean.length} chars)` : 'no text found' }];
    }
    console.log(`[extract] ${filename}: ${clean.length} chars via ${method}`);
    return [{ name: filename, text: clean }];
  } catch (err) {
    return [{ name: filename, text: '', error: err.message || String(err) }];
  }
}

// ── DUPLICATE DETECTION ─────────────────────────────────────────────────────

// Two extracted documents count as duplicates when their word-trigram sets
// overlap at least this much (Jaccard). PDF and DOCX copies of the same
// agreement differ slightly (headers, page numbers, hyphenation), so this is
// deliberately below 1 but high enough that drafts with real edits stay apart.
const DUPLICATE_SIMILARITY = 0.7;

function trigramSet(text) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const set = new Set();
  for (let i = 0; i + 3 <= words.length; i++) set.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size / large.size < DUPLICATE_SIMILARITY) return 0; // sizes too different to reach the threshold
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// Backstop for the upload-time duplicate prompt: drops documents whose text is
// near-identical to another in the same bucket (e.g. "OA.pdf" and "OA signed.docx",
// or two copies under different names). Keeps the version with the most text.
function removeDuplicateDocuments(docs) {
  const sorted = [...docs].sort((a, b) => b.text.length - a.text.length);
  const kept = [];
  const duplicates = [];
  for (const doc of sorted) {
    const trigrams = trigramSet(doc.text);
    let match = null;
    for (const k of kept) {
      const score = jaccard(trigrams, k.trigrams);
      if (score >= DUPLICATE_SIMILARITY) { match = { doc: k, score }; break; }
    }
    if (match) {
      duplicates.push({ name: doc.name, keptName: match.doc.name, similarity: Math.round(match.score * 100) });
      console.warn(`[dedupe] dropped ${doc.name}: ${Math.round(match.score * 100)}% match with ${match.doc.name}`);
    } else {
      kept.push({ doc, name: doc.name, trigrams });
    }
  }
  // Preserve the original upload order for what's sent to Claude
  const keptDocs = new Set(kept.map(k => k.doc));
  return { docs: docs.filter(d => keptDocs.has(d)), duplicates };
}

// Downloads and extracts every file in a bucket. Failures never throw — they're
// collected in `skipped` so the brief can name them.
async function downloadAndExtract(supabase, files) {
  const empty = { text: '', included: [], skipped: [], duplicates: [] };
  if (!files || files.length === 0) return empty;

  const perFile = await Promise.all(files.map(async ({ path, name }) => {
    try {
      const { data, error } = await supabase.storage.from('onboarding-docs').download(path);
      if (error) return [{ name, text: '', error: `download failed: ${error.message}` }];
      const buffer = Buffer.from(await data.arrayBuffer());
      return await extractFile(buffer, name);
    } catch (err) {
      return [{ name, text: '', error: err.message || String(err) }];
    }
  }));

  const results = perFile.flat();
  const skipped = results.filter(r => r.error).map(r => ({ name: r.name, reason: r.error }));
  skipped.forEach(s => console.warn(`[extract] skipped ${s.name}: ${s.reason}`));
  const { docs: ok, duplicates } = removeDuplicateDocuments(results.filter(r => !r.error));

  return {
    text: ok.map(r => `=== ${r.name} ===\n${r.text}`).join('\n\n'),
    included: ok.map(r => r.name),
    skipped,
    duplicates,
  };
}

// Builds the user message for one Claude call. Truncation only ever cuts the
// documents, never the form data or the list of unreadable files.
function buildClaudeInput(formData, label, extracted, emptyMessage) {
  const skippedNote = extracted.skipped.length
    ? `\n\n=== FILES THAT COULD NOT BE READ ===\nThe following uploaded files could not be read and were NOT analyzed. Do not guess at their contents. Mention them under the relevant section so the team knows to review them manually:\n${extracted.skipped.map(s => `- ${s.name} (${s.reason})`).join('\n')}`
    : '';
  const header = `${formData || ''}${skippedNote}\n\n=== ${label} ===\n`;
  const body = extracted.text || emptyMessage;
  return header + truncateText(body, Math.max(10000, MAX_CHARS_PER_BUCKET - header.length));
}

// ── CLAUDE CALL ──────────────────────────────────────────────────────────────

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

async function callClaude(apiKey, systemPrompt, userContent, maxTokens = 2000, label = 'claude') {
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }]
        })
      });

      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }

      if (!res.ok || data?.error || !data) {
        const msg = data?.error?.message || raw.slice(0, 300) || `HTTP ${res.status}`;
        lastError = new Error(`Claude API ${res.status}: ${msg}`);
        if (!RETRYABLE_STATUS.has(res.status) || attempt === maxAttempts) throw lastError;
        const retryAfter = parseFloat(res.headers.get('retry-after'));
        const waitMs = Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * 2 ** (attempt - 1), 20000);
        console.warn(`[${label}] attempt ${attempt} failed (${lastError.message}); retrying in ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      const text = (data.content || []).map(b => b.text || '').join('').trim();
      if (!text) throw new Error(`Claude returned an empty response (stop_reason: ${data.stop_reason})`);
      return text;
    } catch (err) {
      lastError = err;
      // fetch() itself throws on network errors — retry those too
      if (err.message?.startsWith('Claude API') || attempt === maxAttempts) break;
      console.warn(`[${label}] attempt ${attempt} network error: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    }
  }

  console.error(`[${label}] failed: ${lastError?.message}`);
  throw lastError;
}

// ── CLICKUP CUSTOM FIELDS ────────────────────────────────────────────────────

const PHONE_FIELD_ID = '56a8831d-4db0-4471-9a78-adc1d5dc07d1';
const KEY_PROMISES_FIELD_ID = 'd5b81a08-0089-48db-ac6d-c3988a5612d1';
const SCOPE_FIELD_ID = '466a57b9-7720-47eb-818b-a995cc2a8cb5';
const TEXT_FALLBACK_MAX_CHARS = 1000;

// ClickUp phone fields only accept numbers with a country code, e.g. "+1 555 000 0000".
// US/Canada numbers without one get +1; anything else must already start with +.
function normalizePhone(value) {
  const input = String(value).trim();
  const digits = input.replace(/\D/g, '');
  if (input.startsWith('+')) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.length === 10) return `+1 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  if (digits.length > 11) return `+${digits}`;
  return null;
}

async function getListFieldTypes(clickupKey, listId) {
  try {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/field`, {
      headers: { 'Authorization': clickupKey }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { fields = [] } = await res.json();
    return new Map(fields.map(f => [f.id, f.type]));
  } catch (err) {
    console.warn(`[clickup] could not load field definitions: ${err.message}`);
    return new Map();
  }
}

// Coerce a value to what ClickUp expects for the field's type. Returns
// undefined if the value can't be sent at all.
function coerceFieldValue(type, id, value) {
  if (type === 'phone' || (!type && id === PHONE_FIELD_ID)) return normalizePhone(value) ?? undefined;
  if (type === 'short_text') return sanitizeText(value).replace(/\s*\n\s*/g, ' · ');
  if (type === 'text') return sanitizeText(value);
  if (type === 'email') return String(value).trim();
  if (type === 'url') {
    const url = String(value).trim();
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  }
  if (type === 'number' || type === 'currency') {
    const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return typeof value === 'string' ? sanitizeText(value) : value;
}

async function setCustomField(clickupKey, taskId, id, value) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/field/${id}`, {
    method: 'POST',
    headers: { 'Authorization': clickupKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value })
  });
  if (res.ok) return null;
  const body = await res.text().catch(() => '');
  return `HTTP ${res.status}: ${body.slice(0, 300)}`;
}

// Merge a Claude-extracted value into a field that Sales may have already filled
// in on the form, so the two don't race each other as separate writes.
function mergeField(fields, id, extracted, heading) {
  if (!extracted) return;
  const existing = fields.find(f => f.id === id);
  if (!existing) {
    fields.push({ id, value: extracted });
  } else if (String(existing.value).trim() !== extracted.trim()) {
    existing.value = `${existing.value}\n\n${heading}:\n${extracted}`;
  }
}

async function updateCustomFields(clickupKey, listId, taskId, customFields) {
  const fieldTypes = await getListFieldTypes(clickupKey, listId);
  const errors = [];

  // One write per field ID — later duplicates replace earlier ones
  const byId = new Map();
  for (const f of customFields) {
    if (f && f.id && f.value !== undefined && f.value !== null && f.value !== '') byId.set(f.id, f.value);
  }

  await Promise.all([...byId].map(async ([id, rawValue]) => {
    const type = fieldTypes.get(id);
    const value = coerceFieldValue(type, id, rawValue);
    if (value === undefined || value === '') {
      errors.push({ id, type, error: `invalid value for ${type || 'field'}: ${JSON.stringify(rawValue)}` });
      return;
    }

    let error = await setCustomField(clickupKey, taskId, id, value);

    // Long text rejected: retry once as a single, shorter line
    if (error && error.startsWith('HTTP 400') && typeof value === 'string' && value.length > 0) {
      const flattened = value.replace(/\s*\n\s*/g, ' · ');
      const shorter = flattened.length > TEXT_FALLBACK_MAX_CHARS
        ? flattened.slice(0, TEXT_FALLBACK_MAX_CHARS - 1).trimEnd() + '…'
        : flattened;
      if (shorter !== value) {
        console.warn(`[clickup] field ${id} (${type || 'unknown type'}) rejected (${error}); retrying with ${shorter.length}-char single-line value`);
        const retryError = await setCustomField(clickupKey, taskId, id, shorter);
        if (!retryError) return;
        error = `${error} | retry: ${retryError}`;
      }
    }

    if (error) {
      console.error(`[clickup] field ${id} (${type || 'unknown type'}) failed: ${error}`);
      errors.push({ id, type, error });
    }
  }));

  return errors;
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const CLICKUP_KEY = process.env.CLICKUP_API_KEY;
  const CLICKUP_LIST = process.env.CLICKUP_LIST_ID || '901702902471';
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!ANTHROPIC_KEY || !CLICKUP_KEY) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  try {
    const { formData, customFields, entityName, buckets } = req.body;
    // buckets = { fundDocs: [{path, name}], transcripts: [{path, name}], syndication: [{path, name}] }

    const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
      ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      : null;

    // ── Extract text from each bucket in parallel ──
    const noFiles = { text: '', included: [], skipped: [], duplicates: [] };
    const [fundDocs, transcripts, syndication] = await Promise.all([
      supabase && buckets?.fundDocs?.length ? downloadAndExtract(supabase, buckets.fundDocs) : noFiles,
      supabase && buckets?.transcripts?.length ? downloadAndExtract(supabase, buckets.transcripts) : noFiles,
      supabase && buckets?.syndication?.length ? downloadAndExtract(supabase, buckets.syndication) : noFiles,
    ]);
    const skippedFiles = [...fundDocs.skipped, ...transcripts.skipped, ...syndication.skipped];
    const duplicateFiles = [...fundDocs.duplicates, ...transcripts.duplicates, ...syndication.duplicates];

    // ── Claude calls in parallel ──
    // Each call always runs on the form data; unreadable files are listed, not sent.
    const fundDocsInput = buildClaudeInput(formData, 'FUND DOCUMENTS', fundDocs,
      fundDocs.skipped.length ? '[No readable fund documents — see list of unreadable files above]' : '[No fund documents uploaded]');
    const transcriptInput = buildClaudeInput(formData, 'CALL TRANSCRIPTS', transcripts,
      transcripts.skipped.length ? '[No readable transcripts — see list of unreadable files above]' : '[No transcripts uploaded]');

    const claudePromises = [
      callClaude(ANTHROPIC_KEY, PROMPT_FUND_DOCS, fundDocsInput, 1500, 'fund-docs'),
      callClaude(ANTHROPIC_KEY, PROMPT_TRANSCRIPTS, transcriptInput, 2000, 'transcripts'),
    ];

    // Syndication only runs when at least one syndication document was readable
    if (syndication.text) {
      const syndicationInput = buildClaudeInput(formData, 'SYNDICATION DOCUMENTS', syndication, '');
      claudePromises.push(callClaude(ANTHROPIC_KEY, PROMPT_SYNDICATION, syndicationInput, 1000, 'syndication'));
    }

    const claudeResults = await Promise.allSettled(claudePromises);
    const failureNote = (result, label) => `⚠️ ${label} analysis failed: ${result.reason?.message || 'unknown error'}`;

    const fundDocsOutput = claudeResults[0].status === 'fulfilled' ? claudeResults[0].value : failureNote(claudeResults[0], 'Fund docs');
    const rawTranscriptOutput = claudeResults[1].status === 'fulfilled' ? claudeResults[1].value : failureNote(claudeResults[1], 'Transcript');
    const syndicationOutput = !claudeResults[2] ? ''
      : claudeResults[2].status === 'fulfilled' ? claudeResults[2].value : failureNote(claudeResults[2], 'Syndication');

    // ── Parse EXTRACTED FIELDS from transcript output ──
    let transcriptOutput = rawTranscriptOutput;
    let extractedKeyPromises = '';
    let extractedScope = '';

    const extractedMatch = rawTranscriptOutput.match(/EXTRACTED FIELDS([\s\S]*?)$/i);
    if (extractedMatch) {
      const extractedBlock = extractedMatch[1];
      transcriptOutput = rawTranscriptOutput.replace(/---[\s\S]*?EXTRACTED FIELDS[\s\S]*?$/, '').trim();
      const promisesMatch = extractedBlock.match(/Key Promises:\s*([\s\S]*?)(?:Scope of Services:|$)/i);
      const scopeMatch = extractedBlock.match(/Scope of Services:\s*([\s\S]*?)$/i);
      if (promisesMatch) extractedKeyPromises = promisesMatch[1].trim();
      if (scopeMatch) extractedScope = scopeMatch[1].trim();
    }

    // ── Note any files that couldn't be read ──
    const noteParts = [];
    if (skippedFiles.length) {
      noteParts.push(`The following uploaded files could not be read and were not included in this analysis. Please review them manually:\n${skippedFiles.map(s => `- ${s.name} — ${s.reason}`).join('\n')}`);
    }
    if (duplicateFiles.length) {
      noteParts.push(`The following files were near-identical copies of another upload, so only one version was analyzed:\n${duplicateFiles.map(d => `- ${d.name} — ${d.similarity}% match with ${d.keptName} (analyzed instead)`).join('\n')}`);
    }
    const extractionNotes = noteParts.length ? `DOCUMENT EXTRACTION NOTES\n${noteParts.join('\n\n')}` : '';

    // ── Combine into one brief ──
    const brief = [
      fundDocsOutput,
      transcriptOutput,
      syndicationOutput,
      extractionNotes
    ].filter(Boolean).join('\n\n---\n\n');

    // ── Create ClickUp task ──
    const clickupRes = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST}/task`, {
      method: 'POST',
      headers: { 'Authorization': CLICKUP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: entityName, description: brief, status: 'pending sales review' })
    });

    const clickupData = await clickupRes.json();
    if (!clickupData.id) throw new Error(clickupData.err || 'ClickUp task creation failed');
    const taskId = clickupData.id;

    // ── Add Claude-extracted fields to custom fields ──
    const fields = Array.isArray(customFields) ? [...customFields] : [];
    if (extractedKeyPromises && !/^none identified/i.test(extractedKeyPromises)) {
      mergeField(fields, KEY_PROMISES_FIELD_ID, extractedKeyPromises, 'From call transcripts');
    }
    mergeField(fields, SCOPE_FIELD_ID, extractedScope, 'From call transcripts');

    // ── Update custom fields individually ──
    const fieldErrors = await updateCustomFields(CLICKUP_KEY, CLICKUP_LIST, taskId, fields);

    return res.status(200).json({
      brief,
      taskId,
      taskUrl: `https://app.clickup.com/t/${taskId}`,
      skippedFiles,
      duplicateFiles,
      fieldErrors
    });

  } catch (err) {
    console.error('[handover] failed:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
