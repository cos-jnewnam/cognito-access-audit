# Cognito Forms access audit

Cognito Forms has no permission export. No screen answers "who can reach what,
and at what level," and the public REST API only covers forms, entries, and
documents. For a security review, the documented path is clicking through every
user in the admin UI one at a time.

This reads the same data from the app's own internal endpoints, resolves it into
effective access, and renders a report you can sort, filter, and send to whoever
asked for the audit.

Every call it makes is a read. Nothing is written back to Cognito Forms.

## How Cognito actually decides access

This matters more than anything else here, because getting it wrong produces a
report that looks right and isn't.

Each account has a global tier. Administrator and Owner reach every form in the
org. Limited Access reaches nothing. On top of that sit overrides, recorded per
folder and per form, and they move access in both directions.

Four override codes exist.

| Code | Means |
|---|---|
| `AD` | Administrator on that folder or form |
| `ED` | Editor |
| `RE` | Reviewer |
| `NO` | Access removed, below what the tier grants |

A folder or form with no override row inherits the tier. The UI shows this as
"Same as Global," in grey, with explicit overrides in bold.

So `NO` is a denial, not an absence. On a Limited Access account it changes
nothing. On an Administrator account it's the only way to carve anything out, and
discarding those rows overstates that account's reach.

Precedence runs form override, then folder override, then tier.

## What you get

`report.html` opens as a local file and gives you three views.

**People.** Every account with its tier, MFA state, override count, denial count,
no-op count, and how many forms it can actually reach. Expand a row to see the
tier baseline stated plainly, then every override by name.

**Folders.** Each folder, how many forms it holds, and everyone holding an
override on it. Folders with no overrides still note how many accounts reach
them by tier.

**Activity.** The action vocabulary from the audit log with event counts, the
retention window, and a full integration inventory. The inventory comes from the
settings endpoint rather than the log, so connections that have never been used
still appear. For each one it shows the service, whether it runs as a person or
as an org-scoped API key, what that person's account reaches, when it was
connected and by whom, and its last recorded event.

**Findings.** Seventeen computed sections. Accounts that reach everything by tier come
first, then access without MFA, Limited Access accounts that accumulated broad
reach, service accounts, the Editor and Reviewer gap, no-op overrides, deliberate
denials, overrides on archived or deleted forms, and accounts that reach nothing.
With an activity log attached it also flags accounts that reach forms but have
never signed in, accounts dormant 90 days or more, org-wide accounts nobody is
using, and service accounts with no activity at all. Integration findings cover
AI assistant connections, org-scoped API keys, integrations that have never
acted, and integrations idle 90 days or more.

Any view exports to CSV.

## Why "forms reachable" is the column to read

Tier and override counts both mislead on their own.

An Administrator with zero overrides reaches every form in the org, and every
count on the row reads zero. A Limited Access account with two folder overrides
can reach several hundred forms, because folder overrides cascade to everything
inside them.

This resolves the tier baseline, applies overrides in precedence order, drops
archived forms, and counts what's left. That number is comparable across
accounts. Nothing else on the row is.

## Running it

Two ways, and you only need one.

### Bookmarklet

No install, and it works on any machine where you can sign in.

1. Open `bookmarklet.txt` and copy the whole line.
2. Make a new bookmark and paste it as the URL. Name it something like "Cognito
   audit."
3. Sign in to Cognito Forms and go to your org home page.
4. Click the bookmark. A panel appears in the bottom right.
5. Move `audit-data.js` next to `report.html` if it isn't there already, or drag
   it onto the report's drop zone.

Chrome and Edge open a save dialog before collection starts, so you can write the
file straight into this folder and skip step 5. Firefox and Safari have no save
dialog and drop it in your downloads folder instead.

Budget about 15 seconds per 100 accounts. The panel tracks progress account by
account, then reports where the file went, how many accounts reach the org by
tier, and whether any lookups failed.

`collect.js` is the same code unminified. Paste it into the devtools console if
you'd rather skip the bookmark.

### Python

One command after the first sign-in. Better if you want repeat snapshots.

```
pip install -r requirements.txt
playwright install chromium
python collect.py --org yourorgcode
```

Chromium opens against a profile directory the script keeps in
`.browser-profile/`, so your session survives between runs. Sign in the first
time and it waits for you. After that it collects, writes `audit-data.js` next to
`report.html`, and opens the report with the data already loaded.

SSO expires. When it does, the browser shows a login screen and the script waits
again, which is why this isn't a cron job.

## Configuration

`--org` is the code in your Cognito URL. `https://www.cognitoforms.com/acme/home`
means `acme`.

`--org-id` is the `x-organization` header value. The script tries without it
first, and you only need to supply it if the form list comes back empty. To find
yours, open devtools on the forms page, find the `entity-meta/forms` request,
right-click, Copy as fetch, and read the header out of it. For the bookmarklet
and `collect.js`, set the same value on `CONFIG.orgId` at the top of
`collect.js`.

