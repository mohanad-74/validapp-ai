# ValidApp — AI Assistant & Calibration Excel Import

## Files delivered

| File | Status | What it is |
|---|---|---|
| `ValidApp_updated.html` | **Modified** | Your uploaded `full_code.txt`, extended in place. Every existing feature (Azure SSO, Firebase Auth, Supabase file storage, Studies workflow, Calibration/Qualification, User Management, Audit Trail, EmailJS) is untouched. |
| `functions/index.js` | **Added** | Secure Cloud Function backend for the AI Assistant. This is the only place the AI API key is used. |
| `functions/package.json` | **Added** | Dependencies for the function (firebase-admin, firebase-functions, Supabase client, pdf-parse, mammoth, xlsx). |
| `firestore-rules-snippet.txt` | **Added (reference only)** | An optional addition for a new `aiRateLimits` collection. See note below — you likely don't need to change your rules at all. |
| This file | **Added** | Setup, deployment and testing guide. |

Nothing about your Firebase project, Supabase project, users, existing studies, Calibration/Qualification records, or audit history was touched or migrated.

---

## 1. What was added, and why

### A. Calibration module fields + Excel import
The Calibration and Qualification modules previously shared one generic form (name, reference, category, equipment, date, description). Calibration records now also carry a dedicated certificate-register field set:

`Certificate No., Dept., Instrument, Manuf., Model, S.N, Code, Location, Cal.range, AcceptanceLimits, interval, Cal.Date, Due Date, Month-Year`

These only appear when the module is Calibration (Qualification is unchanged). Two ways to fill them:
- **Single record → "Fill from Excel"** (inside the Add/Edit Calibration modal): reads the first row of a selected file and fills the form. You still review and click Save.
- **Toolbar → "Import from Excel"** (Calibration list view, Admin/Creator only): reads an entire register and creates one **Draft** Calibration record per row (batched Firestore writes). Every imported record still goes through the normal Section Head → QA Manager review before it becomes Completed — the import only replaces manual re-typing, not the workflow.

Column headers are matched loosely (case/spacing/punctuation-insensitive), so "Cal.range", "Cal Range", "CAL RANGE" all resolve to the same field. Parsing happens entirely in the browser via SheetJS (loaded from jsDelivr) — the spreadsheet contents never leave the user's machine except as the individual field values written to Firestore.

### B. AI Assistant (Summary / Pre-Review / Suggest Review Comments)
An "AI Assistant" button now appears next to Files/History on each Study row, for: the owning Creator, every reviewer-stage role (Section Head, Reviewer, Deputy QA Manager, QA Manager), and Administrator. Viewers get a narrower "AI Summary" button, visible only on **Approved** studies.

It opens a modal with the three buttons from your spec, a loading indicator, and a results panel that renders:
- **AI Summary** — Overview / Objective / Scope / Key Parameters / Acceptance Criteria / Key Findings / Potential Missing Information, each explicitly marked `Not available in the provided information.` when nothing was found.
- **AI Pre-Review** — an "Overall observations" line plus a Check / Result / Details table using PASS / WARNING / POTENTIAL ISSUE / NOT FOUND.
- **Suggest Review Comments** — a list of draft comments, each with **Use for Review Comment** and **Edit**. "Use" *stages* the text; it is inserted into the existing "Complete Review" / "Return" comment box the next time the reviewer opens it, fully editable, and nothing is submitted until the human clicks through that dialog themselves. There is no `Cancel`/apply-immediately path — the AI can never write a review comment on its own.

