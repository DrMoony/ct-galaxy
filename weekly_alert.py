"""
CT-Galaxy Scheduled Alert Script
- Fetches active subscriptions from Supabase
- Queries ClinicalTrials.gov API v2 for each slot's filters
- Fetches version history for change detection
- Sends email digest via Resend
- Supports: search, drug, sponsor, compare (nctIds), trial watch
"""
import os
import json
import urllib.request
import urllib.parse
from datetime import datetime, timedelta

SUPABASE_URL = os.environ['SUPABASE_URL']
SUPABASE_KEY = os.environ['SUPABASE_SERVICE_KEY']
RESEND_KEY = os.environ['RESEND_API_KEY']
FROM_EMAIL = 'CT-Galaxy <onboarding@resend.dev>'


def supabase_get(path):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    req = urllib.request.Request(url, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json'
    })
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read())


def supabase_patch(path, data):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    req = urllib.request.Request(url, data=json.dumps(data).encode(), method='PATCH', headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
    })
    with urllib.request.urlopen(req) as res:
        return res.status


def fetch_study_by_id(nct_id):
    """Fetch a single study by NCT ID."""
    url = f"https://clinicaltrials.gov/api/v2/studies/{nct_id}?format=json"
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read())
    except Exception:
        return None


def query_ctgov(slot, days=7):
    """Query ClinicalTrials.gov API v2 with slot filters."""
    since = (datetime.utcnow() - timedelta(days=days)).strftime('%Y-%m-%d')
    today = datetime.utcnow().strftime('%Y-%m-%d')

    # Compare mode: fetch specific trials by NCT ID
    if slot.get('nctIds'):
        studies = []
        for nct_id in slot['nctIds']:
            s = fetch_study_by_id(nct_id)
            if s:
                studies.append(s)
        return studies, since

    # Search/Drug/Sponsor mode
    params = {
        'format': 'json',
        'pageSize': '50',
        'sort': 'LastUpdatePostDate:desc',
    }

    query_parts = []
    if slot.get('condition'):
        query_parts.append(f"AREA[Condition]{slot['condition']}")
    if slot.get('intervention'):
        query_parts.append(f"AREA[InterventionName]{slot['intervention']}")
    if slot.get('sponsor'):
        query_parts.append(f"AREA[LeadSponsorName]{slot['sponsor']}")
    if slot.get('keyword'):
        query_parts.append(slot['keyword'])
    if slot.get('country'):
        query_parts.append(f"AREA[LocationCountry]{slot['country']}")
    if query_parts:
        params['query.term'] = ' AND '.join(query_parts)

    # Date range + phase filter
    adv_parts = [f'AREA[LastUpdatePostDate]RANGE[{since},{today}]']
    phases = slot.get('phases', [])
    if phases:
        adv_parts.append(f"AREA[Phase]({' OR '.join(phases)})")
    params['filter.advanced'] = ' AND '.join(adv_parts)

    statuses = slot.get('statuses', [])
    if statuses:
        params['filter.overallStatus'] = '|'.join(statuses)

    url = f"https://clinicaltrials.gov/api/v2/studies?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.loads(res.read())
            return data.get('studies', []), since
    except Exception as e:
        print(f"  ClinicalTrials.gov query error: {e}")
        return [], since


def fetch_history(nct_id):
    """Fetch version history from ClinicalTrials.gov internal API."""
    url = f"https://clinicaltrials.gov/api/int/studies/{nct_id}/history"
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return json.loads(res.read())
    except Exception:
        return None


def format_trial(study, since):
    """Extract key fields + version history from a study object."""
    proto = study.get('protocolSection', {})
    ident = proto.get('identificationModule', {})
    status_mod = proto.get('statusModule', {})
    design = proto.get('designModule', {})
    sponsor = proto.get('sponsorCollaboratorsModule', {})
    enroll = design.get('enrollmentInfo', {})

    nct_id = ident.get('nctId', '')
    title = ident.get('briefTitle', 'No title')
    overall_status = status_mod.get('overallStatus', '')
    phases_list = design.get('phases') or []
    phase = ', '.join(phases_list) if phases_list else 'N/A'
    lead = sponsor.get('leadSponsor', {}).get('name', '')
    enrollment = enroll.get('count')
    first_post = (status_mod.get('studyFirstPostDateStruct') or {}).get('date', '')
    last_update = (status_mod.get('lastUpdatePostDateStruct') or {}).get('date', '')
    is_new = first_post >= since

    result = {
        'nctId': nct_id,
        'title': title,
        'status': overall_status,
        'phase': phase,
        'sponsor': lead,
        'enrollment': enrollment,
        'firstPost': first_post,
        'lastUpdate': last_update,
        'isNew': is_new,
        'version': 0,
        'prevVersion': None,
        'changedModules': [],
        'prevStatus': '',
    }

    # Fetch version history for updated trials
    if not is_new and nct_id:
        hist = fetch_history(nct_id)
        if hist:
            changes = hist.get('changes', [])
            if len(changes) >= 2:
                latest = changes[-1]
                prev = changes[-2]
                result['version'] = latest.get('version', 0)
                result['prevVersion'] = prev.get('version', 0)
                result['changedModules'] = latest.get('moduleLabels', [])
                prev_st = prev.get('status', '')
                if prev_st and prev_st != latest.get('status', ''):
                    result['prevStatus'] = prev_st

    return result


