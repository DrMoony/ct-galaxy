"""
CT-Galaxy Weekly Alert Script
- Fetches active subscriptions from Supabase
- Queries ClinicalTrials.gov API v2 for each slot's filters
- Sends email digest via Resend
"""
import os
import json
import urllib.request
import urllib.parse
from datetime import datetime, timedelta

SUPABASE_URL = os.environ['SUPABASE_URL']
SUPABASE_KEY = os.environ['SUPABASE_SERVICE_KEY']
RESEND_KEY = os.environ['RESEND_API_KEY']
FROM_EMAIL = 'CT-Galaxy <alerts@ct-galaxy.com>'

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

def query_ctgov(slot):
    """Query ClinicalTrials.gov API v2 with slot filters, return trials updated in last 7 days."""
    base = 'https://clinicaltrials.gov/api/v2/studies'
    params = {
        'format': 'json',
        'pageSize': '20',
        'sort': 'LastUpdatePostDate:desc',
        'fields': 'NCTId,BriefTitle,OverallStatus,Phase,StartDate,LeadSponsorName,EnrollmentCount,LastUpdatePostDate,Condition,InterventionName',
    }

    # Date filter: last 7 days
    week_ago = (datetime.utcnow() - timedelta(days=7)).strftime('%Y-%m-%d')
    today = datetime.utcnow().strftime('%Y-%m-%d')

    # Build query.term parts
    query_parts = []
    if slot.get('condition'):
        query_parts.append(f"AREA[Condition]{slot['condition']}")
    if slot.get('intervention'):
        query_parts.append(f"AREA[InterventionName]{slot['intervention']}")
    if slot.get('keyword'):
        query_parts.append(slot['keyword'])

    # Country filter
    if slot.get('country'):
        query_parts.append(f"AREA[LocationCountry]{slot['country']}")

    if query_parts:
        params['query.term'] = ' AND '.join(query_parts)

    # Phase filter
    phases = slot.get('phases', [])
    if phases:
        phase_map = {
            'PHASE1': 'PHASE1',
            'PHASE2': 'PHASE2',
            'PHASE3': 'PHASE3',
            'PHASE4': 'PHASE4'
        }
        mapped = [phase_map.get(p, p) for p in phases]
        params['filter.advanced'] = 'AREA[Phase](' + ' OR '.join(mapped) + ')'

    # Status filter
    statuses = slot.get('statuses', [])
    if statuses:
        status_map = {
            'RECRUITING': 'RECRUITING',
            'ACTIVE_NOT_RECRUITING': 'ACTIVE_NOT_RECRUITING',
            'NOT_YET_RECRUITING': 'NOT_YET_RECRUITING',
            'COMPLETED': 'COMPLETED'
        }
        mapped = [status_map.get(s, s) for s in statuses]
        params['filter.overallStatus'] = '|'.join(mapped)

    # Last update date filter
    if 'filter.advanced' in params:
        params['filter.advanced'] += f' AND AREA[LastUpdatePostDate]RANGE[{week_ago},{today}]'
    else:
        params['filter.advanced'] = f'AREA[LastUpdatePostDate]RANGE[{week_ago},{today}]'

    url = f"{base}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.loads(res.read())
            return data.get('studies', [])
    except Exception as e:
        print(f"  ClinicalTrials.gov query error: {e}")
        return []

def format_trial(study):
    """Extract key fields from a study object."""
    proto = study.get('protocolSection', {})
    ident = proto.get('identificationModule', {})
    status_mod = proto.get('statusModule', {})
    design = proto.get('designModule', {})
    sponsor = proto.get('sponsorCollaboratorsModule', {})
    cond_mod = proto.get('conditionsModule', {})
    interv_mod = proto.get('armsInterventionsModule', {})

    nct_id = ident.get('nctId', '')
    title = ident.get('briefTitle', 'No title')
    overall_status = status_mod.get('overallStatus', '')
    phases_list = (design.get('phases') or [])
    phase = ', '.join(phases_list) if phases_list else 'N/A'
    lead = sponsor.get('leadSponsor', {}).get('name', '')
    conditions = ', '.join(cond_mod.get('conditions', [])[:3])

    interventions = []
    for iv in (interv_mod.get('interventions') or []):
        interventions.append(iv.get('name', ''))
    interv_str = ', '.join(interventions[:3])

    last_update = status_mod.get('lastUpdatePostDateStruct', {}).get('date', '')

    return {
        'nctId': nct_id,
        'title': title,
        'status': overall_status,
        'phase': phase,
        'sponsor': lead,
        'conditions': conditions,
        'interventions': interv_str,
        'lastUpdate': last_update
    }

