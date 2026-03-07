import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization")!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { slotIndex } = await req.json();

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (!sub || !sub.keywords || !sub.keywords[slotIndex]) {
      return new Response(JSON.stringify({ error: "Slot not found" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sent = sub.monthly_sent || 0;
    if (sent >= 10) {
      return new Response(JSON.stringify({ error: "Monthly limit reached (10/10)" }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const slot = sub.keywords[slotIndex];

    // Date range based on schedule
    const st = sub.schedule_type || "monthly";
    const days = st === "weekly" ? 7 : st === "bimonthly" ? 60 : 30;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    // Query ClinicalTrials.gov
    let studies: any[] = [];

    if (slot.nctIds && slot.nctIds.length > 0) {
      // Compare/Watch mode: fetch specific trials by NCT ID
      const fetches = slot.nctIds.map(async (nctId: string) => {
        try {
          const res = await fetch(`https://clinicaltrials.gov/api/v2/studies/${nctId}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) return await res.json();
        } catch { /* skip failed */ }
        return null;
      });
      const results = await Promise.all(fetches);
      // Filter to only trials updated within the date range
      studies = results.filter(Boolean).filter((s: any) => {
        const lu = s?.protocolSection?.statusModule?.lastUpdatePostDateStruct?.date || "";
        return lu >= since;
      });
    } else {
      // Search/Drug mode: query with filters
      const params = new URLSearchParams({ format: "json", pageSize: "50", sort: "LastUpdatePostDate:desc" });
      const queryParts: string[] = [];
      if (slot.condition) queryParts.push(`AREA[Condition]${slot.condition}`);
      if (slot.intervention) queryParts.push(`AREA[InterventionName]${slot.intervention}`);
      if (slot.sponsor) queryParts.push(`AREA[LeadSponsorName]${slot.sponsor}`);
      if (slot.keyword) queryParts.push(slot.keyword);
      if (slot.country) queryParts.push(`AREA[LocationCountry]${slot.country}`);
      if (queryParts.length > 0) params.set("query.term", queryParts.join(" AND "));

      const advParts: string[] = [];
      advParts.push(`AREA[LastUpdatePostDate]RANGE[${since},${today}]`);
      if (slot.phases?.length > 0) advParts.push(`AREA[Phase](${slot.phases.join(" OR ")})`);
      params.set("filter.advanced", advParts.join(" AND "));

      if (slot.statuses?.length > 0) params.set("filter.overallStatus", slot.statuses.join("|"));

      const ctRes = await fetch(`https://clinicaltrials.gov/api/v2/studies?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      const ctData = await ctRes.json();
      studies = ctData.studies || [];
    }

    if (studies.length === 0) {
      return new Response(JSON.stringify({ message: "No trials found for this filter.", count: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Format trials with change detection + fetch history for each
    const trialList = studies.slice(0, 20).map((s: any) => {
      const p = s.protocolSection || {};
      const id = p.identificationModule || {};
      const st = p.statusModule || {};
      const sp = p.sponsorCollaboratorsModule || {};
      const des = p.designModule || {};
      const enroll = des.enrollmentInfo || {};

      const firstPost = st.studyFirstPostDateStruct?.date || "";
      const lastUpdate = st.lastUpdatePostDateStruct?.date || "";
      const isNew = firstPost >= since;

      return {
        nctId: id.nctId || "",
        title: id.briefTitle || "No title",
        status: st.overallStatus || "",
        phase: (des.phases || []).join(", ") || "N/A",
        sponsor: sp.leadSponsor?.name || "",
        enrollment: enroll.count || null,
        isNew,
        firstPost,
        lastUpdate,
        changedModules: [] as string[],
        version: 0,
        prevStatus: "",
      };
    });

    // Fetch version history for each trial (parallel, with timeout)
    await Promise.all(trialList.map(async (t) => {
      if (t.isNew) return;
      try {
        const hRes = await fetch(`https://clinicaltrials.gov/api/int/studies/${t.nctId}/history`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!hRes.ok) return;
        const hData = await hRes.json();
        const changes = hData.changes || [];
        if (changes.length >= 2) {
          const latest = changes[changes.length - 1];
          const prev = changes[changes.length - 2];
          t.version = latest.version;
          t.prevVersion = prev.version;
          t.changedModules = latest.moduleLabels || [];
          if (prev.status && prev.status !== latest.status) {
            t.prevStatus = prev.status;
          }
        }
      } catch { /* timeout or error, skip */ }
    }));

    const trials = trialList;

    // Build email HTML
    const isCompareMode = !!(slot.nctIds && slot.nctIds.length > 0);
    const filterParts: string[] = [];
    if (isCompareMode) {
      filterParts.push(`Watching ${slot.nctIds.length} trial(s): ${slot.nctIds.join(", ")}`);
    } else {
      if (slot.condition) filterParts.push(`Condition: ${slot.condition}`);
      if (slot.intervention) filterParts.push(`Intervention: ${slot.intervention}`);
      if (slot.sponsor) filterParts.push(`Sponsor: ${slot.sponsor}`);
      if (slot.keyword) filterParts.push(`Keyword: ${slot.keyword}`);
      if (slot.country) filterParts.push(`Country: ${slot.country}`);
    }
    const filterDesc = filterParts.join(" | ") || "All";
    const now = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    const newCount = trials.filter((t: any) => t.isNew).length;
    const updatedCount = trials.length - newCount;

    const trialRows = trials.map((t: any) => {
      const sc = t.status === "RECRUITING" ? "#16a34a" : t.status.includes("ACTIVE") ? "#f59e0b" : "#6b7280";
      const changeBadge = t.isNew
        ? `<span style="font-size:9px;font-weight:700;color:#fff;background:#16a34a;padding:2px 6px;border-radius:3px;margin-right:4px">NEW</span>`
        : `<span style="font-size:9px;font-weight:700;color:#fff;background:#3b82f6;padding:2px 6px;border-radius:3px;margin-right:4px">UPDATED</span>`;
      const statusChange = t.prevStatus
        ? `<div style="font-size:10px;margin-top:4px"><span style="color:#dc2626;text-decoration:line-through">${t.prevStatus.replace(/_/g," ")}</span> → <span style="color:#16a34a;font-weight:600">${t.status.replace(/_/g," ")}</span></div>`
        : '';
      const modules = (!t.isNew && t.changedModules.length > 0)
        ? `<div style="font-size:10px;color:#6366f1;margin-top:4px">Changed: ${t.changedModules.join(", ")}</div>`
        : '';
      // API versions are 0-based, website displays 1-based
      const diffUrl = (!t.isNew && t.version > 0 && t.prevVersion !== undefined)
        ? `https://clinicaltrials.gov/study/${t.nctId}?tab=history&a=${t.prevVersion+1}&b=${t.version+1}#version-content-panel`
        : '';
      const trialUrl = `https://clinicaltrials.gov/study/${t.nctId}`;
      const versionInfo = t.version > 0 ? ` · v${t.version + 1}` : '';
      const dateInfo = t.isNew
        ? `First posted: ${t.firstPost}`
        : `Updated: ${t.lastUpdate}${versionInfo}`;
      const diffButton = diffUrl
        ? `<a href="${diffUrl}" style="display:inline-block;margin-top:6px;font-size:10px;font-weight:600;color:#6366f1;background:#eef2ff;border:1px solid #c7d2fe;padding:3px 10px;border-radius:4px;text-decoration:none">Show what changed →</a>`
        : '';
      return `<div style="border:1px solid #e2e8f0;border-radius:6px;padding:12px;margin:8px 0">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>${changeBadge}<a href="${trialUrl}" style="font-size:12px;color:#0284c7;text-decoration:none;font-weight:600">${t.nctId}</a></div>
          <span style="font-size:10px;color:${sc};font-weight:600;background:${sc}15;padding:2px 8px;border-radius:10px">${t.status.replace(/_/g, " ")}</span>
        </div>
        <a href="${trialUrl}" style="display:block;font-size:13px;margin:6px 0 4px;font-weight:500;color:#1e293b;line-height:1.4;text-decoration:none">${esc(t.title)}</a>
        <div style="font-size:11px;color:#64748b">${esc(t.phase)} · ${esc(t.sponsor)}${t.enrollment ? ' · '+t.enrollment+' enrolled' : ''}</div>
        ${statusChange}
        ${modules}
        <div style="font-size:10px;color:#94a3b8;margin-top:4px">${dateInfo}</div>
        ${diffButton}
      </div>`;
    }).join("");

    const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#f8fafb;color:#1a2b3c">
<div style="background:#001a2e;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;text-align:center">
  <h1 style="margin:0;font-size:18px;letter-spacing:2px">CT-GALAXY ALERT</h1>
  <p style="margin:6px 0 0;font-size:12px;color:#00e47c">${now} · Last ${days} days</p>
</div>
<div style="background:#fff;padding:20px 24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
  <div style="margin-bottom:12px;padding:8px 12px;background:#f0fdf4;border-left:4px solid #00e47c;border-radius:0 4px 4px 0">
    <span style="font-size:11px;color:#64748b">${filterDesc}</span>
    <span style="font-size:11px;color:#94a3b8;float:right">${studies.length} result(s)</span>
  </div>
  <div style="display:flex;gap:8px;margin-bottom:12px">
    <span style="font-size:11px;padding:3px 8px;border-radius:3px;background:#dcfce7;color:#16a34a;font-weight:600">${newCount} NEW</span>
    <span style="font-size:11px;padding:3px 8px;border-radius:3px;background:#dbeafe;color:#3b82f6;font-weight:600">${updatedCount} UPDATED</span>
  </div>
  ${trialRows}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
  <p style="font-size:11px;color:#94a3b8;text-align:center">Sent from CT-Galaxy</p>
</div></body></html>`;

    // Send via Resend
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "CT-Galaxy <onboarding@resend.dev>",
        to: [user.email!],
        subject: `CT-Galaxy: ${studies.length} trial(s) updated in last ${days} days`,
        html: emailHtml,
      }),
    });
    const resendData = await resendRes.json();

    if (!resendRes.ok) {
      return new Response(JSON.stringify({ error: "Email failed", detail: resendData }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update counter + log activity
    await supabase.from("subscriptions")
      .update({ monthly_sent: sent + 1, last_sent_at: new Date().toISOString() })
      .eq("user_id", user.id);
    await supabase.from("activity_logs").insert({
      user_id: user.id, email: user.email, type: "alert_push",
      detail: { slotIndex, filterDesc, count: studies.length },
    });

    return new Response(JSON.stringify({ message: "Alert sent!", count: studies.length, emailId: resendData.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
