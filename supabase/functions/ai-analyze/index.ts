const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    const { trials } = await req.json();
    if (!trials || !Array.isArray(trials) || trials.length < 2) {
      return new Response(JSON.stringify({ error: "Need at least 2 trials" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build trial summary for the prompt
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

      const interventions = (arms.interventions || []).map((iv: any) =>
        `${iv.name} (${iv.type})`
      ).join(", ");

      const armGroups = (arms.armGroups || []).map((a: any) =>
        `${a.label}: ${a.type} - ${(a.interventionNames || []).join(", ")}`
      ).join("\n    ");

      const primary = (out.primaryOutcomes || []).map((o: any) =>
        `${o.measure} (${o.timeFrame || "N/A"})`
      ).join("; ");

      const secondary = (out.secondaryOutcomes || []).slice(0, 5).map((o: any) =>
        `${o.measure}`
      ).join("; ");

      return `
TRIAL ${i + 1}: ${id.nctId || ""}
  Title: ${id.briefTitle || ""}
  Status: ${st.overallStatus || ""}
  Phase: ${(des.phases || []).join(", ") || "N/A"}
  Sponsor: ${sp.leadSponsor?.name || ""}
  Study Type: ${des.studyType || ""}
  Design: ${des.designInfo?.allocation || ""}, ${des.designInfo?.interventionModel || ""}, ${des.designInfo?.primaryPurpose || ""}
  Masking: ${des.designInfo?.maskingInfo?.masking || "N/A"}
  Enrollment: ${des.enrollmentInfo?.count || "N/A"} (${des.enrollmentInfo?.type || ""})
  Eligibility: ${el.sex || "All"}, ${el.minimumAge || "N/A"} - ${el.maximumAge || "N/A"}
  Conditions: ${(p.conditionsModule?.conditions || []).join(", ")}
  Interventions: ${interventions}
  Arms:
    ${armGroups || "N/A"}
  Primary Endpoints: ${primary || "N/A"}
  Secondary Endpoints: ${secondary || "N/A"}
  Brief Summary: ${desc.briefSummary || "N/A"}`;
    }).join("\n\n");

    const prompt = `You are a senior clinical trial analyst at a top pharma competitive intelligence firm. Analyze these ${trials.length} clinical trials comprehensively.

${trialSummaries}

Provide your analysis in the following structure (use HTML formatting with inline styles for readability):

<h3 style="color:#059669;border-bottom:2px solid #10b981;padding-bottom:4px">Executive Summary</h3>
<p>A concise 3-5 sentence briefing that captures the full competitive landscape: what disease area, what MOAs/drugs are being tested, where each trial stands in development, and the key takeaway a pharma executive needs to know. This should read like an intelligence brief — start with the big picture, then narrow to the critical insight.</p>

<h3 style="color:#2563eb">Design Comparison</h3>
<p>Compare study designs: randomization, blinding, control arms, sample sizes, and enrollment strategies. Highlight design choices that give one trial an advantage over others.</p>

<h3 style="color:#7c3aed">Endpoint Analysis</h3>
<p>Compare primary and secondary endpoints. Which trial has stronger, more clinically meaningful, or more regulatory-friendly endpoints? Note any surrogate vs. hard endpoints.</p>

<h3 style="color:#dc2626">Competitive Assessment</h3>
<p>Which trial is best positioned to succeed and why? Consider enrollment feasibility, endpoint selection, sponsor capabilities, and competitive timing. Who wins if all trials succeed?</p>

<h3 style="color:#d97706">Key Risks & Watch Points</h3>
<p>Specific risks for each trial: enrollment challenges, design weaknesses, competitive threats, regulatory hurdles. What could derail each program?</p>

Rules:
- Be specific: cite NCT IDs, exact numbers, drug names
- Be opinionated: give clear assessments, not just descriptions
- Keep each section to 3-5 sentences max
- Write in professional English, accessible to both clinicians and business stakeholders
- Use <strong> for emphasis on key points`;

    // Call Gemini 2.5 Flash
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 2000,
            temperature: 0.3,
          },
        }),
      }
    );

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
    if (user.email !== "mftsky@gmail.com") {
      await supabase.from("activity_logs").insert({
        user_id: user.id,
        email: user.email,
        type: "ai_analysis",
        detail: { nctIds, tokens: { input: usage.promptTokenCount, output: usage.candidatesTokenCount } },
      });
    }

    return new Response(JSON.stringify({
      analysis: text,
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
