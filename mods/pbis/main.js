// Azure DevOps PBIs of the project linked to the shown space, as cards.
// Signs in with Microsoft's device code flow, per tenant; no Azure CLI.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, TextView } from "gpui-base";
import { spaces, shared, exec, run, notify, theme, appHome, props, openOverlay, closeOverlay } from "herdr";
import * as fs from "fs/promises";

const LINKS = "pbis.links";
const ADO_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access openid profile";
// Microsoft's public client for Visual Studio: allowed to ask for Azure DevOps tokens.
const CLIENT_ID = "872cd9fa-d31f-45e0-9eab-6e460a02d1f1";
const LOGIN = "https://login.microsoftonline.com";
const NO_TENANT = "00000000-0000-0000-0000-000000000000";
const TYPES = ["'Product Backlog Item'", "'User Story'"];
const CLOSED = ["'Done'", "'Removed'", "'Closed'"];
const REFRESH_MS = 5 * 60 * 1000;

const tenants = {}; // org -> tenant id, or null when Azure DevOps names none
const tokens = {}; // tenant -> { value, expiresAt }, in memory only

class NeedsLogin extends Error {
  constructor(tenant, message) { super(message); this.tenant = tenant; }
}

// ---------- files of this mod ----------

const dataFile = (name) => `${appHome()}/data/${name}`;

async function readJson(name, fallback) {
  try { return JSON.parse(await fs.readFile(dataFile(name), "utf8")); } catch { return fallback; }
}

async function writeJson(name, value) {
  try { await fs.mkdir(`${appHome()}/data`, { recursive: true }); } catch { /* exists */ }
  await fs.writeFile(dataFile(name), JSON.stringify(value, null, 2));
}

// Links: space id -> { org, project }.
let linkStore = null;
async function readLinks() {
  if (linkStore) return linkStore;
  let found = await readJson("pbis-links.json", null);
  if (!found) {
    try { found = JSON.parse(await fs.readFile(`${appHome()}/shared.json`, "utf8"))[LINKS] ?? {}; }
    catch { found = shared(LINKS) ?? {}; }
  }
  linkStore = found && typeof found === "object" ? found : {};
  return linkStore;
}
async function saveLinks(next) { linkStore = next; await writeJson("pbis-links.json", next); }
const links = () => linkStore ?? {};

// Sign-ins: tenant -> { refresh_token, user }.
let authStore = null;
async function readAuth() {
  if (!authStore) authStore = await readJson("pbis-auth.json", {});
  return authStore;
}
async function saveAuth(next) { authStore = next; await writeJson("pbis-auth.json", next); }

// ---------- helpers ----------