def build_email_html(email, slots_results, days):
    """Build HTML email matching Edge Function format."""
    total = sum(len(trials) for _, trials in slots_results)
    now = datetime.utcnow().strftime('%B %d, %Y')

    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#f8fafb;color:#1a2b3c">
<div style="background:#001a2e;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;text-align:center">
  <h1 style="margin:0;font-size:18px;letter-spacing:2px">CT-GALAXY ALERT</h1>
  <p style="margin:6px 0 0;font-size:12px;color:#00e47c">{now} · Last {days} days</p>
</div>
<div style="background:#fff;padding:20px 24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">"""

    for slot_idx, (slot, trials) in enumerate(slots_results):
        # Filter description
        fp = []
        if slot.get('nctIds'):
            fp.append(f"Watching {len(slot['nctIds'])} trial(s)")
        if slot.get('condition'):
            fp.append(f"Condition: {slot['condition']}")
        if slot.get('intervention'):
            fp.append(f"Intervention: {slot['intervention']}")
        if slot.get('sponsor'):
            fp.append(f"Sponsor: {slot['sponsor']}")
        if slot.get('keyword') and not slot.get('nctIds'):
            fp.append(f"Keyword: {slot['keyword']}")
        filter_desc = ' | '.join(fp) if fp else 'All'

        new_count = sum(1 for t in trials if t['isNew'])
        updated_count = len(trials) - new_count

        html += f"""
  <div style="margin:16px 0 8px;padding:8px 12px;background:#f0fdf4;border-left:4px solid #00e47c;border-radius:0 4px 4px 0">
    <span style="font-size:11px;color:#64748b">{filter_desc}</span>
    <span style="font-size:11px;color:#94a3b8;float:right">{len(trials)} result(s)</span>
  </div>
  <div style="display:flex;gap:8px;margin-bottom:12px">
    <span style="font-size:11px;padding:3px 8px;border-radius:3px;background:#dcfce7;color:#16a34a;font-weight:600">{new_count} NEW</span>
    <span style="font-size:11px;padding:3px 8px;border-radius:3px;background:#dbeafe;color:#3b82f6;font-weight:600">{updated_count} UPDATED</span>
  </div>"""

        if not trials:
            html += '<p style="font-size:13px;color:#94a3b8;text-align:center;padding:1rem">No trials found for this period.</p>'

        for t in trials[:20]:
            sc = '#16a34a' if t['status'] == 'RECRUITING' else '#f59e0b' if 'ACTIVE' in t['status'] else '#6b7280'
            badge = ('<span style="font-size:9px;font-weight:700;color:#fff;background:#16a34a;padding:2px 6px;border-radius:3px;margin-right:4px">NEW</span>'
                     if t['isNew'] else
                     '<span style="font-size:9px;font-weight:700;color:#fff;background:#3b82f6;padding:2px 6px;border-radius:3px;margin-right:4px">UPDATED</span>')

            status_change = ''
            if t['prevStatus']:
                status_change = f'<div style="font-size:10px;margin-top:4px"><span style="color:#dc2626;text-decoration:line-through">{t["prevStatus"].replace("_"," ")}</span> → <span style="color:#16a34a;font-weight:600">{t["status"].replace("_"," ")}</span></div>'

            modules = ''
            if not t['isNew'] and t['changedModules']:
                modules = f'<div style="font-size:10px;color:#6366f1;margin-top:4px">Changed: {", ".join(t["changedModules"])}</div>'

            # Diff URL: API versions are 0-based, website is 1-based
            diff_url = ''
            if not t['isNew'] and t['version'] > 0 and t['prevVersion'] is not None:
                diff_url = f'https://clinicaltrials.gov/study/{t["nctId"]}?tab=history&a={t["prevVersion"]+1}&b={t["version"]+1}#version-content-panel'

            trial_url = f'https://clinicaltrials.gov/study/{t["nctId"]}'
            version_info = f' · v{t["version"] + 1}' if t['version'] > 0 else ''
            date_info = f'First posted: {t["firstPost"]}' if t['isNew'] else f'Updated: {t["lastUpdate"]}{version_info}'

            diff_button = ''
            if diff_url:
                diff_button = f'<a href="{diff_url}" style="display:inline-block;margin-top:6px;font-size:10px;font-weight:600;color:#6366f1;background:#eef2ff;border:1px solid #c7d2fe;padding:3px 10px;border-radius:4px;text-decoration:none">Show what changed →</a>'

            html += f"""
  <div style="border:1px solid #e2e8f0;border-radius:6px;padding:12px;margin:8px 0">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>{badge}<a href="{trial_url}" style="font-size:12px;color:#0284c7;text-decoration:none;font-weight:600">{t['nctId']}</a></div>
      <span style="font-size:10px;color:{sc};font-weight:600;background:{sc}15;padding:2px 8px;border-radius:10px">{t['status'].replace('_',' ')}</span>
    </div>
    <a href="{trial_url}" style="display:block;font-size:13px;margin:6px 0 4px;font-weight:500;color:#1e293b;line-height:1.4;text-decoration:none">{t['title']}</a>
    <div style="font-size:11px;color:#64748b">{t['phase']} · {t['sponsor']}{(' · ' + str(t['enrollment']) + ' enrolled') if t['enrollment'] else ''}</div>
    {status_change}
    {modules}
    <div style="font-size:10px;color:#94a3b8;margin-top:4px">{date_info}</div>
    {diff_button}
  </div>"""

    html += """
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
  <p style="font-size:11px;color:#94a3b8;text-align:center">Sent from CT-Galaxy</p>
