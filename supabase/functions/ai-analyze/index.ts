const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEVELOPED = new Set(["United States","Canada","United Kingdom","Germany","France","Italy","Spain","Netherlands","Belgium","Switzerland","Austria","Sweden","Norway","Denmark","Finland","Ireland","Australia","New Zealand","Japan","South Korea","Israel","Singapore"]);

function classifyCountries(locations: any[]): { total: number; us: number; developed: number; developing: number; countries: Record<string,number> } {
  const countries: Record<string,number> = {};
  for (const loc of locations) {
    const c = loc.country || "";
    if (c) countries[c] = (countries[c] || 0) + 1;
  }
  const total = locations.length;
  const us = countries["United States"] || 0;
  let developed = 0, developing = 0;
  for (const [c, n] of Object.entries(countries)) {
    if (DEVELOPED.has(c)) developed += n;
    else developing += n;
  }
  return { total, us, developed, developing, countries };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth check
    const authHeader = req.headers.get("Authorization")!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { trials, lang } = await req.json();
    const LANG_MAP: Record<string,string> = {
      en:'English',ko:'Korean',ja:'Japanese',zh:'Chinese (Simplified)',
      es:'Spanish',pt:'Portuguese',de:'German',fr:'French',ar:'Arabic'
    };
    const langName = LANG_MAP[lang || 'en'] || 'English';
    if (!trials || !Array.isArray(trials) || trials.length < 2) {
      return new Response(JSON.stringify({ error: "Need at least 2 trials" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build comprehensive trial summary
    const trialSummaries = trials.slice(0, 4).map((t: any, i: number) => {
      const p = t.protocolSection || {};
      const id = p.identificationModule || {};
      const st = p.statusModule || {};
      const des = p.designModule || {};
      const sp = p.sponsorCollaboratorsModule || {};
      const el = p.eligibilityModule || {};
      const arms = p.armsInterventionsModule || {};
      const out = p.outcomesModule || {};
      const desc = p.descriptionModule || {};
      const loc = p.contactsLocationsModule || {};

      const interventions = (arms.interventions || []).map((iv: any) =>
        `${iv.name} (${iv.type})`
      ).join(", ");

      const armGroups = (arms.armGroups || []).map((a: any) =>
        `${a.label}: ${a.type} - ${(a.interventionNames || []).join(", ")}${a.description ? " — " + a.description.slice(0, 150) : ""}`
      ).join("\n    ");

      const primary = (out.primaryOutcomes || []).map((o: any) =>
        `${o.measure} [TimeFrame: ${o.timeFrame || "N/A"}]${o.description ? " — " + o.description.slice(0, 200) : ""}`
      ).join("\n    ");

      const secondary = (out.secondaryOutcomes || []).map((o: any) =>
        `${o.measure} [TimeFrame: ${o.timeFrame || "N/A"}]`
      ).join("\n    ");

      // Eligibility criteria (full text, truncated to 2000 chars)
      const eligText = (el.eligibilityCriteria || "").slice(0, 2000);

      // Site geography
      const locations = loc.locations || [];
      const geo = classifyCountries(locations);
      const topCountries = Object.entries(geo.countries)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([c, n]) => `${c}: ${n}`)
        .join(", ");

      return `
TRIAL ${i + 1}: ${id.nctId || ""}
  Title: ${id.briefTitle || ""}
  Official Title: ${id.officialTitle || "N/A"}
  Status: ${st.overallStatus || ""}
  Phase: ${(des.phases || []).join(", ") || "N/A"}
  Sponsor: ${sp.leadSponsor?.name || ""}
  Collaborators: ${(sp.collaborators || []).map((c: any) => c.name).join(", ") || "None"}
  Study Type: ${des.studyType || ""}
  Design: ${des.designInfo?.allocation || ""}, ${des.designInfo?.interventionModel || ""}, ${des.designInfo?.primaryPurpose || ""}
  Masking: ${des.designInfo?.maskingInfo?.masking || "N/A"}${des.designInfo?.maskingInfo?.whoMasked ? " (" + des.designInfo.maskingInfo.whoMasked.join(", ") + ")" : ""}
  Enrollment: ${des.enrollmentInfo?.count || "N/A"} (${des.enrollmentInfo?.type || ""})
  Eligibility: ${el.sex || "All"}, ${el.minimumAge || "N/A"} - ${el.maximumAge || "N/A"}
  Conditions: ${(p.conditionsModule?.conditions || []).join(", ")}
  Keywords: ${(p.conditionsModule?.keywords || []).join(", ") || "N/A"}
  Interventions: ${interventions}
  Arms:
    ${armGroups || "N/A"}
  Primary Endpoints:
    ${primary || "N/A"}
  Secondary Endpoints:
    ${secondary || "N/A"}
  Sites: ${geo.total} total — US: ${geo.us} (${geo.total ? Math.round(geo.us/geo.total*100) : 0}%), Developed: ${geo.developed} (${geo.total ? Math.round(geo.developed/geo.total*100) : 0}%), Developing: ${geo.developing} (${geo.total ? Math.round(geo.developing/geo.total*100) : 0}%)
  Top Countries: ${topCountries || "N/A"}
  Start Date: ${st.startDateStruct?.date || "N/A"}
  Primary Completion: ${st.primaryCompletionDateStruct?.date || "N/A"} (${st.primaryCompletionDateStruct?.type || ""})
  Study Completion: ${st.completionDateStruct?.date || "N/A"} (${st.completionDateStruct?.type || ""})
  First Posted: ${st.studyFirstPostDateStruct?.date || "N/A"}
  Last Update: ${st.lastUpdatePostDateStruct?.date || "N/A"}
  Brief Summary: ${desc.briefSummary || "N/A"}
  Eligibility Criteria:
${eligText || "N/A"}`;
    }).join("\n\n" + "=".repeat(80) + "\n");

    // ── Phase 2 data lookup for Phase 3 trials ──
    // For each P3 drug, find completed P2 trials with results
    const p3Drugs: string[] = [];
    trials.slice(0, 4).forEach((t: any) => {
      const phases = t.protocolSection?.designModule?.phases || [];
      if (phases.some((p: string) => p.includes("3"))) {
        const arms = t.protocolSection?.armsInterventionsModule?.interventions || [];
        arms.filter((iv: any) => iv.type === "DRUG" || iv.type === "BIOLOGICAL")
          .forEach((iv: any) => { if (!p3Drugs.includes(iv.name)) p3Drugs.push(iv.name); });
      }
    });

    async function fetchPhase2Data(drugName: string): Promise<string> {
      try {
        const url = `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(drugName)}&filter.phase=PHASE2&filter.overallStatus=COMPLETED&filter.resultsDateRange=,&fields=protocolSection.identificationModule.nctId,protocolSection.identificationModule.briefTitle,protocolSection.designModule.enrollmentInfo,protocolSection.designModule.phases,hasResults,resultsSection.outcomeMeasuresModule&pageSize=2&sort=@relevance`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return "";
        const data = await res.json();
        const studies = data.studies || [];
        if (studies.length === 0) return "";

        let out = `\nPHASE 2 DATA for "${drugName}":\n`;
        for (const s of studies) {
          const proto = s.protocolSection || {};
          const nctId = proto.identificationModule?.nctId || "";
          const title = proto.identificationModule?.briefTitle || "";
          const enrollment = proto.enrollmentInfo?.count || "N/A";
          out += `  [${nctId}] ${title} (n=${enrollment})\n`;

          // Extract outcome measures with results
          const outcomes = s.resultsSection?.outcomeMeasuresModule?.outcomeMeasures || [];
          outcomes.slice(0, 4).forEach((om: any, idx: number) => {
            const type = om.type || "";
            const measure = om.title || "";
            const desc = (om.description || "").slice(0, 200);
            out += `    ${type}: ${measure}\n`;
            if (desc) out += `      ${desc}\n`;
            // Extract group results
            const groups = om.groups || [];
            const groupTitles = groups.map((g: any) => g.title || "").slice(0, 4);
            const classes = om.classes || [];
            classes.slice(0, 3).forEach((cls: any) => {
              const catTitle = cls.title || "";
              const cats = cls.categories || [];
              cats.slice(0, 2).forEach((cat: any) => {
                const measurements = cat.measurements || [];
                const vals = measurements.slice(0, 4).map((m: any, gi: number) =>
                  `${groupTitles[gi] || "Grp" + gi}: ${m.value || "N/A"}${m.spread ? " ±" + m.spread : ""}`
                ).join(" | ");
                if (vals) out += `      ${catTitle ? catTitle + " — " : ""}${vals}\n`;
              });
            });
          });
          out += "\n";
        }
        return out;
      } catch { return ""; }
    }

    // ── PubMed: fetch top 3 high-IF papers per drug ──
    const HIGH_IF_JOURNALS = '("N Engl J Med"[Journal] OR "Lancet"[Journal] OR "JAMA"[Journal] OR "BMJ"[Journal] OR "Nat Med"[Journal] OR "J Clin Oncol"[Journal] OR "Lancet Oncol"[Journal] OR "Ann Oncol"[Journal] OR "Blood"[Journal] OR "Hepatology"[Journal] OR "Gastroenterology"[Journal] OR "Circulation"[Journal] OR "Eur Heart J"[Journal] OR "Diabetes Care"[Journal] OR "J Hepatol"[Journal] OR "Ann Intern Med"[Journal] OR "Gut"[Journal] OR "JAMA Oncol"[Journal])';

    // Extract unique drug names from trials
    const drugNames = [...new Set(trials.slice(0, 4).flatMap((t: any) => {
      const arms = t.protocolSection?.armsInterventionsModule?.interventions || [];
      return arms.filter((iv: any) => iv.type === "DRUG" || iv.type === "BIOLOGICAL").map((iv: any) => iv.name);
    }))].slice(0, 6);

    // Extract conditions for FDA search
    const conditions = [...new Set(trials.slice(0, 4).flatMap((t: any) =>
      t.protocolSection?.conditionsModule?.conditions || []
    ))].slice(0, 3);

    async function searchPubMed(drugName: string): Promise<string> {
      try {
        // First try high-IF journals
        let url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=3&sort=relevance&term=${encodeURIComponent(drugName)}+AND+${encodeURIComponent(HIGH_IF_JOURNALS)}`;
        let res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        let data = await res.json();
        let ids = data.esearchresult?.idlist || [];

        // Fallback: no journal filter
        if (ids.length === 0) {
          url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=3&sort=relevance&term=${encodeURIComponent(drugName)}+AND+(clinical+trial+OR+phase)`;
          res = await fetch(url, { signal: AbortSignal.timeout(5000) });
          data = await res.json();
          ids = data.esearchresult?.idlist || [];
        }
        if (ids.length === 0) return "";

        // Fetch summaries + abstracts
        const sumRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`, { signal: AbortSignal.timeout(5000) });
        const sumData = await sumRes.json();

        const absRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${ids.join(",")}`, { signal: AbortSignal.timeout(5000) });
        const absText = await absRes.text();
        // Split abstracts by double newline + number pattern
        const abstracts = absText.split(/\n\n(?=\d+\.\s)/).map(a => a.trim());

        let result = `\nKEY PUBLICATIONS for "${drugName}":\n`;
        ids.forEach((id: string, idx: number) => {
          const article = sumData.result?.[id];
          if (!article) return;
          const title = article.title || "";
          const journal = article.fulljournalname || article.source || "";
          const year = (article.pubdate || "").substring(0, 4);
          const authors = (article.authors || []).slice(0, 3).map((a: any) => a.name).join(", ");
          // Extract abstract for this article (rough match)
          const absForThis = abstracts[idx]?.substring(0, 800) || "";
          result += `  [${idx + 1}] ${title}\n      ${authors} et al. ${journal} (${year}) PMID:${id}\n      Abstract: ${absForThis}\n\n`;
        });
        return result;
      } catch { return ""; }
    }

    // ── openFDA: recent drug approvals/labels for the conditions ──
    async function searchFDAbyCondition(condition: string): Promise<string> {
      try {
        const url = `https://api.fda.gov/drug/drugsfda.json?search=indications_and_usage:"${encodeURIComponent(condition)}"&limit=5&sort=submissions.submission_date:desc`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return "";
        const data = await res.json();
        const results = data.results || [];
        if (results.length === 0) return "";

        let out = `\nFDA APPROVED DRUGS for "${condition}":\n`;
        results.forEach((r: any, i: number) => {
          const brand = r.openfda?.brand_name?.[0] || "Unknown";
          const generic = r.openfda?.generic_name?.[0] || "";
          const sponsor = r.sponsor_name || "";
          const subs = r.submissions || [];
          const latest = subs[0] || {};
          const date = latest.submission_date || "";
          const type = latest.submission_type || "";
          out += `  [${i + 1}] ${brand} (${generic}) — ${sponsor}, ${type} ${date ? date.substring(0, 4) + "-" + date.substring(4, 6) : "N/A"}\n`;
        });
        return out;
      } catch { return ""; }
    }

    // ── openFDA: drug-specific label/approval info ──
    async function searchFDAbyDrug(drugName: string): Promise<string> {
      try {
        const url = `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${encodeURIComponent(drugName)}"+OR+openfda.brand_name:"${encodeURIComponent(drugName)}"&limit=2`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return "";
        const data = await res.json();
        const results = data.results || [];
        if (results.length === 0) return "";

        let out = `\nFDA LABEL INFO for "${drugName}":\n`;
        results.forEach((r: any, i: number) => {
          const brand = r.openfda?.brand_name?.[0] || "";
          const generic = r.openfda?.generic_name?.[0] || "";
          const indications = (r.indications_and_usage?.[0] || "").slice(0, 500);
          const warnings = (r.boxed_warning?.[0] || r.warnings?.[0] || "").slice(0, 300);
          const effectiveDate = r.effective_time || "";
          out += `  [${i + 1}] ${brand} (${generic}) — Effective: ${effectiveDate ? effectiveDate.substring(0, 4) + "-" + effectiveDate.substring(4, 6) : "N/A"}\n`;
          out += `      Indications: ${indications}\n`;
          if (warnings) out += `      Key Warnings: ${warnings}\n`;
        });
        return out;
      } catch { return ""; }
    }

    // ── PubMed: recent reviews/guidelines for landscape context ──
    async function searchRecentReviews(condition: string): Promise<string> {
      try {
        const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=3&sort=date&term=${encodeURIComponent(condition)}+AND+(review[pt] OR guideline[pt] OR "FDA approval" OR "regulatory")+AND+("last 2 years"[dp])`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        const ids = data.esearchresult?.idlist || [];
        if (ids.length === 0) return "";

        const sumRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`, { signal: AbortSignal.timeout(5000) });
        const sumData = await sumRes.json();

        let out = `\nRECENT REVIEWS/GUIDELINES for "${condition}":\n`;
        ids.forEach((id: string, idx: number) => {
          const article = sumData.result?.[id];
          if (!article) return;
          out += `  [${idx + 1}] ${article.title}\n      ${article.source || ""} (${(article.pubdate || "").substring(0, 4)}) PMID:${id}\n`;
        });
        return out;
      } catch { return ""; }
    }

    // Parallel fetch: PubMed + FDA (condition) + FDA (drug) + Recent reviews + Phase 2 data
    const [pubmedResults, fdaCondResults, fdaDrugResults, reviewResults, p2Results] = await Promise.all([
      Promise.all(drugNames.map(d => searchPubMed(d))),
      Promise.all(conditions.map(c => searchFDAbyCondition(c))),
      Promise.all(drugNames.map(d => searchFDAbyDrug(d))),
      Promise.all(conditions.map(c => searchRecentReviews(c))),
      Promise.all(p3Drugs.slice(0, 4).map(d => fetchPhase2Data(d))),
    ]);

    const pubmedSection = pubmedResults.filter(Boolean).join("\n");
    const fdaCondSection = fdaCondResults.filter(Boolean).join("\n");
    const fdaDrugSection = fdaDrugResults.filter(Boolean).join("\n");
    const reviewSection = reviewResults.filter(Boolean).join("\n");
    const p2Section = p2Results.filter(Boolean).join("\n");
    const externalData = [pubmedSection, fdaCondSection, fdaDrugSection, reviewSection, p2Section].filter(Boolean).join("\n" + "=".repeat(40) + "\n");

    const prompt = `You are a senior clinical trial analyst at a top pharma competitive intelligence firm specializing in regulatory strategy. Perform a deep comparative analysis of these ${trials.length} clinical trials.

${trialSummaries}

${"=".repeat(80)}
EXTERNAL REFERENCES (PubMed, FDA, Phase 2 Results):
${externalData || "(No external data retrieved)"}
${"=".repeat(80)}

CRITICAL INSTRUCTION: You are NOT a summarizer. You are an expert analyst. Do NOT simply restate what the protocol says. Instead, REASON about what each design choice ACTUALLY MEANS in practice:
- If a trial uses hard endpoints only (e.g., liver-related clinical events), calculate how long event accrual will realistically take given enrollment size and event rates in this population. A 4500-patient trial with hard endpoints does NOT mean "faster" — it likely means 5+ years to readout.
- If a trial uses biopsy-based surrogate endpoints (e.g., fibrosis improvement ≥1 stage), explain that this enables accelerated/conditional approval in 2-3 years, while hard endpoint data accumulates in parallel.
- When discussing MOAs, draw on Phase 2 data provided in the EXTERNAL REFERENCES section AND your knowledge of supplementary materials. For Phase 3 trials, the Phase 2 outcome data with actual numerical results is provided above — cite specific response rates, effect sizes, p-values, and group comparisons from that data. For example, if a GLP-1/Glucagon dual agonist showed superior fibrosis resolution vs. GLP-1 alone in Phase 2 supplementary data, cite that specific finding.
- Do NOT say "master protocol provides competitive advantage" without analyzing whether the endpoint choice within that protocol actually supports faster regulatory path.
- Always distinguish between: time to data readout vs. time to regulatory submission vs. time to market.

Provide your analysis in the following structure. Use HTML with inline styles. Be specific — cite NCT IDs, drug names, exact numbers, and percentages. Be opinionated — give clear assessments, not just descriptions. Use <strong> for key insights.

<h3 style="color:#059669;border-bottom:2px solid #10b981;padding-bottom:4px">1. Executive Summary</h3>
<p>3-5 sentence intelligence brief: disease area, MOAs/drugs being tested, development stage of each, and the single most important competitive insight. End with a clear verdict on which program has the strongest position.</p>

<h3 style="color:#2563eb;border-bottom:2px solid #60a5fa;padding-bottom:4px">2. Study Design & Protocol Comparison</h3>
<p>Do NOT just list design features. ANALYZE their implications:
- Single-blind vs double-blind: what specific biases does this introduce? Does the investigator knowing allocation affect endpoint assessment (e.g., biopsy scoring)?
- Sample size: is it powered for the chosen endpoint? For event-driven hard endpoints, estimate realistic event accrual time based on expected annual event rates in this population.
- Master protocol / adaptive designs: do they actually accelerate anything, or do they add operational complexity? Be honest about tradeoffs.
- Control arm choice: is placebo still ethical given existing approved therapies? Could regulators demand an active comparator?</p>

<h3 style="color:#7c3aed;border-bottom:2px solid #a78bfa;padding-bottom:4px">3. Endpoint Strategy & Regulatory Implications</h3>
<p>This is critical. For each trial, classify primary endpoints as:
- <strong>Hard endpoints</strong> (OS, event-free survival, major clinical events)
- <strong>Soft/surrogate endpoints</strong> (ORR, biomarker change, PROs)
- <strong>Composite endpoints</strong> (specify components)

Analyze: If a trial uses only soft endpoints in Phase 2/3, what does this mean for regulatory path? Could it get accelerated approval but face confirmatory trial requirements? If one trial has a Part 1 (surrogate) → Part 2 (hard endpoint) design, explain the regulatory strategy (e.g., conditional/accelerated approval on Part 1, full approval on Part 2). Compare endpoint rigor across trials — which has the strongest path to full approval vs. which might get stuck in conditional approval limbo?

Also compare secondary endpoints — which trial has the most comprehensive endpoint package that addresses both efficacy and safety concerns regulators will raise?</p>

<h3 style="color:#0891b2;border-bottom:2px solid #22d3ee;padding-bottom:4px">4. Eligibility & Patient Population</h3>
<p>Compare inclusion/exclusion criteria across trials. Identify:
- Key differences in patient selection (prior treatment lines, biomarker requirements, disease severity)
- Which trial has broader vs. narrower enrollment criteria and what that implies for generalizability
- Age/sex restrictions that may affect enrollment speed
- Any criteria that could create enrichment bias (selecting patients more likely to respond)
Flag specific inclusion/exclusion differences that could meaningfully impact outcomes or head-to-head comparisons.</p>

<h3 style="color:#0d9488;border-bottom:2px solid #2dd4bf;padding-bottom:4px">5. Geographic & Site Strategy</h3>
<p>Analyze site distribution: US proportion, developed vs. developing country ratio. What does heavy reliance on developing-country sites mean for:
- FDA acceptance of data (ICH E17 considerations)
- Enrollment speed vs. data quality tradeoffs
- Standard-of-care differences across regions
- Ethnic/genetic diversity implications
Which trial has the most FDA/EMA-friendly site distribution?</p>

<h3 style="color:#dc2626;border-bottom:2px solid #f87171;padding-bottom:4px">6. Competitive Assessment & Probability of Success</h3>
<p>Rate each trial's probability of success (qualitative: High/Medium/Low) considering:
- Endpoint strength and regulatory path clarity
- Enrollment feasibility given criteria and site count
- Sponsor track record and capabilities
- Competitive timing — who reads out first?
- MOA differentiation
Who wins if all trials succeed? Who has the best risk-adjusted position?</p>

<h3 style="color:#d97706;border-bottom:2px solid #fbbf24;padding-bottom:4px">7. Key Risks & Watch Points</h3>
<p>For each trial, list 2-3 specific risks: enrollment challenges, design weaknesses, competitive threats, regulatory hurdles, safety signals to watch. What single event could derail each program?</p>

<h3 style="color:#9333ea;border-bottom:2px solid #c084fc;padding-bottom:4px">8. Timeline & Market Forecast</h3>
<p>For each trial, estimate based on enrollment size, site count, primary completion date, and current status:
- <strong>Topline data readout</strong>: When is it likely? Use primary completion date + typical analysis lag (3-6 months). If enrollment is slow relative to target, adjust estimate accordingly.
- <strong>Regulatory submission</strong>: Estimate NDA/BLA/MAA filing timeline based on endpoint type (accelerated vs standard pathway).
- <strong>Approval forecast</strong>: Expected approval date. If using surrogate endpoints, note whether conditional/accelerated approval is the likely first step, and when full approval might follow.
- <strong>Phase 2 efficacy/safety forecast</strong>: Based on MOA, drug class, patient population, and endpoint selection, predict likely efficacy signal strength and key safety concerns to watch. Reference known class effects if applicable. For Phase 2 trials, assess whether the trial design is powered to show meaningful differentiation.
- <strong>Market positioning</strong>: If approved, where does each drug fit in the treatment landscape? First-in-class advantage? Best-in-class potential? What existing treatments does it compete with? Estimate market potential relative to competitors (dominant vs. niche vs. me-too).
Be concrete with dates (e.g., "Q3 2027") rather than vague ("in the coming years").</p>

<h3 style="color:#0369a1;border-bottom:2px solid #38bdf8;padding-bottom:4px">9. Literature & Regulatory Context</h3>
<p>Using the PubMed publications and FDA approval data provided above:
- Cite the most relevant publications for each drug — what do they show about efficacy/safety from earlier trials?
- Reference any FDA-approved competitors in this indication — how do approved drugs' profiles compare to what these trials are testing?
- If key Phase 2 data exists in the literature, summarize the efficacy signals and safety profile that inform Phase 3 expectations.
- Include PMID links where available: format as <a href="https://pubmed.ncbi.nlm.nih.gov/PMID" style="color:#0284c7;text-decoration:none">PMID:NUMBER</a>
If no relevant publications or FDA data were found, state that and rely on your knowledge.</p>

Rules:
- NEVER cite an NCT ID alone. ALWAYS pair it with the drug name, e.g., "survodutide (NCT06789012)" or "NCT06789012 (survodutide)". A standalone NCT ID without the drug name is FORBIDDEN.
- Be specific: cite exact numbers, drug names, country percentages
- Be opinionated: give clear assessments and verdicts, not balanced-both-sides descriptions
- USE the external references (PubMed, FDA labels, recent reviews) provided above to ground your analysis in the LATEST evidence. Reference recent approvals, guideline changes, and regulatory trends from the data. Do NOT rely solely on your training data for regulatory landscape — use the retrieved data.
- ABSOLUTE MINIMUM LENGTH: ${trials.slice(0,4).length} trials × 1700 tokens = ${trials.slice(0,4).length * 1700} tokens MINIMUM. You MUST write at least this many tokens. Count carefully. If your response would be shorter than ${trials.slice(0,4).length * 1700} tokens, you MUST go back and add more detail to each section until you reach the minimum. Each of the 9 sections should be roughly ${Math.round(trials.slice(0,4).length * 1700 / 9)} tokens.
- Each section: minimum 10-20 sentences. Every trial must get substantial individual analysis in every section — not just a passing mention. Include specific numbers, dates, comparisons, and reasoning for each trial individually.
- Do NOT summarize briefly. If a section feels "done" after 5 sentences, you have NOT written enough. SHORT RESPONSES ARE A FAILURE.
- Professional English accessible to both clinicians and business stakeholders
- Use <strong> for emphasis, <br> for line breaks within sections
- USE HTML TABLES extensively for comparisons. When comparing 2+ trials on any dimension (endpoints, eligibility, sites, timelines, etc.), present it as a styled HTML table:
  <table style="width:100%;border-collapse:collapse;font-size:.8rem;margin:8px 0"><tr style="background:#f0fdf4"><th style="border:1px solid #d1d5db;padding:6px;text-align:left">...</th></tr><tr><td style="border:1px solid #e5e7eb;padding:6px">...</td></tr></table>
- Do NOT use markdown — only HTML with inline styles
- Do NOT cut the analysis short. If you run out of space, prioritize completing all 9 sections over being brief in early sections.
- IMPORTANT: Write the ENTIRE analysis in ${langName}. Section headings, analysis text, and all content must be in ${langName}. Keep NCT IDs and drug names in their original form.
- CRITICAL: For ALL technical/medical/regulatory terms, ALWAYS include the English term in parentheses after the translated term. Examples: 무작위배정(Randomization), 이중맹검(Double-blind), 主要终点(Primary Endpoint), 加速承認(Accelerated Approval), 全生存期(Overall Survival), Gesamtüberleben(Overall Survival). This applies to every language except English.

FINAL REMINDER — LENGTH CHECK:
Your output MUST be at least ${trials.slice(0,4).length * 1700} tokens. That means each of the 9 sections must average at least ${Math.round(trials.slice(0,4).length * 1700 / 9)} tokens. If any section is under 5 sentences, EXPAND it with more analysis, comparisons, tables, and trial-specific detail. An output under ${trials.slice(0,4).length * 1700} tokens is UNACCEPTABLE and constitutes a failed analysis. Write MORE, not less.`;

    // Call Gemini (cascade: 3.1 Flash Lite → 3 Flash → 2.5 Flash)
    const headers = { "Content-Type": "application/json" };

    const models = [
      { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash-Lite", thinking: false },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash", thinking: true },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", thinking: true },
    ];
    let geminiRes!: Response;
    let usedModel = models[0].name;
    for (const m of models) {
      const genConfig: any = { maxOutputTokens: 32000, temperature: 0.5 };
      if (m.thinking) genConfig.thinkingConfig = { thinkingBudget: 4096 };
      const reqBody = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: genConfig,
      });
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m.id}:generateContent?key=${GEMINI_KEY}`,
        { method: "POST", headers, body: reqBody }
      );
      if (geminiRes.ok) { usedModel = m.name; break; }
      usedModel = m.name + " (failed)";
    }

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      return new Response(JSON.stringify({ error: "AI API error", detail: geminiData }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "No analysis generated.";
    const usage = geminiData.usageMetadata || {};

    // Log AI usage (skip master)
    const nctIds = trials.slice(0, 4).map((t: any) =>
      t?.protocolSection?.identificationModule?.nctId || ""
    ).filter(Boolean);
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || "unknown";
    if (user.email !== "mftsky@gmail.com") {
      await supabase.from("activity_logs").insert({
        user_id: user.id,
        email: user.email,
        type: "ai_analysis",
        detail: { nctIds, model: usedModel, ip: clientIp, tokens: { input: usage.promptTokenCount, output: usage.candidatesTokenCount } },
      });
    }

    return new Response(JSON.stringify({
      analysis: text,
      model: usedModel,
      tokens: { input: usage.promptTokenCount, output: usage.candidatesTokenCount },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