def build_email_html(email, slots_results):
    """Build HTML email with trial results grouped by slot."""
    total = sum(len(trials) for _, trials in slots_results)
    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#f8fafb;color:#1a2b3c">
<div style="background:#001a2e;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;text-align:center">
  <h1 style="margin:0;font-size:18px;letter-spacing:2px">CT-GALAXY WEEKLY ALERT</h1>
  <p style="margin:6px 0 0;font-size:12px;color:#00e47c">{datetime.utcnow().strftime('%B %d, %Y')}</p>
</div>
<div style="background:#fff;padding:20px 24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
  <p style="font-size:14px;color:#64748b;margin-top:0">{total} new/updated trial(s) matching your alerts this week.</p>
"""

    for slot_idx, (slot, trials) in enumerate(slots_results):
        slot_label = f"Slot {slot_idx + 1}"
        filter_desc = []
        if slot.get('condition'): filter_desc.append(f"Condition: {slot['condition']}")
        if slot.get('intervention'): filter_desc.append(f"Intervention: {slot['intervention']}")
        if slot.get('keyword'): filter_desc.append(f"Keyword: {slot['keyword']}")
        if slot.get('country'): filter_desc.append(f"Country: {slot['country']}")
        desc = ' | '.join(filter_desc) if filter_desc else 'All'

        html += f"""
  <div style="margin:16px 0 8px;padding:8px 12px;background:#f0fdf4;border-left:4px solid #00e47c;border-radius:0 4px 4px 0">
    <strong style="font-size:13px">{slot_label}</strong>
    <span style="font-size:11px;color:#64748b;margin-left:8px">{desc}</span>
    <span style="font-size:11px;color:#94a3b8;float:right">{len(trials)} result(s)</span>
  </div>
"""
        if not trials:
            html += '<p style="font-size:13px;color:#94a3b8;padding-left:12px">No new trials this week.</p>'
        for t in trials[:15]:
            status_color = '#16a34a' if t['status'] == 'RECRUITING' else '#f59e0b' if 'ACTIVE' in t['status'] else '#6b7280'
            html += f"""
  <div style="border:1px solid #e2e8f0;border-radius:6px;padding:12px;margin:8px 0">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <a href="https://clinicaltrials.gov/study/{t['nctId']}" style="font-size:12px;color:#0284c7;text-decoration:none;font-weight:600">{t['nctId']}</a>
      <span style="font-size:10px;color:{status_color};font-weight:600;background:{status_color}15;padding:2px 8px;border-radius:10px">{t['status'].replace('_',' ')}</span>
    </div>
    <p style="font-size:13px;margin:6px 0 4px;font-weight:500;color:#1e293b;line-height:1.4">{t['title']}</p>
    <div style="font-size:11px;color:#64748b">
      <span>{t['phase']}</span> · <span>{t['sponsor']}</span>
    </div>
    <div style="font-size:11px;color:#94a3b8;margin-top:4px">{t['conditions']}</div>
  </div>
"""

    html += """
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
  <p style="font-size:11px;color:#94a3b8;text-align:center">
    You're receiving this because you subscribed at CT-Galaxy.<br>
    To unsubscribe, visit CT-Galaxy and click "Unsubscribe".
  </p>
</div>
</body></html>"""
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
    print(f"=== CT-Galaxy Weekly Alert — {datetime.utcnow().isoformat()} ===")

    # Fetch active subscriptions
    subs = supabase_get('subscriptions?active=eq.true&select=id,email,keywords')
    print(f"Found {len(subs)} active subscription(s)")

    for sub in subs:
        email = sub['email']
        slots = sub.get('keywords', [])
        if not slots:
            print(f"  Skipping {email}: no slots")
            continue

        print(f"\nProcessing: {email} ({len(slots)} slot(s))")
        slots_results = []

        for i, slot in enumerate(slots):
            print(f"  Slot {i+1}: {slot}")
            trials_raw = query_ctgov(slot)
            trials = [format_trial(s) for s in trials_raw]
            slots_results.append((slot, trials))
            print(f"    → {len(trials)} trial(s) found")

        # Only send if there are any results
        total = sum(len(t) for _, t in slots_results)
        if total == 0:
            print(f"  No results for {email}, skipping email")
            continue

        subject = f"CT-Galaxy Alert: {total} new trial(s) this week"
        html = build_email_html(email, slots_results)
        send_email(email, subject, html)

        # Update last_sent_at
        supabase_patch(
            f"subscriptions?id=eq.{sub['id']}",
            {'last_sent_at': datetime.utcnow().isoformat()}
        )

    print("\n=== Done ===")

if __name__ == '__main__':
    main()