## What it reads

Five endpoints, none of them documented or supported.

| Endpoint | Method | What it returns |
|---|---|---|
| `/svc/organization/users` | GET | Account roster, global tier, MFA, created date |
| `/svc/forms/permissions/{userId}` | GET | That account's folder and form overrides, sparse |
| `/svc/entity-meta/forms` | POST | Folder and form list |
| `/svc/organization/org-audit-log/query-audit-log-page` | POST | Activity log, paged |
| `/svc/integrations/list-view` | GET | Every connected integration |

Two details about `entity-meta` that are easy to get wrong.

Results arrive in two pairs of buckets. `Folders` and `Forms` hold entities the
signed-in account manages; `AdminFolders` and `AdminForms` hold ones it doesn't,
carrying `CanManageFolder: false`. Both are real. Merge them or your folder
lookup will have holes.

An empty `formIds` array omits archived forms. Passing specific IDs returns them.
The collector runs a second call with every form ID that appears in an override
but not in the default list, which is how archived forms get named instead of
showing up as unresolvable.

The audit log pages with a `ContinuationToken` and caps `pageSize` at 1000
regardless of what you ask for. An empty filter object returns the whole org.
Rows are aggregated per account as they arrive and never stored raw, so the
payload stays small no matter how long the retention window is.

Cognito can change or remove these without notice. Use it for a point-in-time
review rather than monitoring you depend on.

## What to look at first

Count the accounts at Administrator or Owner tier. Each one reaches every form in
the org, no grants recorded, nothing on the users screen to indicate it. That
number is usually the largest single fact in the whole report.

Then count how many accounts use `ED` or `RE` anywhere. Cognito has four levels.
If almost everyone holds `AD`, least privilege exists and nobody uses it, which
is a process problem rather than a people problem.

## Integrations

Two kinds exist and they carry different risk.

An API key integration has a plain GUID for an ID. It isn't bound to a user and
runs at whatever scope the key was issued with.

An OAuth app integration has a compound ID, `appId~userProfileId`. The suffix is
the connecting user's profile ID, which means the integration runs as that person
and inherits their access. If their tier changes, the integration's reach changes
with it. The collector resolves that suffix to an email by matching against
`ItemId` on audit log rows of type `Users`, so the owner is attributed
automatically and the report shows what that account can reach.

The log alone is not enough for an inventory. `IntegrationId` populates when an
integration acts on something, so a connection that has never been used produces
no rows at all. An activity-only list therefore omits exactly the connections
worth asking about. That is why the inventory comes from the settings endpoint
and activity is joined onto it rather than the other way round.

## Sign-in data

The audit log gives you dated events per account, which is better than a
last-login field because you can see the shape of someone's usage rather than a
single timestamp. Our window runs 287 days.

Two things to check before leaning on it.

The JSON action names differ from the CSV export. The export says `logged in`
where the API says something shorter. The collector matches sign-in actions
against a regex and reports which names it counted, so open the Activity tab
and confirm the match is right. If nothing matched, every idle figure in the
report is meaningless and the tab says so in red.

An account with no sign-in event might have never signed in, or might
authenticate some other way. API keys are not sessions, so service accounts can
be busy while showing zero sign-ins. The never-signed-in finding excludes
service accounts and reports them separately, where the question is whether the
integration still runs rather than whether the account should go.

## Before you make this public

The committed defaults contain a real org code and org id. Neither is a
credential and neither works without a signed-in session, but replace them with
placeholders if this repo leaves your control.

`audit-data.js` is the permission matrix for your organization. It is gitignored.
Keep it that way.

## When nothing seems to happen

Click the bookmark and the panel should appear immediately. If it doesn't:

- Check that you're on `cognitoforms.com` and signed in. The panel refuses to run
  anywhere else and says so.
- Some bookmark managers strip the `javascript:` prefix when you paste. Edit the
  bookmark and confirm it's still there.
- Open devtools and read the console. Errors surface in the panel, but a blocked
  paste or a CSP change shows up only in the console.

If the panel appears and then reports an empty form list, the `x-organization`
header changed. See Configuration above.

If the report says your file came from an older collector, re-run `collect.js`.
The payload format changed when the tier model was added, and old files would
compute reach incorrectly rather than failing loudly.

## Limitations

The form list reflects what your account can see. If you aren't an org
administrator, the matrix will be incomplete and nothing in the report warns you
about it. Check the form count against what you expect before trusting any of the
numbers.

Reach counts active forms only. Overrides on archived forms are reported under
their own finding rather than counted as access.

The service account flag is a regex on the email address. Read that list before
quoting it to anyone.

Workflow roles are collected but not used in the access math. They route entries
rather than granting access to forms.

Idle figures are bounded by log retention. An account showing 287 days idle may
have last signed in years ago. The report states the window on the Activity tab
so nobody reads a floor as a measurement.
