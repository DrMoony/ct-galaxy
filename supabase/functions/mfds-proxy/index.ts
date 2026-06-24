const MFDS_API_KEY = Deno.env.get("MFDS_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/* Allowed data.go.kr API endpoints (whitelist) */
const ALLOWED_PATHS: Record<string, string> = {
  clncExamPlanDtl:
    "https://apis.data.go.kr/1471000/ClncExamPlanDtlService2/getClncExamPlanDtlInq2",
  mdcinClincTest:
    "https://apis.data.go.kr/1471000/MdcinClincTestInfoService02/getMdcinClincTestInfoList02",
  clncExamPlanTestPscg:
    "https://apis.data.go.kr/1471000/ClncExamPlanTestPscgService03/getClncExamPlanTestPscgInq03",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { endpoint, params } = await req.json();

    const baseUrl = ALLOWED_PATHS[endpoint];
    if (!baseUrl) {
      return new Response(
        JSON.stringify({ error: "Invalid endpoint" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* Build query string: inject serviceKey server-side, pass through other params */
    const qs = new URLSearchParams({
      serviceKey: MFDS_API_KEY,
      type: "json",
      ...params,
    });

    const res = await fetch(`${baseUrl}?${qs}`, {
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
