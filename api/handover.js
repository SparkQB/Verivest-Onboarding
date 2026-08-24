import { createClient } from '@supabase/supabase-js';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

export const config = { maxDuration: 120 };

const SYSTEM_PROMPT = `You are the Verivest Handover Brief Agent. Your job is to read information collected from a closed sales deal — including form fields AND uploaded documents such as call transcripts, contracts, PPMs, and financial statements — and produce a concise handover brief for the Verivest Onboarding team.

Verivest is a real estate fund administration company. The structured deal data (entity name, service, fees, contact info, Agora scope, contract terms) is already captured in separate ClickUp fields. Your job is to produce ONLY the following three things, drawing on BOTH the form data and any uploaded documents:

---

WARNINGS
Check for these conditions across all sources (form data AND documents) and output a warning block for each one triggered. If none are triggered, skip this section entirely.

- AGORA MIGRATION — NO EFFECTIVE DATE: Agora migration is in scope but no effective date is set
- MID-CYCLE START: Client is starting mid-quarter or mid-year and prior-period catch-up may be needed
- GREENFIELD WITH NEAR-TERM DEADLINE: Greenfield deal with any deadline or investor close date mentioned
- SALES PROMISE NOT IN CONTRACT: Any commitment made during sales that goes beyond the signed contract — check transcripts carefully for verbal commitments
- ACCRUED OR UNRESOLVED ITEMS: Any open accounting issue, arrears, or unreconciled items mentioned in any document
- MISSING REQUIRED FIELD: Reporting frequency, document status, or client sensitivities are blank
- NON-STANDARD TERMS FOUND IN DOCUMENTS: Any term found in uploaded contracts or PPMs that differs from what was entered in the form
- ACCOUNTING FLAG: Anything in uploaded documents that Accounting would need to know — unusual fee structures, complex waterfall, accruals, audit issues, prior period adjustments

Format each warning as:
⚠️ [WARNING TYPE]
One sentence explaining what was flagged, which document it came from if relevant, and why it matters.

---

DOCUMENT STATUS
List each document and its status based on what was entered in the form. Use exactly this format:

- PPM: [Final / Draft / Unknown / Not Applicable]
- Operating Agreement: [Final / Draft / Unknown / Not Applicable]
- Subscription Agreement: [Final / Draft / Unknown / Not Applicable]
- Offering Memorandum / Pitch Deck: [Final / Draft / Unknown / Not Applicable]
- EIN / SS-4 Letter: [Final / Draft / Unknown / Not Applicable]
- Financials (brownfield): [Final / Draft / Unknown / Not Applicable]
- Other: [status or Not Applicable]

If Egnyte folder link is provided, include it as: Egnyte Folder: [link]

If uploaded documents were provided, list them here as: Uploaded Documents: [filename1], [filename2], etc.

---

CLIENT CONTEXT
Write 3-5 paragraphs in plain English drawing on ALL available sources — form fields, call transcripts, contracts, and any other uploaded documents. No bullet points. No headers within this section. Cover:
1. What the client is trying to accomplish and why they came to Verivest — use transcript content if available
2. What they are trying to leave behind — prior admin pain points, frustrations, what failed before — transcripts are the best source for this
3. What was promised during the sales process — check transcripts carefully for verbal commitments that may not be in the form
4. How the client wants this engagement to feel — communication style, hands-on vs hands-off, anxieties — pull from transcript tone and language
5. Any sensitivity flags, accounting nuances, or things Onboarding should flag for Accounting before the first call

RULES:
- Draw on uploaded documents actively — do not just summarize the form if richer context exists in transcripts or contracts
- Flag anything in documents that Sales might not have thought to mention but that Onboarding or Accounting needs
- Do not reproduce structured data already in the ClickUp fields
- Do not pad or repeat information
- Tone: plain English, written for a colleague preparing for a first client call`;

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
      // Extract text from PPTX XML manually
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

    return `[Could not extract text from ${filename} — unsupported format]`;
  } catch (err) {
    return `[Error extracting text from ${filename}: ${err.message}]`;
  }
}

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
    return res.status(500).json({ error: 'Missing environment variables — check Vercel config' });
  }

  try {
    const { formData, customFields, entityName, uploadedFiles } = req.body;

    // Step 1: Extract text from uploaded files via Supabase
    let documentText = '';

    if (uploadedFiles && uploadedFiles.length > 0 && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

      const extractedDocs = await Promise.allSettled(
        uploadedFiles.map(async ({ path, name }) => {
          const { data, error } = await supabase.storage
            .from('onboarding-docs')
            .download(path);

          if (error) return `[Could not download ${name}: ${error.message}]`;

          const buffer = Buffer.from(await data.arrayBuffer());
          const text = await extractText(buffer, name);
          return `=== UPLOADED DOCUMENT: ${name} ===\n${text}`;
        })
      );

      documentText = extractedDocs
        .map(r => r.status === 'fulfilled' ? r.value : `[Document extraction failed]`)
        .join('\n\n');
    }

    // Step 2: Compile full input for Claude
    const fullInput = documentText
      ? `${formData}\n\n=== UPLOADED DOCUMENTS ===\n${documentText}`
      : formData;

    // Step 3: Generate brief with Claude
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: fullInput }]
      })
    });

    const anthropicData = await anthropicRes.json();
    if (anthropicData.error) throw new Error('Anthropic error: ' + anthropicData.error.message);
    const brief = (anthropicData.content || []).map(b => b.text || '').join('').trim();
    if (!brief) throw new Error('No response from Claude');

    // Step 4: Create ClickUp task
    const clickupRes = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST}/task`, {
      method: 'POST',
      headers: {
        'Authorization': CLICKUP_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: entityName,
        description: brief,
        status: 'pending sales review'
      })
    });

    const clickupData = await clickupRes.json();
    if (!clickupData.id) throw new Error(clickupData.err || 'ClickUp task creation failed');

    const taskId = clickupData.id;

    // Step 5: Update custom fields individually
    const validFields = (customFields || []).filter(f => f.value !== undefined && f.value !== '' && f.value !== null);

    await Promise.allSettled(
      validFields.map(field =>
        fetch(`https://api.clickup.com/api/v2/task/${taskId}/field/${field.id}`, {
          method: 'POST',
          headers: {
            'Authorization': CLICKUP_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ value: field.value })
        })
      )
    );

    return res.status(200).json({
      brief,
      taskId,
      taskUrl: `https://app.clickup.com/t/${taskId}`
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