Every panel carries a persistent "AI-generated assistance — human review required" banner, and a "Documents considered" footnote that says exactly which attached files were actually text-extracted vs. not (so the UI never implies a document was read when it wasn't).

**The AI never touches `updateDoc`/`addDoc` on `records`, `calibration`, `qualification`, or `reviews`.** It cannot submit, approve, reject, return, or change status — those functions are completely separate from the AI code path.

---

## 2. The secure backend (why it's a separate deployment step)

Per your instruction #9, the AI API key cannot live in the browser. `full_code.txt` is a static HTML file with no server — so a minimal Cloud Functions project (`functions/`) was added. This is a **separate deployment** from the HTML file:

```bash
cd functions
npm install
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
firebase deploy --only functions:runAiAssistant
```

- **`ANTHROPIC_API_KEY`** — get one at https://console.anthropic.com. The function calls `POST https://api.anthropic.com/v1/messages` directly; swap this block for OpenAI's Chat Completions endpoint if you prefer that provider — the rest of the function (auth, authorization, extraction, audit) doesn't need to change.
- **`SUPABASE_SERVICE_ROLE_KEY`** — Supabase dashboard → Project Settings → API → `service_role` key. This lets the *function* read uploaded documents server-side regardless of your bucket's RLS policy; it is stored in Secret Manager, never in the HTML.
- **Requires the Blaze (pay-as-you-go) Firebase plan.** Cloud Functions v2 does not run on the free Spark plan. Cost is bounded by real usage — nothing runs until a user clicks a button (see cost controls below).
- If your Firestore documents actually resolve `appId` to something other than the default `'validapp-default'` (i.e., you define a global `__app_id` somewhere), set that as the `VALIDAPP_APP_ID` environment variable for the function, or edit the constant at the top of `index.js` — otherwise the function will look in the wrong Firestore path and every call will fail with "Study not found."

### How authorization actually works (defense in depth)
The Firebase client SDK's `httpsCallable` automatically attaches and the function automatically verifies the caller's Firebase ID token — that's the "backend verifies the authenticated user" requirement satisfied structurally, not by hand-rolled JWT parsing. On top of that, the function independently:
1. Loads the caller's `users/{uid}` profile via the Admin SDK and rejects disabled accounts / invalid roles.
2. Re-derives the same role rules described in your spec (Creator: own studies, Summary+Pre-Review only; reviewer roles: all three; Viewer: Summary on Approved only; Admin: everything) — it does **not** trust anything the client claims about the user's role.
3. Loads the actual study document and rejects if it doesn't exist.
4. Applies a per-user rate limit (20 calls/hour, adjustable) as a cost/abuse control independent of the "don't auto-run" UI behavior.

A user who bypasses the UI and calls the function directly is still bound by all of the above — the browser code is convenience, not the security boundary.

### Document extraction — what's real vs. not yet built
- **PDF** → real text extraction (`pdf-parse`).
- **DOCX** → real text extraction (`mammoth`).
- **XLSX/XLS** → each sheet converted to CSV text (`xlsx`/SheetJS) and included.
- **Legacy `.doc`** → not extracted (binary format); flagged as such.
- **JPG/PNG** → **not OCR'd in this pass** — flagged as "OCR not implemented" and excluded from analysis, per your instruction not to claim analysis that didn't happen. Adding OCR later (e.g., Google Cloud Vision or Document AI) is a contained change inside `extractDocumentText()`.
- Only the 5 most recently uploaded files per study are analyzed, and extracted text is capped at 6,000 characters per document — both are cost/latency controls, and both are configurable constants at the top of `index.js`.

---

## 3. Firestore rules

The function uses the Firebase **Admin SDK**, which bypasses Firestore Security Rules entirely by design — so **no rules changes are required for the AI feature to work**, and nothing about your existing rules needs to weaken.

The only new piece of client-adjacent state is a rate-limit counter document (`artifacts/{appId}/public/data/aiRateLimits/{uid}`), written only by the function. If your existing rules end with an explicit "deny everything else" (the standard, recommended pattern), that collection is already inaccessible to clients and you don't need to do anything. If you're not certain, `firestore-rules-snippet.txt` has an explicit deny rule you can paste in — it's inert if your rules already deny-by-default.

I don't have your actual deployed `firestore.rules` file (it wasn't part of `full_code.txt`), so I haven't attempted to regenerate or replace it — if you'd like it reviewed for the "no rule weakened" requirement, paste it in and I'll check it against this feature specifically.

---

## 4. Testing checklist

**Calibration Excel import**
- [ ] Single-record "Fill from Excel" populates all 14 fields from a sample register row and the form is still fully editable before Save.
- [ ] Toolbar "Import from Excel" previews row count and sample columns, then creates that many Draft records; each shows up in the Calibration list with Certificate No. / Due Date visible.
- [ ] A file with none of the expected headers shows the "no matching columns" error instead of importing blank records.
- [ ] Imported Draft records still require Section Head → QA Manager review to reach Completed — nothing is auto-approved.

**AI Assistant — per role**
- [ ] Creator: sees AI Summary + AI Pre-Review only, only on their own studies.
- [ ] Section Head / Reviewer / Deputy QA Manager / QA Manager: see all three buttons.
- [ ] Viewer: sees only "AI Summary", only on Approved studies.
- [ ] Administrator: sees all three, on any study.
- [ ] AI Pre-Review renders a PASS/WARNING/POTENTIAL ISSUE/NOT FOUND table; AI Summary shows "Not available in the provided information." for genuinely empty fields.
- [ ] "Use for Review Comment" on a suggestion, then opening "Complete Review", shows the staged text in the comment box — editable, not yet submitted.
- [ ] Running the AI does **not** change the study's status, and no workflow button becomes auto-enabled/disabled because of it.
- [ ] Audit Trail shows an "AI Summary" / "AI Pre-Review" / "AI Review Comment Suggestion" entry after each run, without the full AI text embedded in it.
- [ ] Calling the function 21+ times in an hour as one user returns a clear rate-limit message, not a crash.
- [ ] Viewing the deployed page's source / devtools network tab shows no Anthropic (or OpenAI) key anywhere in the client bundle or requests — only calls to your own Cloud Function URL.

**Regression (must still work exactly as before)**
- [ ] Login (Azure SSO + email/password), existing users, existing roles.
- [ ] Study create/edit/submit/review/return/approve/reject.
- [ ] Calibration/Qualification create/edit/submit/review/return for non-imported records.
- [ ] Document upload/view/download/delete via Supabase.
- [ ] Audit Trail and User Management screens.
