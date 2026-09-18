#!/usr/bin/env python3
"""
Cognito Forms access collector, browser-driven.

Opens Chromium against a saved profile directory so you sign in once and the
session sticks. Runs the same read-only collection the console script does,
writes audit-data.js next to report.html, then opens the report.

    python collect.py --org yourorgcode

Cognito resolves access as a global tier plus sparse overrides, so this keeps
every override row including denials. Everything it touches is a read.
"""

import argparse
import json
import pathlib
import sys
import webbrowser

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright is not installed. Run:\n"
             "  pip install -r requirements.txt\n"
             "  playwright install chromium")

ROOT = pathlib.Path(__file__).resolve().parent
PROFILE_DIR = ROOT / ".browser-profile"
OUT_FILE = ROOT / "audit-data.js"
REPORT = ROOT / "report.html"

# Same three endpoints as collect.js, plus the archived-form resolution pass.
# That version saves through the browser; this one returns the payload to
# Python. If you change one, change both.
COLLECT = """
() => {
  const CONFIG = { orgId: %s };
  return (async () => {
    const orgCode = location.pathname.split('/')[1] || '';

    const metaHeaders = orgId => {
      const h = { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' };
      if (orgId) h['x-organization'] = orgId;
      return h;
    };
    async function meta(orgId, formIds) {
      const r = await fetch('/svc/entity-meta/forms', {
        method: 'POST', headers: metaHeaders(orgId), credentials: 'include',
        body: JSON.stringify({ formIds: formIds || [] })
      });
      if (!r.ok) return null;
      try { return await r.json(); } catch (e) { return null; }
    }

    const roster = await (await fetch('/svc/organization/users', { credentials: 'include' })).json();
    if (!Array.isArray(roster.Users) || !roster.Users.length) throw new Error('roster empty');

    let m = await meta(null, []);
    let usedOrgId = null;
    if (!m || !(m.Forms || []).length) { m = await meta(CONFIG.orgId, []); usedOrgId = CONFIG.orgId; }
    if (!m || !(m.Forms || []).length) throw new Error('entity-meta returned no forms');

    // Both buckets are real entities. AdminFolders are ones the signed-in
    // account does not fully manage.
    const folders = [].concat(m.Folders || [], m.AdminFolders || []).map(f => ({
      id: f.Id, name: f.Name, archived: !!f.IsArchived, managed: f.CanManageFolder !== false
    }));
    const forms = [].concat(m.Forms || [], m.AdminForms || []).map(f => ({
      id: String(f.Id), name: f.Name, folderId: f.FolderId || null,
      entries: f.Entries == null ? null : f.Entries, archived: !!f.IsArchived
    }));

    const users = [];
    for (const u of roster.Users) {
      let d = null;
      try {
        d = await (await fetch('/svc/forms/permissions/' + u.Id, { credentials: 'include' })).json();
      } catch (e) { /* recorded with no overrides */ }
      users.push({
        id: u.Id, email: u.Email, first: u.FirstName || '', last: u.LastName || '',
        tier: u.Permission,
        workflowRole: (d && d.SystemRole && d.SystemRole.DisplayName) || null,
        mfa: !!u.MfaEnabled, created: u.DateCreated, verified: !!u.IsVerified,
        deleted: !!u.IsDeleted, locked: !!u.IsLocked, invitation: !!u.IsInvitation,
        folderOverrides: ((d && d.FolderRoles) || []).filter(f => f.Role && f.Role.Code)
          .map(f => ({ id: f.FolderId, code: f.Role.Code })),
        formOverrides: ((d && d.FormRoles) || []).filter(f => f.Role && f.Role.Code)
          .map(f => ({ id: String(f.FormId), code: f.Role.Code }))
      });
      await new Promise(r => setTimeout(r, 150));
    }

    // An empty formIds array omits archived forms. Naming them returns them.
    const knownForms = new Set(forms.map(f => f.id));
    const knownFolders = new Set(folders.map(f => f.id));
    const stray = new Set();
    users.forEach(u => u.formOverrides.forEach(o => knownForms.has(o.id) || stray.add(o.id)));
    if (stray.size) {
      const extra = await meta(usedOrgId, [...stray]);
      if (extra) {
        [].concat(extra.Forms || [], extra.AdminForms || []).forEach(f => {
          if (knownForms.has(String(f.Id))) return;
          knownForms.add(String(f.Id));
          forms.push({ id: String(f.Id), name: f.Name, folderId: f.FolderId || null,
                       entries: f.Entries == null ? null : f.Entries, archived: !!f.IsArchived });
        });
        [].concat(extra.Folders || [], extra.AdminFolders || []).forEach(f => {
          if (knownFolders.has(f.Id)) return;
          knownFolders.add(f.Id);
          folders.push({ id: f.Id, name: f.Name, archived: !!f.IsArchived,
                         managed: f.CanManageFolder !== false });
        });
      }
    }

    const deletedFormIds = [...stray].filter(id => !knownForms.has(id));
    const deletedFolderIds = [];
    users.forEach(u => u.folderOverrides.forEach(o => {
      if (!knownFolders.has(o.id) && deletedFolderIds.indexOf(o.id) < 0) deletedFolderIds.push(o.id);
    }));

    // Activity log. Pages with a ContinuationToken, pageSize caps at 1000.
    // Rows are aggregated as they arrive and never stored raw.
    const LOGIN_RE = /^(log(ged)?\\s?in|login|logon|sign(ed)?\\s?in|signin)$/i;
    const byEmail = {}, integrations = {}, vocab = {};
    const profileToEmail = {}, connectEvents = [];
    let logRows = 0, pages = 0, oldest = null, newest = null, truncated = false;
    try {
      let token = null;
      do {
        const b = { pageSize: 1000,
          filter: { UserId:'', ActionName:'', ItemType:'', ItemId:'', FromDate:'', ToDate:'' } };
        if (token) b.continuationToken = token;
        const r = await fetch('/svc/organization/org-audit-log/query-audit-log-page', {
          method:'POST', headers: metaHeaders(usedOrgId), credentials:'include',
          body: JSON.stringify(b) });
        if (!r.ok) break;
        const page = await r.json();
        const items = page.Items || [];
        for (const it of items) {
          logRows++;
          const when = it.Date || null;
          if (when) { if (!oldest || when < oldest) oldest = when;
                      if (!newest || when > newest) newest = when; }
          const action = it.Action || 'Unknown';
          vocab[action] = (vocab[action] || 0) + 1;
          if (it.ItemType === 'Users' && it.ItemId && it.UserEmail) {
            profileToEmail[String(it.ItemId)] = it.UserEmail.toLowerCase();
          }
          if (/connect/i.test(action) && /integration/i.test(action + ' ' + (it.ItemType || ''))) {
            connectEvents.push({ name: it.ItemName || null, by: it.UserEmail || null,
                                 when, id: it.IntegrationId || it.ItemId || null });
          }
          const key = (it.UserEmail || '').toLowerCase();
          if (key) {
            const a = byEmail[key] || (byEmail[key] = { userId: it.UserId || null,
              name: it.UserName || null, total: 0, lastActivity: null, lastLogin: null,
              logins: 0, actions: {} });
            a.total++;
            if (!a.lastActivity || when > a.lastActivity) a.lastActivity = when;
            const slot = a.actions[action] || (a.actions[action] = { n: 0, last: null });
            slot.n++;
            if (!slot.last || when > slot.last) slot.last = when;
            if (LOGIN_RE.test(action)) { a.logins++;
              if (!a.lastLogin || when > a.lastLogin) a.lastLogin = when; }
          }
          if (it.IntegrationId || it.IntegrationName) {
            const ik = it.IntegrationId || it.IntegrationName;
            const g = integrations[ik] || (integrations[ik] = { id: it.IntegrationId || null,
              name: it.IntegrationName || null, provider: it.IntegrationProvider || null,
              n: 0, last: null });
            g.n++;
            if (!g.last || when > g.last) g.last = when;
          }
        }
        token = page.ContinuationToken || null;
        pages++;
        if (pages >= 300) { truncated = true; break; }
        if (!items.length) break;
        await new Promise(r => setTimeout(r, 120));
      } while (token);
    } catch (e) { /* report runs without it */ }

    const activity = logRows ? {
      window: { from: oldest, to: newest }, rows: logRows, truncated,
      actions: Object.entries(vocab).sort((a,b) => b[1]-a[1])
        .map(([name,n]) => ({ name, n, countedAsLogin: LOGIN_RE.test(name) })),
      byEmail, integrations: Object.values(integrations), connectEvents
    } : null;

    // The log only shows integrations that have acted. A connection that has
    // never been used produces no rows, so the inventory comes from settings.
    let inventory = null;
    try {
      const inv = await (await fetch('/svc/integrations/list-view', {
        headers: metaHeaders(usedOrgId), credentials: 'include' })).json();
      if (inv && Array.isArray(inv.Integrations)) {
        const byName = {};
        connectEvents.forEach(c => {
          if (!c.name) return;
          const prev = byName[c.name];
          if (!prev || (c.when && c.when < prev.when)) byName[c.name] = c;
        });
        inventory = inv.Integrations.map(g => {
          const id = String(g.Id || '');
          const tilde = id.indexOf('~');            // appId~userProfileId for OAuth
          const appId = tilde < 0 ? id : id.slice(0, tilde);
          const owner = tilde < 0 ? null : id.slice(tilde + 1);
          const act = integrations[id] || integrations[appId] || null;
          const conn = byName[g.Name] || null;
          return { id, appId, service: g.Service || null, name: g.Name || null,
                   description: g.Description || null, userScoped: tilde >= 0,
                   ownerProfileId: owner,
                   ownerEmail: owner ? (profileToEmail[owner] || null) : null,
                   connectedBy: conn ? conn.by : null, connectedAt: conn ? conn.when : null,
                   events: act ? act.n : 0, lastSeen: act ? act.last : null };
        });
      }
    } catch (e) { /* report runs without it */ }

    return {
      schema: 4,
      activity,
      integrations: inventory,
      org: roster.OrgName || orgCode,
      orgCode,
      collectedAt: new Date().toISOString(),
      seatMessage: roster.UserUsageMessage || '',
      globalTiers: ['Administrator', 'Owner'],
      folders, forms, users, deletedFormIds, deletedFolderIds
    };
  })();
}
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--org", required=True,
                    help="org code from your Cognito URL, e.g. acme in /acme/home")
    ap.add_argument("--org-id", default=None,
                    help="x-organization header value, used only if auto-detect fails")
    ap.add_argument("--timeout", type=int, default=300,
                    help="seconds to wait for sign-in (default: 300)")
    ap.add_argument("--no-open", action="store_true",
                    help="write the data file but don't open the report")
    args = ap.parse_args()

    home = f"https://www.cognitoforms.com/{args.org}/home"

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1280, "height": 900},
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(home, wait_until="domcontentloaded")

        if "/login" in page.url or "signin" in page.url.lower():
            print("Sign in to Cognito Forms in the window that opened.")
            print(f"Waiting up to {args.timeout}s, then collection starts on its own.")
            page.wait_for_url(f"**/{args.org}/**", timeout=args.timeout * 1000)

        print("Collecting. Roughly 15 seconds per 100 accounts.")
        page.set_default_timeout(max(args.timeout, 600) * 1000)
        payload = page.evaluate(COLLECT % json.dumps(args.org_id))
        ctx.close()

    OUT_FILE.write_text(
        "window.__AUDIT = " + json.dumps(payload, indent=2) + ";\n",
        encoding="utf-8",
    )

    users = payload["users"]
    active = [f for f in payload["forms"] if not f["archived"]]
    archived = len(payload["forms"]) - len(active)
    org_wide = [u for u in users if u["tier"] in payload["globalTiers"]]
    stale = len(payload["deletedFormIds"]) + len(payload["deletedFolderIds"])

    print(f"{len(users)} accounts, {len(active)} active forms "
          f"({archived} archived), {len(payload['folders'])} folders")
    print(f"{len(org_wide)} accounts reach every form by tier "
          f"({', '.join(sorted({u['tier'] for u in org_wide}))})")

    act = payload.get("activity")
    if act:
        logins = [a for a in act["actions"] if a["countedAsLogin"]]
        print(f"{act['rows']} log rows back to {act['window']['from'][:10]}")
        if logins:
            never = sum(1 for u in users
                        if act["byEmail"].get(u["email"].lower(), {}).get("logins", 0) == 0)
            print(f"{never} accounts have no sign-in event in that window")
        else:
            print("WARNING: no action matched as a sign-in. Check the Activity tab "
                  "in the report and adjust LOGIN_RE.")
    else:
        print("activity log unavailable; report runs without idle data")

    inv = payload.get("integrations") or []
    if inv:
        ai = [g for g in inv if (g.get("service") or "").lower() in
              ("chatgpt", "claude", "gemini", "copilot", "perplexity", "openai", "anthropic")]
        quiet = [g for g in inv if not g.get("events")]
        print(f"{len(inv)} integrations, {len(quiet)} with no recorded activity")
        if ai:
            print(f"{len(ai)} AI assistant connections: "
                  + ", ".join(g.get("ownerEmail") or g["name"] for g in ai))
    if stale:
        print(f"{stale} overrides point at deleted entities")
    print(f"wrote {OUT_FILE}")

    if not args.no_open and REPORT.exists():
        webbrowser.open(REPORT.as_uri())
        print("opened report.html")


if __name__ == "__main__":
    main()
