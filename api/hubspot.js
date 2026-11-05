import { requireSession } from './_auth.js';

// Reads a HubSpot deal (plus its Entity, primary contact and notes) and returns
// values for steps 1-3 of the handover form, and the CRM notes Claude reads.
// Read-only: nothing is written back to HubSpot.

const HS = 'https://api.hubapi.com';
const ENTITY_OBJECT = '2-9561141';
const PLAYBOOK_TITLE = 'Sales New Deal Playbook';
const MAX_NOTES_CHARS = 40000;

const DEAL_PROPS = [
  'dealname', 'entity_name', 'entity_type_s_', 'product', 'one_time_fee', 'lead_source',
  'what_portal_will_they_use', 'are_they_using_agora', 'do_they_need_verivest_to_setup_their_portal',
  'are_they_migrating_from_another_portal', 'does_the_setup_include_migrating_historical_investor_data_from_another_platform',
  'what_is_the_scope_of_services_we_will_need_to_provide_for_the_portal_setup', 'alternate_portal_scope_notes',
  'portal_migration_source', 'effective_date_of_first_period', 'transaction_fee_status', 'pricing_concession_reason',
  'nonstandard_terms', 'additional_services_interest', 'deal_notes', 'why_are_you_looking_for_services',
  'what_services_are_you_looking_for', 'key_reporting_deadlines', 'reporting_cadence', 'reporting_package_level',
  'governing_docs_status', 'entities_requiring_admin',
];
const ENTITY_PROPS = ['name', 'client__', 'entity_type', 'service_type', 'contract_special_terms', 'entity_notes', 'first_accounting_cycle_start_date'];
const CONTACT_PROPS = ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'city', 'state'];

// HubSpot product value -> handover form "Service" option
const SERVICE_MAP = {
  'Admin': 'Full Fund Admin',
  'Investor Servicing': 'Investor Servicing Only',
  'Annual Financial Statements': 'Annual Financial Statements',
  'AIP': 'AIP',
  'Fund Financial Model': 'Fund Financial Model',
  'Fund Financial Model - Open': 'Fund Financial Model',
  'Fund Financial Model - Closed': 'Fund Financial Model',
  'Investor Onboarding Support': 'Investor Onboarding Support',
  'Syndication Admin': 'Syndication Admin',
  'Syndication Investor Support Services': 'Syndication Investor Support Services',
  'Valuation Services': 'Valuation Services',
};

// Accepts a record ID or a HubSpot record URL; URLs also say which object they are
// (0-3 = deal, 2-9561141 = Entity).
export function parseRecordRef(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const url = s.match(/\/record\/(\d+-\d+)\/(\d+)/);
  if (url) return { objectType: url[1], id: url[2] };
  const portalUrl = s.match(/\/(?:deal|deals)\/(\d+)/);
  if (portalUrl) return { objectType: '0-3', id: portalUrl[1] };
  if (/^\d+$/.test(s)) return { objectType: null, id: s };
  return { invalid: true };
}

