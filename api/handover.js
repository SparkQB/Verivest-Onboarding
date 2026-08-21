export const config = { maxDuration: 60 };

const SYSTEM_PROMPT = `You are the Verivest Handover Brief Agent. Your job is to read information collected from a closed sales deal and produce a structured handover brief for the Verivest Onboarding team.

Verivest is a real estate fund administration company. When a deal closes, the Onboarding team needs a complete, accurate brief before their first call with the new client.

Your output must contain four sections:

SECTION 1: DEAL OVERVIEW
List: client name and key contacts, fund(s) in scope, deal type (Greenfield/Brownfield), referral source, reporting period and whether this is a mid-cycle start, document status, and systems currently in use. If a field is blank or unknown, write exactly: [MISSING — Sales to confirm before onboarding begins]

SECTION 2: SCOPE OF SERVICES
List every service included. Tag each item to the specific fund or entity it applies to. Mark each as: In Scope / Not in Scope / TBD.

SECTION 3: CONTRACT AND PRICING NOTES
List all financial and contractual details. Every rate, fee, and term must be tagged to the specific fund or entity. NEVER infer or calculate rates from context — if a number is not explicitly stated, mark it [MISSING]. Cover: monthly fees, onboarding fee, contract length, distribution schedule, waterfall structure if applicable, any pricing concessions.

SECTION 4: CLIENT CONTEXT AND RELATIONSHIP NOTES
Write 3-5 paragraphs in plain English — NO bullet points. Cover in order:
1. What the client is trying to accomplish and why they came to Verivest
2. What they are trying to leave behind (prior admin pain points, frustrations)
3. What was promised during the sales process
4. How the client wants this engagement to feel
5. Any sensitivity flags

BEFORE SECTION 1, output WARNING blocks if triggered:
- MISSING REQUIRED FIELD: if reporting period, document status, promises made, or client sensitivities are blank
- MID-CYCLE START: if starting mid-quarter
- AGORA MIGRATION — NO EFFECTIVE DATE: if migration in scope but no effective date
- GREENFIELD WITH NEAR-TERM DEADLINE: if greenfield and any deadline mentioned
- MULTIPLE DEALS, PARTIALLY SPECIFIED TERMS: if multiple funds with untagged terms
- SALES PROMISE NOT IN CONTRACT: if a commitment goes beyond the contract
- ACCRUED OR UNRESOLVED ITEMS: if any open accounting issue mentioned

RULES: Never infer rates or fees. Tag every deal-specific detail to the fund it applies to. Missing fields: write exactly [MISSING — Sales to confirm before onboarding begins]. Section 4 is NOT optional. Tone: plain English, written for a colleague preparing for a first client call.`;

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
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: formData }]
      })
    });

    const anthropicData = await anthropicRes.json();
    if (anthropicData.error) throw new Error('Anthropic error: ' + anthropicData.error.message);
    const brief = (anthropicData.content || []).map(b => b.text || '').join('').trim();
    if (!brief) throw new Error('No response from Claude — raw: ' + JSON.stringify(anthropicData));

    // Step 2: Create ClickUp task (no custom fields in initial creation)
    const taskName = `${entityName} — Sales Handover`;

    const clickupRes = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST}/task`, {
      method: 'POST',
      headers: {
        'Authorization': CLICKUP_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: taskName,
        description: brief,
        status: 'pending sales review'
      })
    });

    const clickupData = await clickupRes.json();
    if (!clickupData.id) throw new Error(clickupData.err || 'ClickUp task creation failed');

    const taskId = clickupData.id;

    // Step 3: Update each custom field individually — failures are non-blocking
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
