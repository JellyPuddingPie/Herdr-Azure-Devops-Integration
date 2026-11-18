# Azure DevOps PBIs

A side panel that shows the open Azure DevOps Product Backlog Items (PBIs) of the project linked to the shown space. Each space links to one project. The panel opens from a **PBIs** button in the tab bar, next to Files and Changes. Each PBI is a card with its ID, state, effort, assignee, title and a short description. A card can start a Claude Code agent on that PBI in a new tab.

![Azure DevOps PBIs](preview.png)

## What you see

The layout is Herdr's `main` layout with one extra panel. Left to right:

- The sidebar with spaces and agents, as in `main`.
- The work column: the tab bar (`tabs-pbis`, 42 px), the active tab, and the status bar (28 px).
- The right panel (`panel`, 368 px, hidden by default). It is a stack with three children: `files`, `changes` and `pbis`.

The PBIs panel, top to bottom:

- A header, 42 px: a **PBIs / Tasks** switch (two 22 px segments on a `raised` background, the chosen one `selected` and semibold), the linked project name in dim text, and the item count with the time of the last load on the right.
- A toolbar: **Refresh**, **Assigned to me** (accent border and text while on) and **Unlink** on the right.
- A filter row with three equal buttons, **Iteration**, **Area** and **Status**, each showing the chosen path's last part or "All", with a ▾. A chosen filter has an `accent` border and text. Clicking one opens a list below it (max 220 px, scrolls): "All iterations", "All areas" or "All statuses" first, then every value of the loaded items with its count. Statuses are in workflow order (New, Approved, Committed, In progress, Testing, On hold, then the rest by name); paths by name. The path is shown without the project root. Items at the root iteration show as "No iteration (backlog)".
- A line "Signed in as <account>" with **Sign out**, when a sign-in exists for the tenant.
- The cards, in a scrolling list with 8 px gaps. Each card has a 1 px `border`, `surface` background and 9 px radius. Line 1: `#<id>` in `accent`, a status pill, effort and assignee in `dim`, then a small **Start agent** button. The status pill is 18 px high and fully rounded, with a 6 px dot and the state name. Its color comes from the state: Done or Closed `ansi2` (green), On hold or Blocked `ansi1` (red), Testing, Review or Resolved `ansi5` (magenta), Committed, Active, In progress or Dev `ansi3` (yellow), Approved or Ready `ansi4` (blue), anything else `muted`. The border is the color at alpha `66`, the fill at alpha `1f`. Line 2: the title in 13 px semibold. Line 3: up to 180 characters of the description in `muted`.

When the space has no link, the panel shows a field "Organization name or URL" with a **Connect** button. After Connect it lists the projects of the organization, with a filter field. Click a project to link it.

## How it behaves

- **Per space:** the link is stored by space ID. Switching spaces shows the PBIs of that space's project. The tab bar remembers per space whether the panel was open, like Files and Changes.
- **Which items:** with **PBIs**, work item types `Product Backlog Item` and `User Story`, in backlog order. With **Tasks**, type `Task`, newest change first. Both skip the states Done, Removed and Closed. At most 200.
- **Tasks:** a task card shows the remaining work (`RemainingWork`, as "4h left") in the gray line, and a line "↳ #<id> <title>" with its parent PBI (`System.Parent`, titles read in one extra request). The choice is kept in `localStorage` (`pbis.kind`) and is part of the cache key. **Start agent** names the work item type in the task it hands to Claude Code.
- **Iteration, Area and Status filters:** filter the loaded items in the panel, with no new request. A path matches itself and every path under it; a status matches itself. Each list counts the items that pass the other two filters. The choice is kept per space in `localStorage` (`pbis.filter.<space id>`). The header shows "<shown> of <loaded>" while a filter is on. Cards show the last part of their iteration path in the gray line.
- **Assigned to me:** filters on `[System.AssignedTo] = @Me`. The choice is kept in `localStorage`.
- **Description:** the Description field as plain text. When it is empty, the Acceptance Criteria field.
- **Refresh:** every 5 minutes, and with the Refresh button.
- **Click a card:** opens a dialog (`openOverlay`, `kind: "dialog"`, 62% wide, 86% high) of the same `pbis` mod, with `props.detail` = `{ org, project, space, id, title, state, url }`. A copy with `props.detail` draws only the dialog and starts no timers. The dialog shows `#<id>`, the status pill and the title, then **Start agent** (primary), **Open in DevOps** and **Close**. Below, in a scrolling area, the whole PBI as Markdown (`TextView.markdown`, selectable): the same text the agent gets. Esc closes it. Start agent closes the dialog only after the tab is opened, because closing a copy cancels its tasks.
- **Start agent:** the button reads "Reading…" while the panel fetches the whole work item: all fields, every text field that holds HTML (as plain text with line breaks and list items), linked work items with type and state, attachments, links and up to 100 comments. It writes that as Markdown to `data/pbis-items/<org>-<id>.md` under the app home. Then it runs `tab.new` with `argv: ["claude", "--permission-mode", "plan"]` (Claude Code starts in plan mode), the tab named `#<id>`, and a short task that names the file. The agent needs no Azure DevOps sign-in of its own. On an error the panel posts a `notify` toast.
- **Sign-in:** Microsoft device code flow, one sign-in per tenant. The panel shows a code, puts it on the clipboard and opens the Microsoft page. It polls until the person signs in. Then it reloads.
- **Agent status:** the panel does not show agent status. The tab bar shows it as in `main`.