async function hs(token, path, body) {
  const res = await fetch(HS + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HubSpot ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Playbook notes are "<div><b>Question</b><ul><li>Answer</li><li><p>Notes:</p>…</li></ul></div>".
// Returns { [question]: { answer, notes } }.
export function parsePlaybook(html) {
  const out = {};
  const re = /<div><b>([\s\S]*?)<\/b>([\s\S]*?)(?=<div><b>|$)/g;
  let m;
  while ((m = re.exec(html))) {
    const question = htmlToText(m[1]);
    const [answerPart, ...noteParts] = m[2].split(/<p>\s*Notes:\s*<\/p>/i);
    const answer = htmlToText(answerPart).replace(/^-\s*/gm, '').trim();
    const notes = htmlToText(noteParts.join('\n')).replace(/^-\s*/gm, '').trim();
    if (question) out[question] = { answer, notes };
  }
  return out;
}

const yesNo = v => v === 'true' ? 'Yes' : v === 'false' ? 'No' : '';
const multi = v => (v || '').split(';').map(x => x.trim()).filter(Boolean);
const isNothing = s => !s || /^(no|none|n\/?a|nothing)\.?$/i.test(s.trim());

export function buildForm({ deal, entity, contact, playbook, labels, portalId }) {
  const d = deal.properties || {};
  const e = entity?.properties || {};
  const c = contact?.properties || {};
  const pb = q => {
    const key = Object.keys(playbook || {}).find(k => k.toLowerCase().startsWith(q.toLowerCase()));
    return key ? playbook[key] : null;
  };
  const pbText = q => {
    const a = pb(q);
    if (!a) return '';
    return [a.answer, a.notes].filter(s => s && !isNothing(s)).join('\n').trim();
  };
  // "Anecdotal Information" block: "Company: …", "Fund: …", "Address: …" lines
  const anecdotal = pb('Anecdotal Information')?.answer || '';
  const anecdote = key => {
    const m = anecdotal.match(new RegExp(`^${key}:\\s*([\\s\\S]*?)(?=\\n\\s*\\n|\\n[A-Z][\\w ]+:|(?![\\s\\S]))`, 'im'));
    return m ? m[1].replace(/\s*\n\s*/g, ', ').trim() : '';
  };
  const label = (prop, value) => labels[prop]?.[value] ?? value;

  const fields = {};   // input/select/textarea id -> value
  const radios = {};   // radio group name -> value
  const warnings = [];

  const set = (id, value) => { if (value !== undefined && value !== null && String(value).trim() !== '') fields[id] = String(value).trim(); };

  // ── Step 1: client info
  const nameFromDeal = (d.dealname || '').includes('-') ? d.dealname.slice(0, d.dealname.lastIndexOf('-')).trim() : '';
  const entityName = e.name || d.entity_name || anecdote('Fund') || anecdote('Company');
  set('entity_name', entityName || nameFromDeal);
  if (!entityName && nameFromDeal) warnings.push(`Entity Name taken from the deal name ("${nameFromDeal}") — check it.`);
  set('client_num', e.client__);
  const entityType = d.entity_type_s_ === 'Greenfield' ? 'Greenfield' : d.entity_type_s_ === 'Brownfield' ? 'Brownfield' : '';
  set('entity_type', entityType);
  if (d.entity_type_s_ === 'Entity Already Onboarded') warnings.push('Entity Type is "Entity Already Onboarded" in HubSpot — choose Greenfield or Brownfield.');

  const isSyndication = /syndication/i.test(e.entity_type || '') || multi(d.product).some(p => /syndication/i.test(p));
  if (isSyndication) set('fund_type', 'N/A');
  else if (entityType === 'Greenfield') set('fund_type', 'New Fund');
  else if (entityType === 'Brownfield') set('fund_type', 'Fund Conversion');

  const products = multi(d.product);
  const service = products.map(p => SERVICE_MAP[p]).find(Boolean);
  set('service', service);
  if (products.length > 1) {
    warnings.push(`Deal has ${products.length} products (${products.map(p => label('product', p)).join(', ')}) — Service set to "${service || 'none'}". Check it.`);
  } else if (products.length && !service) {
    warnings.push(`HubSpot product "${label('product', products[0])}" has no matching Service on this form — choose one.`);
  }
  if (isSyndication && entityType) set('syndication_type', entityType === 'Greenfield' ? 'New Syndication' : 'Existing Syndication');

  set('onboarding_fee', d.one_time_fee);
  set('hubspot_link', `https://app.hubspot.com/contacts/${portalId}/record/0-3/${deal.id}`);

  set('contact_name', [c.firstname, c.lastname].map(s => (s || '').trim()).filter(Boolean).join(' '));
  set('contact_email', c.email);
  set('contact_number', c.phone || c.mobilephone);
  set('address', [c.city, c.state].filter(Boolean).join(', ') || anecdote('Address'));
  set('referral_source', label('lead_source', d.lead_source));

  // ── Step 2: portal
  const agora = d.are_they_using_agora || '';
  const portalText = d.what_portal_will_they_use || pb('If they are using a portal')?.answer || '';
  let portalType = '';
  if (/^yes/i.test(agora) || /agora/i.test(portalText)) portalType = 'Agora';
  else if (/appfolio/i.test(portalText)) portalType = 'Appfolio';
  else if (/juniper/i.test(portalText)) portalType = 'Juniper Square';
  else if (portalText && !isNothing(portalText)) portalType = 'Other';
  else if (agora === 'No' && !portalText) portalType = '';
  set('portal_type', portalType);

  const r = (name, v) => { if (v) radios[name] = v; };
  r('portal_setup', yesNo(d.do_they_need_verivest_to_setup_their_portal));
  r('portal_migrate', yesNo(d.are_they_migrating_from_another_portal));
  r('data_migrate', yesNo(d.does_the_setup_include_migrating_historical_investor_data_from_another_platform));

  const migrationSource = multi(d.portal_migration_source).filter(s => s !== 'N/A');
  set('portal_scope', [
    d.what_is_the_scope_of_services_we_will_need_to_provide_for_the_portal_setup,
    d.alternate_portal_scope_notes,
    migrationSource.length ? `Migrating from: ${migrationSource.join(', ')}` : '',
  ].filter(Boolean).join('\n\n'));

  // ── Step 3: contract & pricing
  const effective = d.effective_date_of_first_period || e.first_accounting_cycle_start_date;
  set('effective_date', effective ? String(effective).slice(0, 10) : '');
  r('txn_fees', ['Standard', 'Modified', 'Waived'].includes(d.transaction_fee_status) ? d.transaction_fee_status : '');
  set('txn_fee_notes', isNothing(d.pricing_concession_reason) ? '' : d.pricing_concession_reason);
  set('non_standard_terms', [d.nonstandard_terms, e.contract_special_terms, pbText('Are there any non-standard terms')]
    .filter(s => s && !isNothing(s)).filter((s, i, a) => a.indexOf(s) === i).join('\n\n'));
  set('addon_services', [multi(d.additional_services_interest).map(v => label('additional_services_interest', v)).join(', '),
    pbText('Were any add on services')].filter(Boolean).join('. '));
  set('key_promises', pbText('Were there any key commitments or promises'));

  return { fields, radios, warnings };
}

// Free-text CRM context for Claude: the playbook, other notes and descriptive properties.
function buildCrmNotes({ deal, entity, notes, labels }) {
  const d = deal.properties || {};
  const e = entity?.properties || {};
  const props = [
    ['Why are they looking for services', d.why_are_you_looking_for_services],
    ['What services are they looking for', d.what_services_are_you_looking_for],
    ['Entities requiring admin', d.entities_requiring_admin],
    ['Governing docs status', d.governing_docs_status],
    ['Reporting cadence', d.reporting_cadence],
    ['Reporting package level', multi(d.reporting_package_level).join(', ')],
    ['Key reporting deadlines', d.key_reporting_deadlines],
    ['Deal notes (property)', d.deal_notes],
    ['Entity notes (property)', e.entity_notes],
  ].filter(([, v]) => v && String(v).trim());

  const parts = [];
  if (props.length) parts.push('HUBSPOT DEAL / ENTITY PROPERTIES\n' + props.map(([k, v]) => `${k}: ${v}`).join('\n'));
  for (const n of notes) {
    const when = n.properties.hs_timestamp ? n.properties.hs_timestamp.slice(0, 10) : 'undated';
    parts.push(`HUBSPOT NOTE (${n.on}, ${when})\n${htmlToText(n.properties.hs_note_body)}`);
  }
  let text = parts.join('\n\n---\n\n');
  if (text.length > MAX_NOTES_CHARS) text = text.slice(0, MAX_NOTES_CHARS) + '\n\n[HubSpot notes truncated]';
  return text;
}

async function getOptionLabels(token) {
  const labels = {};
  for (const prop of ['product', 'lead_source', 'additional_services_interest']) {
    const def = await hs(token, `/crm/v3/properties/deals/${prop}`);
    labels[prop] = Object.fromEntries((def?.options || []).map(o => [o.value, o.label]));
  }
  return labels;
}

const assocIds = (record, key) => (record?.associations?.[key]?.results || []).map(a => String(a.id));

// Custom-object associations come back keyed by the object's internal name
// (e.g. "p5708692_entity"), not its type ID.
const entityAssocIds = record => Object.entries(record?.associations || {})
  .filter(([key]) => key === ENTITY_OBJECT || /^p\d+_entit/i.test(key))
  .flatMap(([, v]) => (v.results || []).map(a => String(a.id)));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = requireSession(req, res);
  if (!user) return;

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(503).json({ error: 'HubSpot is not connected yet (HUBSPOT_TOKEN is not set in Vercel).' });

  const dealRef = parseRecordRef(req.body?.deal);
  const entityRef = parseRecordRef(req.body?.entity);
  if (!dealRef || dealRef.invalid) return res.status(400).json({ error: 'Paste a HubSpot deal link or its Record ID (the long number at the end of the link).' });
  if (dealRef.objectType && dealRef.objectType !== '0-3') return res.status(400).json({ error: 'That link is not a deal. Open the deal in HubSpot and copy its link.' });
  if (entityRef?.invalid) return res.status(400).json({ error: 'The Entity box should contain an Entity link or Record ID.' });
  if (entityRef?.objectType && entityRef.objectType !== ENTITY_OBJECT) return res.status(400).json({ error: 'That link is not an Entity record. Open the Entity in HubSpot and copy its link.' });

  try {
    const [deal, labels, account] = await Promise.all([
      hs(token, `/crm/v3/objects/deals/${dealRef.id}?properties=${DEAL_PROPS.join(',')}&associations=contacts,notes,${ENTITY_OBJECT}`),
      getOptionLabels(token),
      hs(token, '/account-info/v3/details'),
    ]);
    if (!deal) return res.status(404).json({ error: `No deal found with Record ID ${dealRef.id}.` });

    const warnings = [];
    const linkedEntities = entityAssocIds(deal);
    let entityId = entityRef?.id || null;
    if (!entityId) {
      const unique = [...new Set(linkedEntities)];
      if (unique.length === 1) entityId = unique[0];
      else if (unique.length > 1) { entityId = unique[0]; warnings.push(`This deal is linked to ${unique.length} Entities — used the first one. Paste the Entity link if it's the wrong one.`); }
      else warnings.push('No Entity is linked to this deal — paste the Entity link to fill Client # and entity details.');
    }

    const entity = entityId
      ? await hs(token, `/crm/v3/objects/${ENTITY_OBJECT}/${entityId}?properties=${ENTITY_PROPS.join(',')}&associations=notes`)
      : null;
    if (entityId && !entity) warnings.push(`No Entity found with Record ID ${entityId}.`);

    const contactIds = [...new Set(assocIds(deal, 'contacts'))];
    const contact = contactIds.length
      ? await hs(token, `/crm/v3/objects/contacts/${contactIds[0]}?properties=${CONTACT_PROPS.join(',')}`)
      : null;
    if (contactIds.length > 1) warnings.push(`Deal has ${contactIds.length} contacts — used ${[contact?.properties?.firstname, contact?.properties?.lastname].filter(Boolean).join(' ') || 'the first one'}. Check Primary Contact.`);
    if (!contactIds.length) warnings.push('No contact is linked to this deal.');

    // Notes on the deal and the entity, newest first
    const noteRefs = [
      ...assocIds(deal, 'notes').map(id => ({ id, on: 'deal' })),
      ...assocIds(entity, 'notes').map(id => ({ id, on: 'entity' })),
    ].filter((n, i, a) => a.findIndex(x => x.id === n.id) === i);
    let notes = [];
    if (noteRefs.length) {
      const batch = await hs(token, '/crm/v3/objects/notes/batch/read', {
        inputs: noteRefs.slice(0, 100).map(n => ({ id: n.id })),
        properties: ['hs_note_body', 'hs_timestamp'],
      });
      notes = (batch?.results || [])
        .map(n => ({ ...n, on: noteRefs.find(r => r.id === n.id)?.on || 'deal' }))
        .sort((a, b) => String(b.properties.hs_timestamp).localeCompare(String(a.properties.hs_timestamp)));
    }

    const playbookNote = notes.find(n => (n.properties.hs_note_body || '').includes(PLAYBOOK_TITLE));
    const playbook = playbookNote ? parsePlaybook(playbookNote.properties.hs_note_body) : null;
    if (!playbookNote) warnings.unshift('No "Sales New Deal Playbook" note found on this deal — only HubSpot properties were used, so expect more blanks.');

    const form = buildForm({ deal, entity, contact, playbook, labels, portalId: account?.portalId });
    const crmNotes = buildCrmNotes({ deal, entity, notes, labels });

    console.log(`[hubspot] ${user.email} pulled deal ${deal.id}: ${Object.keys(form.fields).length} fields, ${Object.keys(form.radios).length} radios, ${notes.length} notes, playbook=${!!playbookNote}`);

    return res.status(200).json({
      dealId: deal.id,
      dealName: deal.properties.dealname,
      entityId: entity?.id || null,
      entityName: entity?.properties?.name || null,
      fields: form.fields,
      radios: form.radios,
      warnings: [...warnings, ...form.warnings],
      hasPlaybook: !!playbookNote,
      notesCount: notes.length,
      crmNotes,
    });
  } catch (err) {
    console.error('[hubspot] failed:', err);
    return res.status(502).json({ error: `Could not read from HubSpot: ${err.message}` });
  }
}