</div></body></html>"""
    return html


def send_email(to, subject, html_body):
    """Send email via Resend API."""
    data = json.dumps({
        'from': FROM_EMAIL,
        'to': [to],
        'subject': subject,
        'html': html_body
    }).encode()
    req = urllib.request.Request('https://api.resend.com/emails', data=data, headers={
        'Authorization': f'Bearer {RESEND_KEY}',
        'Content-Type': 'application/json'
    })
    try:
        with urllib.request.urlopen(req) as res:
            result = json.loads(res.read())
            print(f"  Email sent to {to}: {result.get('id', 'ok')}")
            return True
    except Exception as e:
        print(f"  Email failed for {to}: {e}")
        return False


def main():
    print(f"=== CT-Galaxy Alert — {datetime.utcnow().isoformat()} ===")

    subs = supabase_get('subscriptions?active=eq.true&select=id,user_id,email,keywords,schedule_type,monthly_sent')
    print(f"Found {len(subs)} active subscription(s)")

    for sub in subs:
        email = sub['email']
        slots = sub.get('keywords', [])
        if not slots:
            print(f"  Skipping {email}: no slots")
            continue

        # Date range based on schedule
        schedule_type = sub.get('schedule_type', 'monthly')
        days = {'weekly': 7, 'bimonthly': 60}.get(schedule_type, 30)

        # Monthly limit check
        sent = sub.get('monthly_sent', 0) or 0
        if sent >= 10:
            print(f"  Skipping {email}: monthly limit reached ({sent}/10)")
            continue

        print(f"\nProcessing: {email} ({len(slots)} slot(s), {schedule_type}, {days}d)")
        slots_results = []

        for i, slot in enumerate(slots):
            print(f"  Slot {i+1}: {json.dumps(slot, ensure_ascii=False)[:100]}")
            trials_raw, since = query_ctgov(slot, days)
            trials = [format_trial(s, since) for s in trials_raw[:20]]
            slots_results.append((slot, trials))
            print(f"    → {len(trials)} trial(s)")

        total = sum(len(t) for _, t in slots_results)
        if total == 0:
            print(f"  No results for {email}, skipping")
            continue

        subject = f"CT-Galaxy: {total} trial(s) updated in last {days} days"
        html = build_email_html(email, slots_results, days)
        if send_email(email, subject, html):
            supabase_patch(
                f"subscriptions?id=eq.{sub['id']}",
                {'monthly_sent': sent + 1, 'last_sent_at': datetime.utcnow().isoformat()}
            )

    print("\n=== Done ===")


if __name__ == '__main__':
    main()
