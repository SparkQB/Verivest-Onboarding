export const config = { maxDuration: 60 };

const SYSTEM_PROMPT = `You are the Verivest Handover Brief Agent. Your job is to read information collected from a closed sales deal and produce a concise handover brief for the Verivest Onboarding team.

Verivest is a real estate fund administration company. The structured deal data (entity name, service, fees, contact info, Agora scope, contract terms) is already captured in separate fields. Your job is to produce ONLY the following three things:

---

WARNINGS
Check for these conditions and output a warning block for each one triggered. If none are triggered, skip this section entirely — do not write "No warnings."

- AGORA MIGRATION — NO EFFECTIVE DATE: Agora migration is in scope but no effective date is set
- MID-CYCLE START: Client is starting mid-quarter or mid-year and prior-period catch-up may be needed
- GREENFIELD WITH NEAR-TERM DEADLINE: Greenfield deal with any deadline or investor close date mentioned
- SALES PROMISE NOT IN CONTRACT: Any commitment made during sales that goes beyond the signed contract
- ACCRUED OR UNRESOLVED ITEMS: Any open accounting issue, arrears, or unreconciled items mentioned
- MISSING REQUIRED FIELD: Reporting frequency, document status, or client sensitivities are blank

Format each warning as:
⚠️ [WARNING TYPE]
One sentence explaining what was flagged and why it matters.

---

DOCUMENT STATUS
List each document and its status. Use exactly this format:

- PPM: [Final / Draft / Unknown / Not Applicable]
- Operating Agreement: [Final / Draft / Unknown / Not Applicable]
- Subscription Agreement: [Final / Draft / Unknown / Not Applicable]
- Offering Memorandum / Pitch Deck: [Final / Draft / Unknown / Not Applicable]
- EIN / SS-4 Letter: [Final / Draft / Unknown / Not Applicable]
- Financials (brownfield): [Final / Draft / Unknown / Not Applicable]
- Other: [status or Not Applicable]

If Egnyte folder link is provided, include it as: Egnyte Folder: [link]

---

CLIENT CONTEXT
Write 3-5 paragraphs in plain English. No bullet points. No headers within this section. Cover:
1. What the client is trying to accomplish and why they came to Verivest
2. What they are trying to leave behind — prior admin pain points, frustrations, what failed before
3. What was promised during the sales process — any commitment to timing, service level, or deliverables
4. How the client wants this engagement to feel — communication style, hands-on vs hands-off, anxieties
5. Any sensitivity flags or things Onboarding should know before the first call

RULES:
- Do not reproduce any structured data already in the custom fields (entity name, fees, service scope, contact info, Agora details, contract terms)
- Do not add section headers beyond the three above
- Do not pad or repeat information
- If Client Context cannot be written due to missing information, write one paragraph explaining what is missing and why it matters for onboarding
- Tone: plain English, written for a colleague preparing for a first client call`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const CLICKUP_KEY = process.env.CLICKUP_API_KEY;
  const CLICKUP_LIST = process.env.CLICKUP_LIST_ID || '901702902471';

  if (!ANTHROPIC_KEY || !CLICKUP_KEY) {
    return res.status(500).json({ error: 'Missing environment variables — check Vercel config' });
  }

  try {
    const { formData, customFields, entityName } = req.body;

    // Step 1: Generate brief with Claude
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: formData }]
      })
    });

    const anthropicData = await anthropicRes.json();
    if (anthropicData.error) throw new Error('Anthropic error: ' + anthropicData.error.message);
    const brief = (anthropicData.content || []).map(b => b.text || '').join('').trim();
    if (!brief) throw new Error('No response from Claude — raw: ' + JSON.stringify(anthropicData));

    // Step 2: Create ClickUp task
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

    // Step 3: Update each custom field individually
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