function parseOrg(text) {
  const t = text.trim().replace(/\/+$/, "");
  if (!t) return "";
  const m = t.match(/^https?:\/\/dev\.azure\.com\/([^/?#]+)/i);
  if (m) return `https://dev.azure.com/${m[1]}`;
  return t.startsWith("http") ? t : `https://dev.azure.com/${t}`;
}

const orgName = (org) => org.replace(/^https:\/\/dev\.azure\.com\//, "");

function plain(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>|<\/(p|div|li)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

const short = (text, max = 180) => text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;

const form = (fields) => Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64url(text) {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  let bits = 0, value = 0, out = "";
  for (const ch of s) {
    const i = B64.indexOf(ch);
    if (i < 0) continue;
    value = (value << 6) | i; bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((value >> bits) & 255); }
  }
  try { return decodeURIComponent(escape(out)); } catch { return out; }
}

function userOf(idToken) {
  try {
    const claims = JSON.parse(base64url(idToken.split(".")[1]));
    return claims.preferred_username ?? claims.email ?? claims.name ?? "";
  } catch { return ""; }
}

// ---------- sign-in ----------

// The tenant an organization lives in: Azure DevOps names it on an anonymous request.
async function tenantOf(org) {
  if (org in tenants) return tenants[org];
  let tenant = null;
  for (const cmd of ["curl", "curl.exe"]) {
    try {
      const r = await exec(cmd, ["-s", "-i", "--max-time", "15", `${org}/_apis/projects`], { timeout: 20000 });
      const m = r.stdout.match(/x-vss-resourcetenant:\s*([0-9a-f-]{36})/i);
      tenant = m && m[1] !== NO_TENANT ? m[1] : null;
      break;
    } catch { /* try the next name */ }
  }
  tenants[org] = tenant;
  return tenant;
}

const authority = (tenant) => tenant ?? "organizations";

async function tokenRequest(tenant, fields) {
  const res = await fetch(`${LOGIN}/${authority(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_id: CLIENT_ID, ...fields }),
  });
  return await res.json();
}

async function keep(tenant, out) {
  const key = authority(tenant);
  tokens[key] = { value: out.access_token, expiresAt: Date.now() + (out.expires_in ?? 3600) * 1000 };
  const auth = await readAuth();
  const user = out.id_token ? userOf(out.id_token) : auth[key]?.user ?? "";
  await saveAuth({ ...auth, [key]: { refresh_token: out.refresh_token ?? auth[key]?.refresh_token, user } });
  return out.access_token;
}

async function getToken(tenant) {
  const key = authority(tenant);
  const held = tokens[key];
  if (held && held.expiresAt - 60000 > Date.now()) return held.value;
  const saved = (await readAuth())[key];
  if (!saved?.refresh_token) throw new NeedsLogin(tenant, "Sign in to reach this organization.");
  const out = await tokenRequest(tenant, { grant_type: "refresh_token", refresh_token: saved.refresh_token, scope: ADO_SCOPE });
  if (!out.access_token) throw new NeedsLogin(tenant, "Your sign-in expired. Sign in again.");
  return await keep(tenant, out);
}

async function signOut(tenant) {
  const key = authority(tenant);
  delete tokens[key];
  const next = { ...(await readAuth()) };
  delete next[key];
  await saveAuth(next);
}

// ---------- Azure DevOps ----------

async function ado(org, path, body) {
  const tenant = await tenantOf(org);
  const bearer = await getToken(tenant);
  const res = await fetch(`${org}/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* sign-in page or empty */ }
  if (res.status === 401 || res.status === 203 || (res.ok && data === null)) {
    delete tokens[authority(tenant)];
    const user = (await readAuth())[authority(tenant)]?.user;
    throw new NeedsLogin(tenant, user
      ? `${user} has no access to ${orgName(org)}. Sign in with another account.`
      : "Azure DevOps did not accept this sign-in.");
  }
  if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
  return data;
}

// HTML from Azure DevOps as readable text: paragraphs, line breaks and list items kept.
function text(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|tr|ul|ol)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, " [image: $1] ")
    .replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The whole work item as Markdown, for an agent that cannot reach Azure DevOps itself.
async function pbiMarkdown(link, id) {
  const project = encodeURIComponent(link.project);
  const w = await ado(link.org, `${project}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.1`);
  const f = w.fields ?? {};
  const out = [`# ${f["System.WorkItemType"] ?? "Work item"} ${id}: ${f["System.Title"] ?? ""}`, ""];
  const facts = [
    ["Organization", orgName(link.org)], ["Project", link.project],
    ["State", f["System.State"]], ["Reason", f["System.Reason"]],
    ["Assigned to", f["System.AssignedTo"]?.displayName],
    ["Effort", f["Microsoft.VSTS.Scheduling.Effort"] ?? f["Microsoft.VSTS.Scheduling.StoryPoints"]],
    ["Priority", f["Microsoft.VSTS.Common.Priority"]],
    ["Area", f["System.AreaPath"]], ["Iteration", f["System.IterationPath"]],
    ["Tags", f["System.Tags"]], ["Created by", f["System.CreatedBy"]?.displayName],
    ["Changed", f["System.ChangedDate"]], ["Link", `${link.org}/${project}/_workitems/edit/${id}`],
  ];
  for (const [k, v] of facts) if (v != null && v !== "") out.push(`- **${k}:** ${v}`);
  const sections = [
    ["Description", "System.Description"],
    ["Acceptance criteria", "Microsoft.VSTS.Common.AcceptanceCriteria"],
    ["Repro steps", "Microsoft.VSTS.TCM.ReproSteps"],
    ["System info", "Microsoft.VSTS.TCM.SystemInfo"],
  ];
  for (const [title, field] of sections) {
    const body = text(f[field]);
    if (body) out.push("", `## ${title}`, "", body);
  }
  // Other text fields that hold HTML, such as custom ones.
  for (const [k, v] of Object.entries(f)) {
    if (sections.some(([, field]) => field === k) || typeof v !== "string" || !/<\w+[^>]*>/.test(v)) continue;
    const body = text(v);
    if (body) out.push("", `## ${k}`, "", body);
  }

  const rels = w.relations ?? [];
  const idOf = (url) => Number(String(url).split("/").pop());
  const related = rels.filter((r) => /^System\.LinkTypes\./.test(r.rel));
  if (related.length) {
    const ids = [...new Set(related.map((r) => idOf(r.url)).filter(Boolean))].slice(0, 200);
    const got = await ado(link.org, `_apis/wit/workitems?ids=${ids.join(",")}&fields=System.Title,System.State,System.WorkItemType&errorPolicy=omit&api-version=7.1`).catch(() => ({ value: [] }));
    const byId = new Map((got.value ?? []).filter(Boolean).map((x) => [x.id, x.fields ?? {}]));
    const kinds = {
      "System.LinkTypes.Hierarchy-Reverse": "Parent", "System.LinkTypes.Hierarchy-Forward": "Child",
      "System.LinkTypes.Related": "Related", "System.LinkTypes.Dependency-Forward": "Successor",
      "System.LinkTypes.Dependency-Reverse": "Predecessor",
    };
    out.push("", "## Linked work items", "");
    for (const r of related) {
      const x = byId.get(idOf(r.url)) ?? {};
      const kind = kinds[r.rel] ?? r.rel.replace(/^System\.LinkTypes\./, "");
      out.push(`- ${kind}: ${x["System.WorkItemType"] ?? ""} ${idOf(r.url)} ${x["System.Title"] ?? ""} (${x["System.State"] ?? "?"})`);
    }
  }
  const files = rels.filter((r) => r.rel === "AttachedFile");
  if (files.length) {
    out.push("", "## Attachments", "");
    for (const r of files) out.push(`- ${r.attributes?.name ?? "file"}: ${r.url}`);
  }
  const hyperlinks = rels.filter((r) => r.rel === "Hyperlink" || r.rel === "ArtifactLink");
  if (hyperlinks.length) {
    out.push("", "## Links", "");
    for (const r of hyperlinks) out.push(`- ${r.attributes?.name ?? r.rel}: ${r.url}`);
  }

  const c = await ado(link.org, `${project}/_apis/wit/workItems/${id}/comments?$top=100&order=asc&api-version=7.1-preview.4`).catch(() => null);
  const comments = c?.comments ?? [];
  if (comments.length) {
    out.push("", "## Comments", "");
    for (const m of comments) {
      out.push(`### ${m.createdBy?.displayName ?? "?"}, ${String(m.createdDate ?? "").slice(0, 16).replace("T", " ")}`, "", text(m.text), "");
    }
  }
  return out.join("\n").trim() + "\n";
}

async function listProjects(org) {
  const data = await ado(org, "_apis/projects?$top=1000&api-version=7.1");
  return (data.value ?? []).map((p) => p.name).sort((a, b) => a.localeCompare(b));
}

async function loadPbis(link, mine) {
  const project = encodeURIComponent(link.project);
  const wiql = [
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project",
    `AND [System.WorkItemType] IN (${TYPES.join(", ")})`,
    `AND [System.State] NOT IN (${CLOSED.join(", ")})`,
    mine ? "AND [System.AssignedTo] = @Me" : "",
    "ORDER BY [Microsoft.VSTS.Common.BacklogPriority] ASC, [System.ChangedDate] DESC",
  ].join(" ");
  const found = await ado(link.org, `${project}/_apis/wit/wiql?$top=200&api-version=7.1`, { query: wiql });
  const ids = (found.workItems ?? []).map((w) => w.id).slice(0, 200);
  if (!ids.length) return [];
  const fields = [
    "System.Id", "System.Title", "System.State", "System.AssignedTo", "System.Description",
    "Microsoft.VSTS.Common.AcceptanceCriteria", "System.IterationPath", "System.AreaPath",
    "Microsoft.VSTS.Scheduling.Effort", "Microsoft.VSTS.Scheduling.StoryPoints",
  ].join(",");
  const got = await ado(link.org, `${project}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields}&api-version=7.1`);
  const byId = new Map();
  for (const w of got.value ?? []) {
    const f = w.fields ?? {};
    const effort = f["Microsoft.VSTS.Scheduling.Effort"] ?? f["Microsoft.VSTS.Scheduling.StoryPoints"];
    const description = plain(f["System.Description"]) || plain(f["Microsoft.VSTS.Common.AcceptanceCriteria"]);
    byId.set(w.id, {
      id: w.id,
      title: String(f["System.Title"] ?? ""),
      state: String(f["System.State"] ?? ""),
      assignedTo: f["System.AssignedTo"]?.displayName ?? "",
      iteration: String(f["System.IterationPath"] ?? ""),
      area: String(f["System.AreaPath"] ?? ""),
      effort: effort == null ? "" : String(effort),
      summary: short(description),
      description: description.slice(0, 4000),
      url: `${link.org}/${project}/_workitems/edit/${w.id}`,
    });
  }
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// ---------- the panel ----------

export default class Pbis extends View {
  init(_props, cx) {
    this.cache = {};
    this.starting = {};
    this.mine = localStorage.getItem("pbis.mine") === "1";
    this.connect = null; // the organization step: { org, loading, error, needsLogin, projects }
    this.login = null; // a device code sign-in: { tenant, code, uri, error, then }
    this.orgInput = InputState.new({ placeholder: "Organization name or URL", value: localStorage.getItem("pbis.lastOrg") ?? "" });
    this.orgInput.on("submit", (_e, cx) => this.connectOrg(cx));
    this.filterInput = InputState.new({ placeholder: "Filter projects" });
    this.filter = "";
    this.filterInput.on("change", (_e, cx) => { this.filter = this.filterInput.value(); cx.notify(); });
    // This copy is a dialog with one PBI (opened from a card): load it and stop.
    const detail = props()?.detail;
    if (detail) {
      this.detail = { ...detail, loading: true, md: "", error: "" };
      cx.spawn(async (cx) => {
        try { this.detail.md = await pbiMarkdown({ org: detail.org, project: detail.project }, detail.id); }
        catch (e) { this.detail.error = String(e?.message ?? e); }
        this.detail.loading = false;
        cx.notify();
      });
      return;
    }
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx, true));
    cx.spawn(async (cx) => { await readLinks(); await readAuth(); this.ready = true; cx.notify(); });
  }

  openDetail(p, space, link) {
    openOverlay({
      mod: "pbis", kind: "dialog", width: 0.62, height: 0.86,
      props: { detail: { org: link.org, project: link.project, space: space.id, id: p.id, title: p.title, state: p.state, url: p.url } },
    });
  }

  renderDetail(t) {
    const d = this.detail;
    const p = { id: d.id, title: d.title, url: d.url };
    const close = () => closeOverlay(props().overlay);
    const body = d.loading
      ? div().p(18).text_color(t.dim).child("Reading the PBI…")
      : d.error
        ? div().p(18).text_size(12).text_color(t.ansi1).child(d.error)
        // The first line repeats the title shown above: leave it out.
        : div().id("pbis-detail-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).text_size(13)
          .child(TextView.markdown("pbis-detail-md", d.md.replace(/^# .*\n+/, "")).selectable(true));
    return v_flex().id("pbis-detail").size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .child(v_flex().flex_none().px(20).pt(16).pb(12).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(12).font_semibold().text_color(t.accent).child(`#${d.id}`))
          .when(Boolean(d.state), (el) => el.child(this.status(d.state, t)))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.dim).child("Esc")))
        .child(div().text_size(16).font_semibold().child(d.title))
        .child(h_flex().gap(6)
          .child(this.button("pbis-detail-agent", this.starting[d.id] ? "Reading…" : "Start agent", t, (_e, cx) => {
            this.startAgent(p, { id: d.space }, { org: d.org, project: d.project }, cx, close);
          }, "primary"))
          .child(this.button("pbis-detail-open", "Open in DevOps", t, (_e, cx) => cx.open_url(d.url)))
          .child(div().flex_1())
          .child(this.button("pbis-detail-close", "Close", t, close))))
      .child(body);
  }

  current() {
    const space = spaces().find((s) => s.active) ?? null;
    return { space, link: space ? links()[space.id] ?? null : null };
  }

  cacheKey(space, link) { return `${space.id}|${link.org}|${link.project}|${this.mine}`; }

  refresh(cx, force) {
    const { space, link } = this.current();
    if (!space || !link) return;
    const key = this.cacheKey(space, link);
    const entry = this.cache[key];
    if (entry?.loading || (entry && !force)) return;
    this.cache[key] = { ...(entry ?? { items: [] }), loading: true, error: "", needsLogin: undefined };
    cx.spawn(async (cx) => {
      try {
        const items = await loadPbis(link, this.mine);
        this.cache[key] = { items, loading: false, error: "", at: Date.now() };
      } catch (e) {
        this.cache[key] = {
          items: entry?.items ?? [], loading: false, error: String(e?.message ?? e),
          needsLogin: e instanceof NeedsLogin ? e.tenant : undefined,
        };
      }
      cx.notify();
    });
  }

  connectOrg(cx) {
    const org = parseOrg(this.orgInput.value());
    if (!org) return;
    localStorage.setItem("pbis.lastOrg", this.orgInput.value().trim());
    delete tenants[org];
    this.connect = { org, loading: true, error: "", needsLogin: undefined, projects: [] };
    this.filter = ""; this.filterInput.set_value("");
    cx.spawn(async (cx) => {
      try {
        const projects = await listProjects(org);
        this.connect = { org, loading: false, error: "", needsLogin: undefined, projects };
      } catch (e) {
        this.connect = {
          org, loading: false, projects: [], error: String(e?.message ?? e),
          needsLogin: e instanceof NeedsLogin ? e.tenant : undefined,
        };
      }
      cx.notify();
    });
    cx.notify();
  }

  // Device code flow: show the code, open the page, wait for the person.
  signIn(tenant, then, cx) {
    const started = Date.now();
    this.login = { tenant, code: "", uri: "", error: "", then };
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(`${LOGIN}/${authority(tenant)}/oauth2/v2.0/devicecode`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form({ client_id: CLIENT_ID, scope: ADO_SCOPE }),
        });
        const dc = await res.json();
        if (!dc.device_code) throw new Error(dc.error_description ?? "Microsoft refused the sign-in request.");
        this.login = { ...this.login, code: dc.user_code, uri: dc.verification_uri };
        cx.write_to_clipboard(dc.user_code);
        cx.open_url(dc.verification_uri);
        cx.notify();
        let wait = (dc.interval ?? 5) * 1000;
        while (this.login?.code === dc.user_code && Date.now() - started < (dc.expires_in ?? 900) * 1000) {
          await cx.sleep(wait);
          if (this.login?.code !== dc.user_code) return;
          const out = await tokenRequest(tenant, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc.device_code });
          if (out.access_token) {
            await keep(tenant, out);
            const after = this.login.then;
            this.login = null;
            after?.(cx);
            cx.notify();
            return;
          }
          if (out.error === "slow_down") wait += 5000;
          else if (out.error !== "authorization_pending") throw new Error(out.error_description?.split("\n")[0] ?? out.error);
        }
        if (this.login?.code === dc.user_code) throw new Error("The code expired. Try again.");
      } catch (e) {
        if (this.login) this.login = { ...this.login, code: "", error: String(e?.message ?? e) };
        cx.notify();
      }
    });
    cx.notify();
  }

  pick(project, cx) {
    const space = this.current().space;
    if (!space || !this.connect) return;
    const next = { ...links(), [space.id]: { org: this.connect.org, project } };
    this.connect = null;
    cx.spawn(async (cx) => { await saveLinks(next); cx.notify(); });
  }

  unlink(cx) {
    const space = this.current().space;
    if (!space) return;
    const next = { ...links() };
    delete next[space.id];
    cx.spawn(async (cx) => { await saveLinks(next); cx.notify(); });
  }

  // Reads the whole PBI here, where the panel is signed in, and hands the agent a file.
  startAgent(p, space, link, cx, after) {
    if (this.starting[p.id]) return;
    this.starting[p.id] = true;
    cx.spawn(async (cx) => {
      try {
        const md = await pbiMarkdown(link, p.id);
        const dir = `${appHome()}/data/pbis-items`;
        try { await fs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
        const file = `${dir}/${orgName(link.org)}-${p.id}.md`;
        await fs.writeFile(file, md);
        const task = [
          `Work on Azure DevOps PBI #${p.id}: ${p.title}`,
          "",
          `The full PBI (fields, acceptance criteria, comments, linked items) is in this file. Read it first: ${file}`,
          `You do not need to sign in to Azure DevOps to read it. Link: ${p.url}`,
        ].join("\n");
        run("tab.new", { space: space.id, name: `#${p.id}`, argv: ["claude"], task });
        after?.();
      } catch (e) {
        notify({ title: `Could not read PBI #${p.id}`, body: String(e?.message ?? e), level: "error" });
      } finally {
        delete this.starting[p.id];
        cx.notify();
      }
    });
    cx.notify();
  }

  // ---------- drawing ----------

  button(id, label, t, onClick, style) {
    const primary = style === "primary", on = style === "on";
    return div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(7).text_size(11.5).cursor_pointer()
      .border_1().border_color(primary ? t.solid : on ? t.accent : t.border)
      .bg(primary ? t.solid : on ? t.selected : t.raised)
      .text_color(primary ? t.solid_foreground : on ? t.accent : t.foreground).hover((s) => s.opacity(0.88))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick).child(label);
  }

  field(state, t) {
    return div().h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().w_full().text_size(12.5).text_color(t.foreground));
  }

  loginBox(t, tenant, message, retry) {
    const l = this.login && this.login.tenant === tenant ? this.login : null;
    const box = v_flex().gap(8).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface);
    if (l?.code) {
      return box
        .child(div().text_size(11.5).text_color(t.muted).child("Enter this code on the Microsoft page that just opened (it is on your clipboard):"))
        .child(div().text_size(20).font_semibold().text_color(t.foreground).child(l.code))
        .child(div().text_size(11).text_color(t.dim).child("Pick the account that has access to this organization. Waiting for you…"))
        .child(h_flex().gap(6)
          .child(this.button("pbis-open", "Open page", t, (_e, cx) => cx.open_url(l.uri)))
          .child(this.button("pbis-cancel", "Cancel", t, (_e, cx) => { this.login = null; cx.notify(); })));
    }
    if (l && !l.error) return box.child(div().text_size(11.5).text_color(t.dim).child("Asking Microsoft for a code…"));
    return box
      .child(div().text_size(11.5).text_color(t.ansi1).child(l?.error || message))
      .child(h_flex().gap(6)
        .child(this.button("pbis-signin", "Sign in with Microsoft", t, (_e, cx) => this.signIn(tenant, retry, cx), "primary"))
        .child(this.button("pbis-retry", "Retry", t, (_e, cx) => retry(cx))));
  }

  linkStep(t, space) {
    const c = this.connect;
    const body = v_flex().flex_1().min_h(0).p(14).gap(8)
      .child(div().text_size(12.5).text_color(t.muted).child(`Link "${space.name}" to an Azure DevOps project.`))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).child(this.field(this.orgInput, t)))
        .child(this.button("pbis-connect", c?.loading ? "…" : "Connect", t, (_e, cx) => this.connectOrg(cx), "primary")));
    if (!c) return body;
    if (c.loading) return body.child(div().text_size(11.5).text_color(t.dim).child("Reading projects…"));
    if (c.needsLogin !== undefined) return body.child(this.loginBox(t, c.needsLogin, c.error, (cx) => this.connectOrg(cx)));
    if (c.error) return body.child(div().text_size(11.5).text_color(t.ansi1).child(c.error));
    const q = this.filter.trim().toLowerCase();
    const shown = c.projects.filter((p) => !q || p.toLowerCase().includes(q));
    return body
      .child(div().text_size(11).text_color(t.dim).child(`${c.projects.length} projects in ${orgName(c.org)}`))
      .child(this.field(this.filterInput, t))
      .child(div().flex_1().min_h(60).relative()
        .child(v_flex().id("pbis-projects").absolute().inset_0().overflow_y_scroll().gap(2)
          .children(shown.map((p) => h_flex().id(`proj-${p}`).h(28).flex_none().px(8).items_center().rounded(7)
            .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(p, cx))
            .child(div().truncate().child(p)))))
        .child(Scrollbar.vertical("pbis-projects").absolute().inset_0()));
  }

  // A colored pill per state, from theme colors so it follows light and dark.
  statusColor(state, t) {
    const s = state.toLowerCase();
    if (/done|closed|removed/.test(s)) return t.ansi2;
    if (/hold|block/.test(s)) return t.ansi1;
    if (/test|review|resolved|accept/.test(s)) return t.ansi5;
    if (/commit|active|progress|doing|dev/.test(s)) return t.ansi3;
    if (/approved|ready/.test(s)) return t.ansi4;
    return t.muted;
  }

  status(state, t) {
    const c = this.statusColor(state, t);
    const tint = (alpha) => /^#[0-9a-f]{6}$/i.test(c) ? c + alpha : c;
    return h_flex().flex_none().h(18).px(7).gap(5).items_center().rounded(9)
      .border_1().border_color(tint("66")).bg(tint("1f"))
      .child(div().size(6).rounded(3).bg(c))
      .child(div().text_size(10.5).font_medium().text_color(c).child(state));
  }

  // ---------- iteration, area and status filters ----------

  // Per space: { iteration, area, state }, each a value or "" for all.
  filters(space) {
    const none = { iteration: "", area: "", state: "" };
    try { return { ...none, ...JSON.parse(localStorage.getItem(`pbis.filter.${space.id}`) ?? "{}") }; }
    catch { return none; }
  }

  // Paths match themselves and everything under them; a status matches itself.
  static matches(p, facet, chosen) {
    return facet === "state" ? !chosen || p.state === chosen : Pbis.under(p[facet], chosen);
  }

  // The items that pass every filter except `skip`.
  static passing(items, chosen, skip) {
    return items.filter((p) => ["iteration", "area", "state"].every((f) => f === skip || Pbis.matches(p, f, chosen[f])));
  }

  setFilter(space, facet, value, cx) {
    const next = { ...this.filters(space), [facet]: value };
    localStorage.setItem(`pbis.filter.${space.id}`, JSON.stringify(next));
    this.facetOpen = null;
    cx.notify();
  }

  // A path matches itself and everything under it.
  static under(path, chosen) {
    return !chosen || path === chosen || path.startsWith(chosen + "\\");
  }

  static pathLabel(path, facet) {
    if (facet === "state") return path;
    const i = path.indexOf("\\");
    if (i < 0) return facet === "iteration" ? "No iteration (backlog)" : `${path} (root)`;
    return path.slice(i + 1);
  }

  facetButton(space, facet, title, value, t) {
    const open = this.facetOpen === facet;
    const label = value ? Pbis.pathLabel(value, facet).split("\\").pop() : "All";
    return div().id(`pbis-facet-${facet}`).h(26).px(8).flex().flex_1().min_w(0).gap(4).items_center().rounded(7)
      .text_size(11.5).cursor_pointer().border_1()
      .border_color(value || open ? t.accent : t.border).bg(value ? t.selected : t.raised)
      .hover((s) => s.opacity(0.88))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.facetOpen = open ? null : facet; cx.notify(); })
      .child(div().flex_none().text_color(t.dim).child(title))
      .child(div().flex_1().min_w(0).truncate().text_color(value ? t.accent : t.foreground).child(label))
      .child(div().flex_none().text_color(t.dim).child(open ? "▴" : "▾"));
  }

  facetList(space, facet, items, chosen, t) {
    const counts = new Map();
    for (const p of items) counts.set(p[facet], (counts.get(p[facet]) ?? 0) + 1);
    // Statuses in workflow order where known; paths by name.
    const ORDER = ["new", "to do", "approved", "ready", "committed", "active", "in progress", "doing", "ready for testing", "testing", "resolved", "on hold", "blocked"];
    const rank = (v) => { const i = ORDER.indexOf(v.toLowerCase()); return i < 0 ? ORDER.length : i; };
    const paths = [...counts.keys()].sort((a, b) => (facet === "state" ? rank(a) - rank(b) : 0) || a.localeCompare(b, undefined, { numeric: true }));
    if (chosen && !counts.has(chosen)) paths.unshift(chosen);
    const row = (key, label, count, on, value) => h_flex().id(`pbis-${facet}-${key}`).h(26).flex_none().px(8).gap(8)
      .items_center().rounded(6).cursor_pointer().bg(on ? t.selected : t.surface).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.setFilter(space, facet, value, cx))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(on ? t.accent : t.foreground).child(label))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(String(count)));
    return div().flex_none().max_h(220).relative().mx(14).mb(8).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(v_flex().id(`pbis-${facet}-list`).max_h(218).overflow_y_scroll().p(4).gap(1)
        .child(row("all", { iteration: "All iterations", area: "All areas", state: "All statuses" }[facet], items.length, !chosen, ""))
        .children(paths.map((path, i) => row(i, Pbis.pathLabel(path, facet), counts.get(path) ?? 0, path === chosen, path))));
  }

  card(p, t, space, link) {
    const sprint = p.iteration.includes("\\") ? p.iteration.split("\\").pop() : "";
    const meta = [p.effort && `${p.effort} pts`, p.assignedTo, sprint].filter(Boolean).join(" · ");
    return v_flex().id(`pbi-${p.id}`).flex_none().p(10).gap(4).rounded(9).border_1().border_color(t.border).bg(t.surface)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.openDetail(p, space, link))
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(11).font_semibold().text_color(t.accent).child(`#${p.id}`))
        .when(Boolean(p.state), (el) => el.child(this.status(p.state, t)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(meta))
        .child(div().id(`pbi-run-${p.id}`).px(6).py(1).rounded(5).text_size(10.5).text_color(t.muted)
          .border_1().border_color(t.border).hover((s) => s.bg(t.raised).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.startAgent(p, space, link, cx); })
          .child(this.starting[p.id] ? "Reading…" : "Start agent")))
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(p.title))
      .child(div().text_size(11.5).text_color(t.muted).child(p.summary || "No description."));
  }

  render(cx) {
    const t = theme();
    if (this.detail) return this.renderDetail(t);
    const { space, link } = this.current();
    const root = v_flex().id("pbis").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13);
    if (!space) return root.child(div().p(14).text_color(t.dim).child("No space."));
    if (!this.ready) return root.child(div().p(14).text_color(t.dim).child("Loading…"));

    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("PBIs"))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(link ? link.project : space.name));
    if (!link) return root.child(header).child(this.linkStep(t, space));

    this.refresh(cx, false);
    const key = this.cacheKey(space, link);
    const entry = this.cache[key] ?? { items: [], loading: true, error: "" };
    const time = entry.at ? new Date(entry.at).toTimeString().slice(0, 5) : "";
    const tenant = tenants[link.org];
    const user = tenant !== undefined ? authStore?.[authority(tenant)]?.user : "";
    const chosen = this.filters(space);
    const shown = Pbis.passing(entry.items, chosen, null);
    const filtered = Boolean(chosen.iteration || chosen.area || chosen.state);
    const count = filtered ? `${shown.length} of ${entry.items.length}` : `${entry.items.length}`;

    return root
      .child(header.child(div().text_size(11).text_color(t.dim).child(entry.loading ? "loading…" : `${count}${time ? ` · ${time}` : ""}`)))
      .child(h_flex().flex_none().px(14).py(8).gap(6).border_b(1).border_color(t.border)
        .child(this.button("pbis-refresh", "Refresh", t, (_e, cx) => this.refresh(cx, true)))
        .child(this.button("pbis-mine", "Assigned to me", t, (_e, cx) => {
          this.mine = !this.mine;
          localStorage.setItem("pbis.mine", this.mine ? "1" : "0");
          this.refresh(cx, false);
          cx.notify();
        }, this.mine ? "on" : undefined))
        .child(div().flex_1())
        .child(this.button("pbis-unlink", "Unlink", t, (_e, cx) => this.unlink(cx))))
      .child(h_flex().flex_none().px(14).pt(8).pb(this.facetOpen ? 6 : 8).gap(6)
        .when(!this.facetOpen, (el) => el.border_b(1).border_color(t.border))
        .child(this.facetButton(space, "iteration", "Iteration", chosen.iteration, t))
        .child(this.facetButton(space, "area", "Area", chosen.area, t))
        .child(this.facetButton(space, "state", "Status", chosen.state, t)))
      .when(Boolean(this.facetOpen), (el) => el.child(this.facetList(space, this.facetOpen,
        Pbis.passing(entry.items, chosen, this.facetOpen), chosen[this.facetOpen], t)))
      .when(Boolean(user), (el) => el.child(h_flex().flex_none().px(14).py(4).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(`Signed in as ${user}`))
        .child(div().id("pbis-signout").text_size(10.5).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => cx.spawn(async (cx) => { await signOut(tenant); this.refresh(cx, true); cx.notify(); }))
          .child("Sign out"))))
      .when(entry.needsLogin !== undefined, (el) => el.child(div().p(10).child(
        this.loginBox(t, entry.needsLogin, entry.error, (cx) => this.refresh(cx, true)))))
      .when(Boolean(entry.error) && entry.needsLogin === undefined, (el) => el.child(div().px(14).py(8).text_size(11.5).text_color(t.ansi1).child(entry.error)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("pbis-list").absolute().inset_0().overflow_y_scroll().p(10).gap(8)
          .children(shown.map((p) => this.card(p, t, space, link)))
          .when(!entry.loading && !entry.error && !shown.length, (el) => el.child(div().text_color(t.dim)
            .child(filtered ? "No open PBIs match these filters."
              : this.mine ? "No open PBIs assigned to you." : "No open PBIs."))))
        .child(Scrollbar.vertical("pbis-list").absolute().inset_0()));
  }
}
