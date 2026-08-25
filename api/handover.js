import { createClient } from '@supabase/supabase-js';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

export const config = { maxDuration: 300 };

// Token limit safety — truncate text if too long (~150k chars ≈ ~37k tokens, safe buffer)
const MAX_CHARS_PER_BUCKET = 150000;

function truncateText(text, maxChars = MAX_CHARS_PER_BUCKET) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[Document truncated due to length — remaining content omitted]';
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

async function extractText(buffer, filename) {
  const ext = filename.split('.').pop().toLowerCase();
  try {
    if (ext === 'pdf') {
      const data = await pdfParse(buffer);
      return data.text;
    }
    if (ext === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    if (ext === 'txt' || ext === 'csv') {
      return buffer.toString('utf-8');
    }
    if (ext === 'xlsx' || ext === 'xls') {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      return workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        return `Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`;
      }).join('\n\n');
    }
    if (ext === 'pptx') {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(buffer);
      const slideFiles = Object.keys(zip.files).filter(f => f.match(/ppt\/slides\/slide\d+\.xml/));
      const texts = await Promise.all(
        slideFiles.sort().map(async f => {
          const xml = await zip.files[f].async('string');
          return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        })
      );
      return texts.join('\n\n');
    }
    if (ext === 'zip') {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(buffer);
      const fileEntries = Object.keys(zip.files).filter(f => !zip.files[f].dir);
      const texts = await Promise.allSettled(
        fileEntries.map(async entry => {
          const entryBuffer = Buffer.from(await zip.files[entry].async('arraybuffer'));
          const entryName = entry.split('/').pop();
          const text = await extractText(entryBuffer, entryName);
          return `--- File inside ZIP: ${entryName} ---\n${text}`;
        })
      );
      return texts
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value)
        .join('\n\n');
    }
    return `[Could not extract text from ${filename} — unsupported format]`;
  } catch (err) {
    return `[Error extracting ${filename}: ${err.message}]`;
  }
}

async function downloadAndExtract(supabase, files) {
  if (!files || files.length === 0) return '';
  const results = await Promise.allSettled(
    files.map(async ({ path, name }) => {
      const { data, error } = await supabase.storage.from('onboarding-docs').download(path);
      if (error) return `[Could not download ${name}: ${error.message}]`;
      const buffer = Buffer.from(await data.arrayBuffer());
      const text = await extractText(buffer, name);
      return `=== ${name} ===\n${text}`;
    })
  );
  return results.map(r => r.status === 'fulfilled' ? r.value : '[Extraction failed]').join('\n\n');
}

// ── CLAUDE CALL ──────────────────────────────────────────────────────────────

async function callClaude(apiKey, systemPrompt, userContent, maxTokens = 2000) {
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
  const data = await res.json();
  if (data.error) throw new Error('Claude error: ' + data.error.message);
  return (data.content || []).map(b => b.text || '').join('').trim();
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
    const [fundDocsText, transcriptText, syndicationText] = await Promise.all([
      supabase && buckets?.fundDocs?.length ? downloadAndExtract(supabase, buckets.fundDocs) : Promise.resolve(''),
      supabase && buckets?.transcripts?.length ? downloadAndExtract(supabase, buckets.transcripts) : Promise.resolve(''),
      supabase && buckets?.syndication?.length ? downloadAndExtract(supabase, buckets.syndication) : Promise.resolve(''),
    ]);

    // ── Three Claude calls in parallel ──
    const fundDocsInput = truncateText(`${formData}\n\n=== FUND DOCUMENTS ===\n${fundDocsText || '[No fund documents uploaded]'}`);
    const transcriptInput = truncateText(`${formData}\n\n=== CALL TRANSCRIPTS ===\n${transcriptText || '[No transcripts uploaded]'}`);

    const claudePromises = [
      callClaude(ANTHROPIC_KEY, PROMPT_FUND_DOCS, fundDocsInput, 1500),
      callClaude(ANTHROPIC_KEY, PROMPT_TRANSCRIPTS, transcriptInput, 2000),
    ];

    if (syndicationText) {
      const syndicationInput = truncateText(`${formData}\n\n=== SYNDICATION DOCUMENTS ===\n${syndicationText}`);
      claudePromises.push(callClaude(ANTHROPIC_KEY, PROMPT_SYNDICATION, syndicationInput, 1000));
    }

    const claudeResults = await Promise.allSettled(claudePromises);

    const fundDocsOutput = claudeResults[0].status === 'fulfilled' ? claudeResults[0].value : '⚠️ Fund docs analysis failed.';
    const transcriptOutput = claudeResults[1].status === 'fulfilled' ? claudeResults[1].value : '⚠️ Transcript analysis failed.';
    const syndicationOutput = claudeResults[2]?.status === 'fulfilled' ? claudeResults[2].value : '';

    // ── Combine into one brief ──
    const brief = [
      fundDocsOutput,
      transcriptOutput,
      syndicationOutput
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

    // ── Update custom fields individually ──
    const validFields = (customFields || []).filter(f => f.value !== undefined && f.value !== '' && f.value !== null);
    await Promise.allSettled(
      validFields.map(field =>
        fetch(`https://api.clickup.com/api/v2/task/${taskId}/field/${field.id}`, {
          method: 'POST',
          headers: { 'Authorization': CLICKUP_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: field.value })
        })
      )
    );

    return res.status(200).json({ brief, taskId, taskUrl: `https://app.clickup.com/t/${taskId}` });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
