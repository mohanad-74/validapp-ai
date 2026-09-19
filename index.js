/**
 * ValidApp - AI Assistant secure backend
 * =====================================================================
 * This is the ONLY place the AI provider's API key is ever used. It is
 * read from Secret Manager (see `secrets:` below) and is never sent to,
 * or reachable from, the browser.
 *
 * Deployed as a single Firebase Cloud Function (v2, callable), so the
 * frontend calls it with the Firebase client SDK's `httpsCallable`,
 * which automatically attaches and verifies the caller's ID token -
 * there is no separate manual auth-header wiring to get wrong.
 *
 * This function is a READ-assisting layer only:
 *   - It NEVER calls updateDoc/addDoc against `records`/`calibration`/
 *     `qualification` to change status, and never writes review
 *     comments on the user's behalf.
 *   - The only Firestore writes it performs are: (1) a short audit
 *     trail entry, and (2) a lightweight per-user rate-limit counter.
 *
 * Deploy (from the `functions/` directory):
 *   npm install
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *   firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
 *   firebase deploy --only functions:runAiAssistant
 *
 * Requires the Blaze (pay-as-you-go) plan - Cloud Functions v2 does not
 * run on the free Spark plan. Cost is small and bounded by the
 * ANTHROPIC calls + the per-user rate limit below.
 * =====================================================================
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

admin.initializeApp();
const db = admin.firestore();

// ---- Secrets (set via `firebase functions:secrets:set <NAME>`) ----
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// ---- Configuration - MUST match the frontend's values exactly ----
// The frontend resolves appId as: typeof __app_id !== 'undefined' ? __app_id : 'validapp-default'.
// Unless you have specifically defined a global __app_id in the page, this default is what's live.
const APP_ID = process.env.VALIDAPP_APP_ID || 'validapp-default';
const SUPABASE_URL = 'https://lnyignnyhihrkjauhzsk.supabase.co'; // same project as the client
const SUPABASE_BUCKET = 'documents';
const ANTHROPIC_MODEL = 'claude-sonnet-5'; // verify current model id at https://docs.claude.com/en/docs/about-claude/models
const MAX_DOCS_ANALYZED = 5;               // cost control: only the N most recent files are read per call
const MAX_CHARS_PER_DOC = 6000;            // cost control: extracted text is truncated per document
const RATE_LIMIT_PER_HOUR = 20;            // cost control: per-user cap across all 3 AI actions

const ROLES = Object.freeze({
  ADMIN: 'Administrator', CREATOR: 'Creator', SECTION_HEAD: 'Section Head',
  DEPUTY: 'Deputy QA Manager', QA_MANAGER: 'QA Manager', REVIEWER: 'Reviewer — Other Department', VIEWER: 'Viewer'
});
const PENDING_STATUSES = ['Pending Section Head', 'Pending Reviewer', 'Pending Deputy QA', 'Pending QA Manager'];

const col = (name) => db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection(name);
const docRef = (name, id) => db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection(name).doc(id);

// =====================================================================
// AUTHORIZATION
// =====================================================================
async function loadCallerProfile(uid) {
  const snap = await docRef('users', uid).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'No ValidApp profile found for this account.');
  const profile = snap.data();
  if (profile.disabled === true) throw new HttpsError('permission-denied', 'This account is disabled.');
  if (!profile.role || !Object.values(ROLES).includes(profile.role)) throw new HttpsError('permission-denied', 'Invalid role.');
  return profile;
}

function assertAuthorized(profile, uid, action, record) {
  const role = profile.role;
  const isOwner = record.createdByUid === uid;
  const isReviewerRole = [ROLES.SECTION_HEAD, ROLES.REVIEWER, ROLES.DEPUTY, ROLES.QA_MANAGER].includes(role);

  if (role === ROLES.ADMIN) return; // full access, but still logged to the audit trail

  if (role === ROLES.VIEWER) {
    if (action === 'summary' && record.status === 'Approved') return;
    throw new HttpsError('permission-denied', 'Viewers may only run AI Summary on Approved studies.');
  }

  if (role === ROLES.CREATOR) {
    if (!isOwner) throw new HttpsError('permission-denied', 'Creators may only run the AI Assistant on their own studies.');
    if (action === 'summary' || action === 'prereview') return;
    throw new HttpsError('permission-denied', 'Creators cannot use Suggest Review Comments.');
  }

  if (isReviewerRole) {
    // Matches the frontend's own data-scoping: a reviewer role only ever loads
    // records that are currently pending at (one of) their stage(s), or terminal
    // records they previously acted on. We allow any non-Draft record here so a
    // reviewer can still run AI Summary/Pre-Review/Comments on something they're
    // about to act on or already reviewed.
    if (record.status === 'Draft') throw new HttpsError('permission-denied', 'This record has not been submitted yet.');
    return;
  }

  throw new HttpsError('permission-denied', 'Your role cannot use the AI Assistant.');
}

async function enforceRateLimit(uid) {
  const ref = docRef('aiRateLimits', uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    let data = snap.exists ? snap.data() : { count: 0, windowStart: now };
    if (now - (data.windowStart || 0) > windowMs) data = { count: 0, windowStart: now };
    if (data.count >= RATE_LIMIT_PER_HOUR) {
      throw new HttpsError('resource-exhausted', 'AI Assistant usage limit reached for this hour.');
    }
    tx.set(ref, { count: data.count + 1, windowStart: data.windowStart, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
}

// =====================================================================
// DOCUMENT TEXT EXTRACTION
// =====================================================================
async function extractDocumentText(supabase, file) {
  try {
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(file.storagePath);
    if (error || !data) return { name: file.name, extracted: false, reason: 'file could not be retrieved', text: '' };
    const buffer = Buffer.from(await data.arrayBuffer());

    if (file.contentType === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(buffer);
      return { name: file.name, extracted: true, text: (parsed.text || '').slice(0, MAX_CHARS_PER_DOC) };
    }
    if (file.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return { name: file.name, extracted: true, text: (result.value || '').slice(0, MAX_CHARS_PER_DOC) };
    }
    if (file.contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || file.contentType === 'application/vnd.ms-excel') {
      const XLSX = require('xlsx');
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const text = wb.SheetNames.map(name => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        return `--- Sheet: ${name} ---\n${csv}`;
      }).join('\n\n');
      return { name: file.name, extracted: true, text: text.slice(0, MAX_CHARS_PER_DOC) };
    }
    if (file.contentType === 'application/msword') {
      return { name: file.name, extracted: false, reason: 'legacy .doc binary format is not supported for extraction - re-upload as .docx if possible', text: '' };
    }
    if (file.contentType && file.contentType.startsWith('image/')) {
      // OCR is not implemented in this pass. Do NOT claim the image was analyzed.
      return { name: file.name, extracted: false, reason: 'OCR not implemented for images', text: '' };
    }
    return { name: file.name, extracted: false, reason: 'unsupported format', text: '' };
  } catch (err) {
    console.error('Extraction failed for', file.name, err);
    return { name: file.name, extracted: false, reason: 'extraction error', text: '' };
  }
}

// =====================================================================
// PROMPTS
// =====================================================================
const GUARDRAILS = `You are an assistant embedded in a pharmaceutical GMP Validation/Quality Management system.
You are a drafting aid only - you never make, imply, or hint at a final compliance, approval, or rejection decision.
Rules you must follow exactly:
- Use ONLY the information provided below (study fields, uploaded-document extracts, and prior review comments). Never invent facts, acceptance criteria, regulatory requirements, or citations.
- Where information is missing or unclear, say exactly: "Not available in the provided information." (for the Summary) or "Insufficient information available to determine this." (for Pre-Review / Comments), rather than guessing.
- Clearly distinguish information actually found in the material from any AI inference.
- For potential issues, phrase findings as "Potential issue identified — human reviewer verification required," never as a definitive non-compliance statement, unless the record itself explicitly states a fact you are just restating.
- Never generate accusatory, alarmist, or unprofessional language.
- Respond with STRICT JSON ONLY - no markdown fences, no commentary before or after the JSON.`;

function buildContextBlock(ctx) {
  const fields = [
    ['Product/API Name', ctx.record.productName], ['Study Category', ctx.record.studyCategory],
    ['Product Type', ctx.record.productType], ['Study Date', ctx.record.date], ['Stage', ctx.record.stage],
    ['Version', ctx.record.version], ['Scale', ctx.record.scale], ['Reviewer Department', ctx.record.reviewerDepartment],
    ['Reason for Validation/Study', ctx.record.reason], ['Notes', ctx.record.notes], ['Status', ctx.record.status]
  ].map(([k, v]) => `${k}: ${v || '(not provided)'}`).join('\n');

  const docsBlock = ctx.docs.length
    ? ctx.docs.map(d => d.extracted ? `\n--- Document: ${d.name} ---\n${d.text}` : `\n--- Document: ${d.name} (content NOT analyzed: ${d.reason}) ---`).join('\n')
    : '\n(No attached documents were available.)';

  const reviewsBlock = ctx.reviews.length
    ? ctx.reviews.map(r => `- [${r.reviewerRole || 'reviewer'}] ${r.action || 'Reviewed'}: ${r.comment || '(no comment)'}`).join('\n')
    : '(No prior review comments.)';

  return `STUDY FIELDS:\n${fields}\n\nATTACHED DOCUMENTS:${docsBlock}\n\nPRIOR REVIEW COMMENTS:\n${reviewsBlock}`;
}

function buildPrompt(action, ctx) {
  const context = buildContextBlock(ctx);
  if (action === 'summary') {
    return `${GUARDRAILS}\n\n${context}\n\nTASK: Produce a concise professional summary as JSON with exactly these string fields: overview, objective, scope, keyParameters, acceptanceCriteria, keyFindings, missingInformation. Each field is plain text (a short paragraph or bullet list as plain text with "- " prefixes). If a field cannot be determined from the material, its value must be exactly "Not available in the provided information."`;
  }
  if (action === 'prereview') {
    return `${GUARDRAILS}\n\n${context}\n\nTASK: Perform an AI Pre-Review. Check, where applicable: study objective, scope, product information, equipment information, study date, version, study stage, validation reason/rationale, acceptance criteria, sampling locations, sampling method, test method, analytical method, number of runs, batch information, equipment identification, critical process parameters, relevant specifications, and consistency (product names, batch numbers, equipment IDs, dates, versions, acceptance criteria, terminology) across the fields and documents. Respond as JSON: { "overallObservations": string, "checks": [ { "check": string, "result": "PASS"|"WARNING"|"POTENTIAL ISSUE"|"NOT FOUND", "details": string } ] }. Only include checks that are actually applicable to the information given; do not pad the list.`;
  }
  // comments
  return `${GUARDRAILS}\n\n${context}\n\nTASK: Draft 2-6 professional, concise, objective, GMP-appropriate review comments/questions a human reviewer could choose to send to the Creator, based only on gaps or ambiguities actually present above (including anything already flagged in prior review comments that remains unresolved). Do not state the study is non-compliant unless the record explicitly says so, and do not invent GMP requirements or regulatory citations. Respond as JSON: { "comments": [string, ...] }.`;
}

async function callAnthropic(apiKey, prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1800,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error('Anthropic API error', resp.status, text);
    throw new HttpsError('internal', 'The AI provider returned an error.');
  }
  const data = await resp.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

function safeParseJson(raw) {
  try {
    // Strip accidental markdown fences defensively even though the prompt forbids them.
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
}

// =====================================================================
// MAIN CALLABLE
// =====================================================================
exports.runAiAssistant = onCall(
  { secrets: [ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY], timeoutSeconds: 60, memory: '512MiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;
    const { studyId, module, action } = request.data || {};

    if (!studyId || typeof studyId !== 'string') throw new HttpsError('invalid-argument', 'studyId is required.');
    if (!['summary', 'prereview', 'comments'].includes(action)) throw new HttpsError('invalid-argument', 'Invalid action.');
    if (module && module !== 'study') throw new HttpsError('invalid-argument', 'AI Assistant currently supports the Studies module only.');

    const profile = await loadCallerProfile(uid);
    await enforceRateLimit(uid);

    const recordSnap = await docRef('records', studyId).get();
    if (!recordSnap.exists) throw new HttpsError('not-found', 'Study not found.');
    const record = recordSnap.data();

    assertAuthorized(profile, uid, action, record);

    // Gather supporting context (bounded for cost control)
    const [filesSnap, reviewsSnap] = await Promise.all([
      col('studyFiles').where('studyId', '==', studyId).get(),
      col('reviews').where('studyId', '==', studyId).get()
    ]);
    const files = filesSnap.docs
      .map(d => d.data())
      .filter(f => !f.deletedAt)
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
      .slice(0, MAX_DOCS_ANALYZED);
    const reviews = reviewsSnap.docs.map(d => d.data());

    let docsAnalyzed = [];
    if (action !== 'comments' || files.length) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.value());
      docsAnalyzed = await Promise.all(files.map(f => extractDocumentText(supabase, f)));
    }

    const prompt = buildPrompt(action, { record, docs: docsAnalyzed, reviews });
    const raw = await callAnthropic(ANTHROPIC_API_KEY.value(), prompt);
    const parsed = safeParseJson(raw);

    const documentsAnalyzedSummary = docsAnalyzed.map(d => ({ name: d.name, extracted: d.extracted, reason: d.reason || null }));

    let result;
    if (!parsed) {
      // Never silently fabricate structure - surface the raw text with a clear warning instead.
      result = action === 'prereview'
        ? { overallObservations: 'The AI response could not be parsed into the expected format. Raw output is shown below for manual review.', checks: [], rawFallback: raw, documentsAnalyzed: documentsAnalyzedSummary }
        : action === 'comments'
          ? { comments: [], rawFallback: raw, documentsAnalyzed: documentsAnalyzedSummary }
          : { overview: raw, objective: '', scope: '', keyParameters: '', acceptanceCriteria: '', keyFindings: '', missingInformation: 'The AI response could not be parsed into the expected format.', documentsAnalyzed: documentsAnalyzedSummary };
    } else {
      result = { ...parsed, documentsAnalyzed: documentsAnalyzedSummary };
    }

    // Audit trail entry - action + a short factual summary only, not the full AI content.
    const actionLabel = action === 'summary' ? 'AI Summary' : action === 'prereview' ? 'AI Pre-Review' : 'AI Review Comment Suggestion';
    let details = 'AI Assistant run.';
    if (action === 'prereview' && parsed) {
      const issues = (parsed.checks || []).filter(c => c.result === 'WARNING' || c.result === 'POTENTIAL ISSUE').length;
      details = `AI Pre-Review completed - ${(parsed.checks || []).length} check(s), ${issues} flagged for human attention.`;
    } else if (action === 'comments' && parsed) {
      details = `${(parsed.comments || []).length} suggested comment(s) generated (not yet used by reviewer).`;
    }
    await col('audit').add({
      userId: uid, userName: profile.displayName || profile.username || uid, userRole: profile.role,
      action: actionLabel, studyId, studyName: record.productName || null,
      previousStatus: null, newStatus: null, details,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), clientTimestamp: new Date().toISOString()
    });

    return result;
  }
);