## The PBI planner

A second mod, `pbi-planner`. It opens as a dialog (`openOverlay`, `kind: "dialog"`, 94% wide, 92% high) from a **Plan** button in the tab bar after **PBIs**, with `props.space`. It uses the project linked to that space in `data/pbis-links.json`, and the sign-ins in `data/pbis-auth.json`. Without a link it asks to link a project in the PBIs panel first.

Screens:

- **Plans:** the plans of this project, newest first. Each row shows the name, the number of Features and PBIs, and a pill: Draft, Error, "x of y created" or Created. **+ New plan** and **Delete** per row.
- **New plan:** a name field, a large text area for the pasted text, and **Draft with Claude**.
- **Board, Tree view (default):** a diagram, left to right. A **Plan** node (accent border, the plan name and the project) links to one node per Feature, and each Feature links to its PBI nodes. The links are curved arrows (`PathBuilder` cubic Bézier with a filled arrowhead, painted with `window.paint_path` under the nodes). The color of a link shows the state of its target: gray New, green Created, red Failed, and a dashed blue line to an existing Feature. A legend at the top right explains this. Nodes have a fixed size: Plan 210 × 96, Feature 270 × 104, PBI 330 × 112. Each Feature is centered on its PBIs. A **+ PBI** button sits under each group and **+ Feature** at the bottom. The canvas scrolls both ways.
- **Board, Columns view:** one 300 px column per Feature, side by side, scrolling sideways. The column head shows "FEATURE" (or "★ FEATURE" for an existing one), a pill and the title. Under it the PBI cards. A **+ PBI** button ends each column, and a **+ Feature** button follows the last column.
- Both views: a node or card shows a pill (New, Created #id, Existing #id or Failed), the number of acceptance criteria, the effort, the title and the first line of the description. A **Tree / Columns** switch sits above the board and is kept in `localStorage` (`planner.view`). The header has **All plans**, **Redraft** and **Create N items in DevOps**.
- **Item:** title, description, assignee, acceptance criteria (one per line), effort, tags and a row of Feature buttons to move the PBI. **Delete**, **Back** and **Save**. A Feature has title, description and assignee.
- **Assignee:** a row of chips: **Me (name)**, **Unassigned**, a search box, and the team members (at most 40 shown, the search box narrows them). **Me** comes from `_apis/connectionData` (the `Account` property), else from the user in the sign-in file. Team members are the members of every team of the project (`_apis/projects/{project}/teams`, then `.../teams/{id}/members`), without groups, deduplicated by unique name. They load once per dialog. The plan stores `assignedTo: { name, unique }`.
- **Assign all…:** a button next to the view switch, shown while items are left to create. It opens the same chips. A pick sets the assignee of every Feature and PBI without an ID. Created and existing items keep theirs.

Drafting:

- The planner reads the open Features of the project (WIQL, type Feature, not Done, Removed or Closed, at most 200).
- It writes a brief with the rules, the JSON shape, the existing Features and the pasted text to `data/pbi-plans/<plan>.input.md`.
- It runs `claude -p "Read the file … and do the task in it." --allowedTools Read --output-format json`, with a 10 minute limit and stdin closed. On Windows it runs through PowerShell (`$null | & $c -p …`) and prefers `claude.cmd` (the npm install) over `claude`.
- It takes the first `{` to the last `}` of `result` as JSON: `{ features: [{ title, description, existingId, pbis: [{ title, description, acceptanceCriteria, effort, tags }] }] }`. An `existingId` that is not an open Feature is dropped.
- Closing the dialog stops a draft. The plan then shows "Drafting stopped", with Redraft.

Creating:

- The work item type comes from the project: `Product Backlog Item` (effort in `Effort`), else `User Story` (`StoryPoints`), else `Requirement` (`Size`).
- First every new Feature, then every PBI with a `System.LinkTypes.Hierarchy-Reverse` relation to its Feature. `POST {project}/_apis/wit/workitems/${type}` with `application/json-patch+json`. Description and acceptance criteria are sent as HTML. `System.AssignedTo` gets the unique name of the assignee. Area and iteration are the project defaults.
- After each item the plan file is saved with the new ID. An error on one item marks that card red and the rest go on. Create again skips items that have an ID.
- Plans live in `data/pbi-plans/<id>.json`, with a list in `data/pbi-plans/index.json`.

## Built from

- Layout `layouts/main-pbis.json`: a clone of `main` (`layout.clone`). Two changes: the `tabs` block uses mod `tabs-pbis`, and the `panel-body` stack has a third child `{ "id": "pbis", "type": "block", "content": { "mod": "pbis" } }`.
- Mod `tabs-pbis`: a clone of the shipped `tabs` mod (`mod.clone`). Three changes: `enabled` always includes `"pbis"`, a third `panelButton("pbis", "PBIs", "mods/pbis/pbis.svg")` after Changes, and a **Plan** button that opens `pbi-planner` as a dialog.
- Mod `pbis` (`main.js`, `mod.json` with `"place": "none"`, `pbis.svg`).
  - `herdr` functions: `spaces`, `exec`, `run`, `theme`, `appHome`, `shared` (only to take over links from an older version).
  - Commands: `tab.new`. Also `notify` for errors of Start agent.
  - Network: `fetch` to `login.microsoftonline.com` (device code and token endpoints) and to `dev.azure.com` (projects, WIQL, work items, API version 7.1).
  - Programs: `curl`, once per organization, to read the `X-VSS-ResourceTenant` header of an anonymous request. That header names the tenant.
  - Client ID `872cd9fa-d31f-45e0-9eab-6e460a02d1f1` (Microsoft's public client for Visual Studio). Scope `499b84ac-1321-427f-aa17-267ca6975798/.default offline_access openid profile`.
  - Files: `data/pbis-links.json` (space ID to `{ org, project }`) and `data/pbis-auth.json` (tenant to `{ refresh_token, user }`), under the app home.

- Mod `pbi-planner` (`main.js`, `mod.json` with `"place": "none"` and an `overlay` size for `mod.open`, `planner.svg`). It copies the sign-in code of `pbis`, because mods cannot import each other.

## Watch out

- `shared()` read back `null` for a value the mod had set, after a hot reload. So the links live in a file of the mod, not in shared state.
- An organization belongs to one Entra tenant. A token from another tenant gives "not authorized". Always ask for the token at the organization's tenant, never at `organizations` when the tenant is known.
- The anonymous `_apis/connectionData` request returns no tenant header. `_apis/projects` does (a 302 with `X-VSS-ResourceTenant`).
- Azure DevOps answers a bad token with 203 and an HTML sign-in page, not only with 401. Treat a response that is not JSON as a sign-in problem.
- There is no `line_clamp` in gpui-kit. The description is cut to 180 characters in code.
- `fetch` responses have no headers, which is why the tenant lookup uses `curl`.
- `tabs-pbis` is a clone. It does not get updates of Herdr's own tab bar.
- `data/pbis-auth.json` holds refresh tokens. Never share or commit it.
- A new mod folder with a `mod.json` change can get docked into the shown layout as a column. Keep `"place": "none"` and check the layout after adding the planner.
- `claude -p` waits for stdin to close. `exec` leaves it open, so the call hangs or returns nothing. Close stdin (`< /dev/null`, or `$null |` in PowerShell).
- On Windows, `exec("claude")` can find an old WinGet `claude.exe` before the npm `claude.cmd`. Ask for `claude.cmd` first.
- An agent started in a terminal has no Azure DevOps sign-in. Do not pass only a link or a short summary: write the whole PBI to a file first.

## Done when

- `herdr-app check mods/pbis` and `herdr-app check mods/tabs-pbis` pass, and `herdr-app status` shows `"errors": []` on `main-pbis`.
- The tab bar shows **PBIs** after Changes. Clicking it opens the panel, and clicking again closes it.
- An unlinked space shows the organization field. Connect with an organization the person can reach lists its projects.
- Without a sign-in, the panel offers **Sign in with Microsoft**. After the sign-in, the cards load without a restart.
- Switching to another linked space shows that project's PBIs.
- **Assigned to me** shows only the person's items, and the button stays highlighted while it is on.
- **Start agent** opens a new tab named `#<id>` with Claude Code in plan mode, working on that PBI.
