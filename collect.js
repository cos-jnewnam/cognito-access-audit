/*
 * Cognito Forms access collector
 *
 * Run from a tab signed in to Cognito Forms, on the org home page
 * (https://www.cognitoforms.com/<yourorg>/home).
 *
 * Cognito's permission model is a global tier plus sparse overrides. This
 * collects both: the roster carries each account's tier, and the per-user
 * endpoint carries only the folders and forms where someone changed it.
 * Codes are AD (Administrator), ED (Editor), RE (Reviewer), NO (denied).
 * A folder with no row inherits the tier.
 *
 * Everything here is a read. Nothing is written back to Cognito Forms.
 */
(async () => {
  // Fallback only, and normally unnecessary. Set this to your x-organization
  // header value if the form list comes back empty. See the README.
  const CONFIG = { orgId: null };

  /* ---------------- overlay ---------------- */
  document.getElementById('cognito-audit-ui')?.remove();
  const host = document.createElement('div');
  host.id = 'cognito-audit-ui';
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = [
    '<style>',
    '.card{width:330px;background:#131c24;color:#e7ecf0;border:1px solid #2b3a47;',
    'font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;',
    'box-shadow:0 12px 32px rgba(0,0,0,.35)}',
    '.hd{display:flex;justify-content:space-between;align-items:center;',
    'padding:10px 12px;border-bottom:1px solid #2b3a47}',
    '.hd b{font-weight:500;font-size:12px;letter-spacing:.02em}',
    '.x{background:none;border:0;color:#7d919f;cursor:pointer;font-size:16px;line-height:1;padding:0 2px}',
    '.x:hover{color:#e7ecf0}',
    '.bd{padding:12px}',
    '.step{color:#9fb3c2;margin-bottom:10px;min-height:2.9em;word-break:break-all}',
    '.track{height:4px;background:#22303c;overflow:hidden}',
    '.fill{height:100%;width:0;background:#4a9ed4;transition:width .18s}',
    '.fill.done{background:#4fae83}',
    '.fill.err{background:#d1604a}',
    '.nums{display:flex;justify-content:space-between;color:#7d919f;font-size:11px;padding-top:8px}',
    '.act{margin-top:12px;display:none}',
    '.act button{width:100%;background:#1f6da1;color:#fff;border:0;padding:8px;cursor:pointer;font:inherit}',
    '.act button:hover{background:#17567f}',
    '.note{color:#7d919f;font-size:11px;margin-top:8px}',
    '.err{color:#f0a294}',
    '</style>',
    '<div class="card">',
    '<div class="hd"><b>COGNITO ACCESS COLLECTOR</b><button class="x" title="Close">&times;</button></div>',
    '<div class="bd">',
    '<div class="step" id="step">Starting.</div>',
    '<div class="track"><div class="fill" id="fill"></div></div>',
    '<div class="nums"><span id="left"></span><span id="right"></span></div>',
    '<div class="act" id="act"><button id="again">Save another copy</button></div>',
    '<div class="note" id="note"></div>',
    '</div></div>'
  ].join('');

  const el = s => root.getElementById(s);
  root.querySelector('.x').onclick = () => host.remove();

  const ui = {
    step: t => { el('step').innerHTML = t; },
    bar: (p, c) => { el('fill').style.width = p + '%'; el('fill').className = 'fill ' + (c || ''); },
    nums: (l, r) => { el('left').textContent = l || ''; el('right').textContent = r || ''; },
    note: t => { el('note').innerHTML = t || ''; },
    fail: t => { el('step').innerHTML = '<span class="err">' + t + '</span>'; ui.bar(100, 'err'); }
  };

  /* ---------------- guard ---------------- */
  const orgCode = location.pathname.split('/')[1] || '';
  if (!/cognitoforms\.com$/.test(location.hostname) || !orgCode) {
    ui.fail('Run this from your Cognito Forms org page, e.g. /yourorg/home');
    return;
  }

  /* ---------------- save location ----------------
     showSaveFilePicker needs a recent click, so ask now and write at the end. */
  let handle = null;
  if (typeof window.showSaveFilePicker === 'function') {
    ui.step('Choose where to save <b>audit-data.js</b>.<br>Collection starts as soon as you pick.');
    ui.bar(4);
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: 'audit-data.js',
        types: [{ description: 'Audit data', accept: { 'text/javascript': ['.js'] } }]
      });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        ui.fail('Cancelled.');
        setTimeout(() => host.remove(), 2000);
        return;
      }
      handle = null;
    }
  }

  async function save(text) {
    if (handle) {
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return handle.name;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    a.download = 'audit-data.js';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    return 'audit-data.js, in your downloads folder';
  }

  const META_HEADERS = orgId => {
    const h = { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' };
    if (orgId) h['x-organization'] = orgId;
    return h;
  };
  async function meta(orgId, formIds) {
    const r = await fetch('/svc/entity-meta/forms', {
      method: 'POST', headers: META_HEADERS(orgId), credentials: 'include',
      body: JSON.stringify({ formIds: formIds || [] })
    });
    if (!r.ok) return null;
    try { return await r.json(); } catch (e) { return null; }
  }

  /* ---------------- 1. roster ---------------- */
  ui.step('Reading the account roster.');
  ui.bar(6);
  let roster;
  try {
    roster = await (await fetch('/svc/organization/users', { credentials: 'include' })).json();
  } catch (e) {
    ui.fail('Could not read the roster. Are you still signed in?');
    return;
  }
  if (!Array.isArray(roster.Users) || !roster.Users.length) {
    ui.fail('The roster came back empty. Sign in again and retry.');
    return;
  }
  ui.nums(roster.Users.length + ' accounts', '');

  /* ---------------- 2. active forms and folders ---------------- */
  ui.step('Reading forms and folders.');
  ui.bar(10);
  let m = await meta(null, []);
  let usedOrgId = null;
  if (!m || !(m.Forms || []).length) { m = await meta(CONFIG.orgId, []); usedOrgId = CONFIG.orgId; }
  if (!m || !(m.Forms || []).length) {
    ui.fail('The form list came back empty. Check CONFIG.orgId against the x-organization header on the entity-meta/forms request.');
    return;
  }

  // Folders and forms arrive in two buckets. The admin ones are entities the
  // signed-in account does not fully manage. Both are real; merge them.
  const folders = [].concat(m.Folders || [], m.AdminFolders || []).map(f => ({
    id: f.Id, name: f.Name, archived: !!f.IsArchived, managed: f.CanManageFolder !== false
  }));
  const forms = [].concat(m.Forms || [], m.AdminForms || []).map(f => ({
    id: String(f.Id), name: f.Name, folderId: f.FolderId || null,
    entries: f.Entries == null ? null : f.Entries, archived: !!f.IsArchived
  }));
  ui.nums(roster.Users.length + ' accounts', forms.length + ' forms · ' + folders.length + ' folders');

  /* ---------------- 3. per-user overrides ----------------
     Every row is kept, including NO. On a tier that already grants access, a
     NO row is a deliberate denial, and dropping it overstates reach. */
  const total = roster.Users.length;
  const users = [];
  let n = 0, failed = 0;

  for (const u of roster.Users) {
    ui.step('Reading overrides.<br>' + u.Email);
    let d = null;
    try {
      d = await (await fetch('/svc/forms/permissions/' + u.Id, { credentials: 'include' })).json();
    } catch (e) {
      failed++;
    }
    users.push({
      id: u.Id, email: u.Email, first: u.FirstName || '', last: u.LastName || '',
      tier: u.Permission,
      workflowRole: (d && d.SystemRole && d.SystemRole.DisplayName) || null,
      mfa: !!u.MfaEnabled, created: u.DateCreated, verified: !!u.IsVerified,
      deleted: !!u.IsDeleted, locked: !!u.IsLocked, invitation: !!u.IsInvitation,
      folderOverrides: ((d && d.FolderRoles) || [])
        .filter(f => f.Role && f.Role.Code)
        .map(f => ({ id: f.FolderId, code: f.Role.Code })),
      formOverrides: ((d && d.FormRoles) || [])
        .filter(f => f.Role && f.Role.Code)
        .map(f => ({ id: String(f.FormId), code: f.Role.Code }))
    });
    n++;
    ui.bar(10 + Math.round(n / total * 78));
    ui.nums(n + ' of ' + total, failed ? failed + ' failed' : forms.length + ' forms');
    await new Promise(r => setTimeout(r, 150));
  }

  /* ---------------- 4. resolve archived entities ----------------
     An empty formIds array omits archived forms, but naming them explicitly
     returns them. Overrides routinely point at archived forms, so without
     this pass they show up as unresolvable references. */
  ui.step('Resolving archived forms.');
  ui.bar(92);
  const knownForms = new Set(forms.map(f => f.id));
  const knownFolders = new Set(folders.map(f => f.id));
  const strayForms = new Set();
  users.forEach(u => u.formOverrides.forEach(o => knownForms.has(o.id) || strayForms.add(o.id)));

  let archivedAdded = 0;
  if (strayForms.size) {
    const extra = await meta(usedOrgId, [...strayForms]);
    if (extra) {
      [].concat(extra.Forms || [], extra.AdminForms || []).forEach(f => {
        if (knownForms.has(String(f.Id))) return;
        knownForms.add(String(f.Id));
        archivedAdded++;
        forms.push({
          id: String(f.Id), name: f.Name, folderId: f.FolderId || null,
          entries: f.Entries == null ? null : f.Entries, archived: !!f.IsArchived
        });
      });
      [].concat(extra.Folders || [], extra.AdminFolders || []).forEach(f => {
        if (knownFolders.has(f.Id)) return;
        knownFolders.add(f.Id);
        folders.push({ id: f.Id, name: f.Name, archived: !!f.IsArchived,
                       managed: f.CanManageFolder !== false });
      });
    }
  }

  const deletedForms = [...strayForms].filter(id => !knownForms.has(id));
  const deletedFolders = [];
  users.forEach(u => u.folderOverrides.forEach(o => {
    if (!knownFolders.has(o.id) && deletedFolders.indexOf(o.id) < 0) deletedFolders.push(o.id);
  }));

  /* ---------------- 5. activity log ----------------
     org-audit-log pages with a ContinuationToken and caps pageSize at 1000.
     Rows are aggregated per account as they arrive, never stored raw, so the
     payload stays small no matter how long the retention window is. */
  ui.step('Reading the activity log.');
  ui.bar(94);

  const LOGIN_RE = /^(log(ged)?\s?in|login|logon|sign(ed)?\s?in|signin)$/i;
  const byEmail = {};
  const integrations = {};
  const actionVocab = {};
  const profileToEmail = {};
  const connectEvents = [];
  let rows = 0, pages = 0, oldest = null, newest = null, truncated = false;
  const PAGE_CAP = 300; // 300k rows, well past any plausible org

  try {
    let token = null;
    do {
      const body = { pageSize: 1000,
        filter: { UserId: '', ActionName: '', ItemType: '', ItemId: '', FromDate: '', ToDate: '' } };
      if (token) body.continuationToken = token;
      const r = await fetch('/svc/organization/org-audit-log/query-audit-log-page', {
        method: 'POST', headers: META_HEADERS(usedOrgId), credentials: 'include',
        body: JSON.stringify(body)
      });
      if (!r.ok) break;
      const page = await r.json();
      const items = page.Items || [];

      for (const it of items) {
        rows++;
        const when = it.Date || null;
        if (when) {
          if (!oldest || when < oldest) oldest = when;
          if (!newest || when > newest) newest = when;
        }
        const action = it.Action || 'Unknown';
        actionVocab[action] = (actionVocab[action] || 0) + 1;

        // Rows of ItemType 'Users' carry the subject's profile id in ItemId.
        // That id is the suffix of an OAuth integration's compound id, which is
        // how integrations get attributed to an owner.
        if (it.ItemType === 'Users' && it.ItemId && it.UserEmail) {
          profileToEmail[String(it.ItemId)] = it.UserEmail.toLowerCase();
        }
        if (/connect/i.test(action) && /integration/i.test(action + ' ' + (it.ItemType || ''))) {
          connectEvents.push({ name: it.ItemName || null, by: it.UserEmail || null,
                               when: when, id: it.IntegrationId || it.ItemId || null });
        }

        const key = (it.UserEmail || '').toLowerCase();
        if (key) {
          const a = byEmail[key] || (byEmail[key] = {
            userId: it.UserId || null, name: it.UserName || null,
            total: 0, lastActivity: null, lastLogin: null, logins: 0, actions: {} });
          a.total++;
          if (!a.lastActivity || when > a.lastActivity) a.lastActivity = when;
          const slot = a.actions[action] || (a.actions[action] = { n: 0, last: null });
          slot.n++;
          if (!slot.last || when > slot.last) slot.last = when;
          if (LOGIN_RE.test(action)) {
            a.logins++;
            if (!a.lastLogin || when > a.lastLogin) a.lastLogin = when;
          }
        }

        if (it.IntegrationId || it.IntegrationName) {
          const ik = it.IntegrationId || it.IntegrationName;
          const g = integrations[ik] || (integrations[ik] = {
            id: it.IntegrationId || null, name: it.IntegrationName || null,
            provider: it.IntegrationProvider || null, n: 0, last: null });
          g.n++;
          if (!g.last || when > g.last) g.last = when;
        }
      }

      token = page.ContinuationToken || null;
      pages++;
      ui.nums(rows + ' log rows', pages + ' pages');
      if (pages >= PAGE_CAP) { truncated = true; break; }
      if (!items.length) break;
      await new Promise(r => setTimeout(r, 120));
    } while (token);
  } catch (e) {
    console.warn('[cognito-audit] activity log unavailable', e);
  }

  /* ---------------- 5b. integration inventory ----------------
     The log only shows integrations that have acted. A connection that has
     never been used produces no rows, so the inventory has to come from the
     settings endpoint or it stays invisible. */
  let inventory = null;
  try {
    const inv = await (await fetch('/svc/integrations/list-view', {
      headers: META_HEADERS(usedOrgId), credentials: 'include'
    })).json();
    if (inv && Array.isArray(inv.Integrations)) {
      const connectByName = {};
      connectEvents.forEach(c => {
        if (!c.name) return;
        const prev = connectByName[c.name];
        if (!prev || (c.when && c.when < prev.when)) connectByName[c.name] = c;
      });

      inventory = inv.Integrations.map(g => {
        const id = String(g.Id || '');
        // OAuth app integrations use appId~userProfileId. API keys have no ~.
        const tilde = id.indexOf('~');
        const appId = tilde < 0 ? id : id.slice(0, tilde);
        const owner = tilde < 0 ? null : id.slice(tilde + 1);
        const act = integrations[id] || integrations[appId] || null;
        const conn = connectByName[g.Name] || null;
        return {
          id: id, appId: appId, service: g.Service || null, name: g.Name || null,
          description: g.Description || null,
          userScoped: tilde >= 0,
          ownerProfileId: owner,
          ownerEmail: owner ? (profileToEmail[owner] || null) : null,
          connectedBy: conn ? conn.by : null,
          connectedAt: conn ? conn.when : null,
          events: act ? act.n : 0,
          lastSeen: act ? act.last : null
        };
      });
    }
  } catch (e) {
    console.warn('[cognito-audit] integration inventory unavailable', e);
  }

  const activity = rows ? {
    window: { from: oldest, to: newest },
    rows: rows, truncated: truncated,
    // Vocabulary is reported so a mismatch in the login action name is visible
    // rather than silently producing zero logins for everyone.
    actions: Object.entries(actionVocab).sort((a, b) => b[1] - a[1])
      .map(([name, n]) => ({ name: name, n: n, countedAsLogin: LOGIN_RE.test(name) })),
    byEmail: byEmail,
    integrations: Object.values(integrations),
    connectEvents: connectEvents
  } : null;

  /* ---------------- 6. save ---------------- */
  const payload = {
    schema: 4,
    activity: activity,
    integrations: inventory,
    org: roster.OrgName || orgCode,
    orgCode: orgCode,
    collectedAt: new Date().toISOString(),
    seatMessage: roster.UserUsageMessage || '',
    // Tiers that reach every form unless an override says otherwise.
    globalTiers: ['Administrator', 'Owner'],
    folders: folders, forms: forms, users: users,
    deletedFormIds: deletedForms, deletedFolderIds: deletedFolders
  };
  const text = 'window.__AUDIT = ' + JSON.stringify(payload, null, 2) + ';\n';
  window.__AUDIT = payload;

  let where;
  try {
    where = await save(text);
  } catch (e) {
    ui.fail('Collection finished but the file could not be written. Use the button below.');
    el('act').style.display = 'block';
    el('again').onclick = () => { handle = null; save(text); };
    return;
  }

  const globals = users.filter(u => payload.globalTiers.indexOf(u.tier) >= 0).length;
  const loginActions = activity ? activity.actions.filter(a => a.countedAsLogin) : [];
  ui.bar(100, 'done');
  ui.step('Done. Saved to <b>' + where + '</b>');
  ui.nums(total + ' accounts · ' + globals + ' org-wide', failed ? failed + ' failed' : '');
  ui.note('Put this file next to report.html and open it, or drop it on the report.'
    + (activity
        ? '<br>' + activity.rows + ' log rows back to ' + String(activity.window.from).slice(0, 10)
          + (loginActions.length
              ? '' : '<br><span class="err">No sign-in action matched. Check the action list in the report.</span>')
        : '<br><span class="err">Activity log unavailable. Report runs without it.</span>')
    + (inventory ? '<br>' + inventory.length + ' integrations, '
        + inventory.filter(g => !g.events).length + ' with no recorded activity.' : '')
    + (archivedAdded ? '<br>' + archivedAdded + ' archived forms resolved.' : '')
    + (deletedForms.length + deletedFolders.length
        ? '<br>' + (deletedForms.length + deletedFolders.length) + ' overrides point at deleted entities.' : '')
    + (failed ? '<br><span class="err">Some accounts returned no data. They appear with no overrides.</span>' : ''));

  el('act').style.display = 'block';
  el('again').onclick = () => { handle = null; save(text); };
})();
