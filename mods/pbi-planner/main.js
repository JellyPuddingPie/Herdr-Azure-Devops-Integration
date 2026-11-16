// Turns pasted text into a plan of Features and PBIs, shows it as a board,
// and creates the items in the Azure DevOps project linked to the space.
// Uses the sign-ins and space links of the pbis mod.
import { View, div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { spaces, exec, theme, appHome, props, closeOverlay, window as appWindow } from "herdr";
import * as fs from "fs/promises";

const ADO_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access openid profile";
// Microsoft's public client for Visual Studio: allowed to ask for Azure DevOps tokens.
const CLIENT_ID = "872cd9fa-d31f-45e0-9eab-6e460a02d1f1";
const LOGIN = "https://login.microsoftonline.com";
const NO_TENANT = "00000000-0000-0000-0000-000000000000";
const CLOSED = ["'Done'", "'Removed'", "'Closed'"];

const tenants = {};
const tokens = {};

class NeedsLogin extends Error {
  constructor(tenant, message) { super(message); this.tenant = tenant; }
}

// ---------- files ----------

const dataDir = () => `${appHome()}/data`;
const planDir = () => `${dataDir()}/pbi-plans`;

async function readJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return fallback; }
}
async function writeJson(path, value) {
  try { await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true }); } catch { /* exists */ }
  await fs.writeFile(path, JSON.stringify(value, null, 2));
}

let authStore = null;
async function readAuth() {
  if (!authStore) authStore = await readJson(`${dataDir()}/pbis-auth.json`, {});
  return authStore;
}
async function saveAuth(next) { authStore = next; await writeJson(`${dataDir()}/pbis-auth.json`, next); }

const readIndex = () => readJson(`${planDir()}/index.json`, []);
const saveIndex = (list) => writeJson(`${planDir()}/index.json`, list);
const readPlan = (id) => readJson(`${planDir()}/${id}.json`, null);

async function savePlan(plan) {
  plan.updated = Date.now();
  await writeJson(`${planDir()}/${plan.id}.json`, plan);
  const index = (await readIndex()).filter((p) => p.id !== plan.id);
  index.unshift(summary(plan));
  await saveIndex(index);
}

function summary(plan) {
  const all = items(plan);
  return {
    id: plan.id, name: plan.name, org: plan.org, project: plan.project, updated: plan.updated,
    features: plan.features.length, pbis: all.filter((x) => x.kind === "pbi").length,
    status: plan.status, created: all.filter((x) => x.item.createdId || x.item.existingId).length, total: all.length,
  };
}

// Every Feature and PBI of a plan, Features first.
function items(plan) {
  const out = [];
  plan.features.forEach((f, fi) => out.push({ kind: "feature", item: f, fi }));
  plan.features.forEach((f, fi) => f.pbis.forEach((p, pi) => out.push({ kind: "pbi", item: p, fi, pi })));
  return out;
}

// ---------- helpers ----------

const orgName = (org) => org.replace(/^https:\/\/dev\.azure\.com\//, "");
const form = (fields) => Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
const short = (text, max = 140) => text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
const newKey = () => Math.random().toString(36).slice(2, 10);
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function html(text) {
  return String(text ?? "").trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

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
    const c = JSON.parse(base64url(idToken.split(".")[1]));
    return c.preferred_username ?? c.email ?? c.name ?? "";
  } catch { return ""; }
}

// ---------- sign-in (same flow and file as the pbis mod) ----------

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
  authStore = null; // the pbis panel may have signed in since
  const saved = (await readAuth())[key];
  if (!saved?.refresh_token) throw new NeedsLogin(tenant, "Sign in to reach this organization.");
  const out = await tokenRequest(tenant, { grant_type: "refresh_token", refresh_token: saved.refresh_token, scope: ADO_SCOPE });
  if (!out.access_token) throw new NeedsLogin(tenant, "Your sign-in expired. Sign in again.");
  return await keep(tenant, out);
}

async function ado(org, path, body, contentType = "application/json") {
  const tenant = await tenantOf(org);
  const bearer = await getToken(tenant);
  const res = await fetch(`${org}/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": contentType, Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* sign-in page or empty */ }
  if (res.status === 401 || res.status === 203 || (res.ok && data === null)) {
    delete tokens[authority(tenant)];
    throw new NeedsLogin(tenant, "Azure DevOps did not accept this sign-in.");
  }
  if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
  return data;
}

// ---------- Azure DevOps ----------

async function openFeatures(link) {
  const project = encodeURIComponent(link.project);
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Feature' AND [System.State] NOT IN (${CLOSED.join(", ")}) ORDER BY [System.ChangedDate] DESC`;
  const found = await ado(link.org, `${project}/_apis/wit/wiql?$top=200&api-version=7.1`, { query: wiql });
  const ids = (found.workItems ?? []).map((w) => w.id).slice(0, 200);
  if (!ids.length) return [];
  const got = await ado(link.org, `${project}/_apis/wit/workitems?ids=${ids.join(",")}&fields=System.Id,System.Title&api-version=7.1`);
  return (got.value ?? []).map((w) => ({ id: w.id, title: String(w.fields?.["System.Title"] ?? "") }));
}

// Scrum projects have Product Backlog Item with Effort; Agile has User Story with Story Points.
async function backlogType(link) {
  const got = await ado(link.org, `${encodeURIComponent(link.project)}/_apis/wit/workitemtypes?api-version=7.1`);
  const names = (got.value ?? []).map((w) => w.name);
  if (names.includes("Product Backlog Item")) return { type: "Product Backlog Item", effort: "Microsoft.VSTS.Scheduling.Effort" };
  if (names.includes("User Story")) return { type: "User Story", effort: "Microsoft.VSTS.Scheduling.StoryPoints" };
  if (names.includes("Requirement")) return { type: "Requirement", effort: "Microsoft.VSTS.Scheduling.Size" };
  throw new Error("This project has no Product Backlog Item or User Story type.");
}

async function createItem(link, type, fields, parentId) {
  const ops = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => ({ op: "add", path: `/fields/${k}`, value: v }));
  if (parentId) {
    ops.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${link.org}/_apis/wit/workItems/${parentId}` } });
  }
  const project = encodeURIComponent(link.project);
  const made = await ado(link.org, `${project}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`, ops, "application/json-patch+json");
  return made.id;
}

const itemUrl = (plan, id) => `${plan.org}/${encodeURIComponent(plan.project)}/_workitems/edit/${id}`;

// ---------- drafting with Claude ----------

function draftBrief(plan, existing) {
  return [
    "# Task",
    "",
    "Turn the input text below into an Azure DevOps backlog: Features, each with Product Backlog Items (PBIs).",
    "",
    "Rules:",
    "- A Feature is a coherent piece of functionality that delivers value. Group related PBIs under it.",
    "- A PBI is one deliverable a team can finish in one sprint. Title it as a short outcome, for example \"Customer can start a return from an order\".",
    "- Description: 2 to 5 sentences. Say who needs it, what it does and why. Use the language of the input text.",
    "- Acceptance criteria: 2 to 6 testable statements per PBI.",
    "- Effort: a Fibonacci number (1, 2, 3, 5, 8, 13) when you can estimate it, else null.",
    "- Tags: 0 to 3 short tags.",
    "- Do not invent requirements that the text does not support. Put open questions at the end of the description, starting with \"Open question:\".",
    existing.length
      ? "- When an existing Feature below fits, use it: give its id as existingId and leave its title as is. Do not create a new Feature that duplicates an existing one."
      : "- The project has no open Features. Create new ones.",
    "",
    "Answer with only one JSON object, no other text, in this shape:",
    "",
    "```json",
    '{ "features": [ { "title": "", "description": "", "existingId": null, "pbis": [ { "title": "", "description": "", "acceptanceCriteria": [""], "effort": null, "tags": [""] } ] } ] }',
    "```",
    "",
    existing.length ? "# Existing open Features\n\n" + existing.map((f) => `- ${f.id}: ${f.title}`).join("\n") : "",
    "",
    `# Input text (plan "${plan.name}")`,
    "",
    plan.input,
  ].join("\n");
}

function parseDraft(out) {
  let result = out;
  try { const wrapped = JSON.parse(out); if (typeof wrapped?.result === "string") result = wrapped.result; } catch { /* plain text */ }
  const start = result.indexOf("{"), end = result.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Claude gave no JSON. " + short(result.trim(), 200));
  const data = JSON.parse(result.slice(start, end + 1));
  if (!Array.isArray(data.features) || !data.features.length) throw new Error("Claude gave no Features.");
  const list = (v) => Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  return data.features.map((f) => ({
    key: newKey(),
    title: String(f.title ?? "Feature"),
    description: String(f.description ?? ""),
    existingId: Number(f.existingId) || null,
    pbis: (Array.isArray(f.pbis) ? f.pbis : []).map((p) => ({
      key: newKey(),
      title: String(p.title ?? "PBI"),
      description: String(p.description ?? ""),
      acceptanceCriteria: list(p.acceptanceCriteria),
      effort: Number(p.effort) || null,
      tags: list(p.tags),
    })),
  }));
}

// Claude Code in print mode. Its stdin must be closed, or it waits for input.
// On Windows the npm shim (claude.cmd) comes first: a WinGet claude.exe on the PATH can be much older.
async function runClaude(prompt, cwd) {
  const flags = "--allowedTools Read --output-format json";
  const r = appWindow()?.platform === "windows"
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "$c = (Get-Command claude.cmd, claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source; " +
      "if (-not $c) { Write-Error 'Claude Code (claude) is not installed or not on the PATH.'; exit 9 }; " +
      `$null | & $c -p '${prompt.replace(/'/g, "''")}' ${flags}`], { cwd, timeout: 600000 })
    : await exec("sh", ["-c", `claude -p "$1" ${flags} < /dev/null`, "sh", prompt], { cwd, timeout: 600000 });
  const out = r.stdout.trim();
  if (r.code !== 0 || !out) {
    const why = (r.stderr || out).split("\n").filter((l) => l.trim() && !/InitializeDefaultDrives/.test(l)).join(" ");
    throw new Error(short(why || `Claude Code stopped with code ${r.code} and no output.`, 400));
  }
  try { const j = JSON.parse(out); if (j.is_error) throw new Error(short(String(j.result ?? "Claude Code reported an error."), 400)); }
  catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  return out;
}

// ---------- the planner ----------

export default class Planner extends View {
  init(_props, cx) {
    this.screen = "list"; // list | new | board | item
    this.index = [];
    this.plan = null;
    this.edit = null; // { fi, pi } of the item open in the item view; pi null for a Feature
    this.busy = "";
    this.error = "";
    this.needsLogin = undefined;
    this.login = null;
    this.confirm = false;
    this.nameInput = InputState.new({ placeholder: "Plan name, for example Webshop returns flow" });
    this.textInput = TextareaState.new({ placeholder: "Paste meeting notes, scope or requirements here", rows: 18 });
    cx.spawn(async (cx) => {
      this.link = await this.readLink();
      this.index = await readIndex();
      this.ready = true;
      cx.notify();
    });
  }

  async readLink() {
    const id = props()?.space ?? spaces().find((s) => s.active)?.id;
    this.spaceName = spaces().find((s) => s.id === id)?.name ?? "";
    const links = await readJson(`${dataDir()}/pbis-links.json`, {});
    return id ? links[id] ?? null : null;
  }

  close() { closeOverlay(props().overlay); }

  fail(e) {
    this.error = String(e?.message ?? e);
    this.needsLogin = e instanceof NeedsLogin ? e.tenant : undefined;
  }

  // ---------- actions ----------

  newPlan(cx) {
    this.nameInput.set_value("");
    this.textInput.set_value("");
    this.error = ""; this.needsLogin = undefined;
    this.screen = "new";
    cx.notify();
  }

  openPlan(id, cx) {
    cx.spawn(async (cx) => {
      const plan = await readPlan(id);
      if (!plan) { this.error = "This plan file is gone."; cx.notify(); return; }
      // A draft that ran when the dialog closed was cancelled with it.
      if (plan.status === "drafting") { plan.status = "error"; plan.error = "Drafting stopped when the window closed. Press Redraft."; }
      this.plan = plan;
      this.error = ""; this.needsLogin = undefined; this.confirm = false;
      this.screen = "board";
      cx.notify();
    });
  }

  deletePlan(id, cx) {
    cx.spawn(async (cx) => {
      try { await fs.rm(`${planDir()}/${id}.json`); } catch { /* gone */ }
      this.index = (await readIndex()).filter((p) => p.id !== id);
      await saveIndex(this.index);
      cx.notify();
    });
  }

  startDraft(cx) {
    const input = this.textInput.value().trim();
    if (!input) { this.error = "Paste some text first."; cx.notify(); return; }
    const name = this.nameInput.value().trim() || input.split("\n")[0].slice(0, 60);
    const plan = {
      id: `${Date.now().toString(36)}-${newKey().slice(0, 4)}`, name, org: this.link.org, project: this.link.project,
      input, status: "drafting", error: "", features: [], created: Date.now(),
    };
    this.plan = plan;
    this.screen = "board";
    this.draft(cx);
  }

  draft(cx) {
    const plan = this.plan;
    plan.status = "drafting"; plan.error = "";
    this.error = ""; this.needsLogin = undefined;
    cx.spawn(async (cx) => {
      try {
        await savePlan(plan);
        const existing = await openFeatures(this.link);
        const file = `${planDir()}/${plan.id}.input.md`;
        await fs.writeFile(file, draftBrief(plan, existing));
        const out = await runClaude(`Read the file ${file} and do the task in it. Answer with only the JSON object.`, planDir());
        const features = parseDraft(out);
        const known = new Map(existing.map((f) => [f.id, f.title]));
        for (const f of features) {
          if (f.existingId && known.has(f.existingId)) f.title = known.get(f.existingId);
          else f.existingId = null;
        }
        plan.features = features;
        plan.status = "draft";
      } catch (e) {
        plan.status = "error";
        plan.error = String(e?.message ?? e);
        this.fail(e);
      }
      await savePlan(plan);
      this.index = await readIndex();
      cx.notify();
    });
    cx.notify();
  }

  openItem(fi, pi, cx) {
    const f = this.plan.features[fi];
    const it = pi === null ? f : f.pbis[pi];
    this.edit = { fi, pi, parent: fi };
    this.f = {
      title: InputState.new({ value: it.title, placeholder: "Title" }),
      description: TextareaState.new({ value: it.description, rows: 8, placeholder: "Description" }),
      ac: TextareaState.new({ value: (it.acceptanceCriteria ?? []).join("\n"), rows: 7, placeholder: "One acceptance criterion per line" }),
      effort: InputState.new({ value: it.effort ? String(it.effort) : "", placeholder: "Effort" }),
      tags: InputState.new({ value: (it.tags ?? []).join(", "), placeholder: "tag one, tag two" }),
    };
    this.screen = "item";
    cx.notify();
  }

  addFeature(cx) {
    this.plan.features.push({ key: newKey(), title: "New Feature", description: "", existingId: null, pbis: [] });
    this.openItem(this.plan.features.length - 1, null, cx);
  }

  addPbi(fi, cx) {
    const f = this.plan.features[fi];
    f.pbis.push({ key: newKey(), title: "New PBI", description: "", acceptanceCriteria: [], effort: null, tags: [] });
    this.openItem(fi, f.pbis.length - 1, cx);
  }

  saveItem(cx) {
    const { fi, pi, parent } = this.edit;
    const f = this.plan.features[fi];
    const it = pi === null ? f : f.pbis[pi];
    it.title = this.f.title.value().trim() || it.title;
    it.description = this.f.description.value();
    if (pi !== null) {
      it.acceptanceCriteria = this.f.ac.value().split("\n").map((s) => s.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean);
      it.effort = Number(this.f.effort.value()) || null;
      it.tags = this.f.tags.value().split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      if (parent !== fi) {
        f.pbis.splice(pi, 1);
        this.plan.features[parent].pbis.push(it);
      }
    }
    this.backToBoard(cx);
  }

  deleteItem(cx) {
    const { fi, pi } = this.edit;
    if (pi === null) this.plan.features.splice(fi, 1);
    else this.plan.features[fi].pbis.splice(pi, 1);
    this.backToBoard(cx);
  }

  backToBoard(cx) {
    this.edit = null; this.f = null;
    this.screen = "board";
    cx.spawn(async (cx) => { await savePlan(this.plan); this.index = await readIndex(); cx.notify(); });
    cx.notify();
  }

  // Features first, then the PBIs under them. Each id is saved at once, so a retry skips it.
  create(cx) {
    const plan = this.plan;
    this.confirm = false;
    this.busy = "Creating…";
    this.error = ""; this.needsLogin = undefined;
    cx.spawn(async (cx) => {
      try {
        const kind = await backlogType(this.link);
        for (const f of plan.features) {
          if (f.existingId || f.createdId) continue;
          this.busy = `Creating Feature "${short(f.title, 40)}"…`; cx.notify();
          try {
            f.createdId = await createItem(this.link, "Feature", { "System.Title": f.title, "System.Description": html(f.description) });
            f.failed = "";
          } catch (e) { if (e instanceof NeedsLogin) throw e; f.failed = String(e?.message ?? e); }
          await savePlan(plan); cx.notify();
        }
        for (const f of plan.features) {
          const parent = f.existingId || f.createdId;
          for (const p of f.pbis) {
            if (p.createdId) continue;
            this.busy = `Creating "${short(p.title, 40)}"…`; cx.notify();
            try {
              const ac = p.acceptanceCriteria.length ? `<ul>${p.acceptanceCriteria.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>` : "";
              p.createdId = await createItem(this.link, kind.type, {
                "System.Title": p.title,
                "System.Description": html(p.description),
                "Microsoft.VSTS.Common.AcceptanceCriteria": ac,
                [kind.effort]: p.effort ?? undefined,
                "System.Tags": p.tags.join("; "),
              }, parent);
              p.failed = "";
            } catch (e) { if (e instanceof NeedsLogin) throw e; p.failed = String(e?.message ?? e); }
            await savePlan(plan); cx.notify();
          }
        }
        const failed = items(plan).filter((x) => x.item.failed).length;
        plan.status = failed ? "partly created" : "created";
        if (failed) this.error = `${failed} item(s) failed. Hover a red card to see why, fix it and press Create again.`;
      } catch (e) {
        this.fail(e);
      }
      this.busy = "";
      await savePlan(plan);
      this.index = await readIndex();
      cx.notify();
    });
    cx.notify();
  }

  // Device code flow, as in the pbis panel.
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
            this.needsLogin = undefined; this.error = "";
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

  // ---------- drawing ----------

  button(id, label, t, onClick, style) {
    const primary = style === "primary", danger = style === "danger";
    return div().id(id).h(28).px(12).flex().flex_none().items_center().rounded(7).text_size(12).cursor_pointer()
      .border_1().border_color(primary ? t.solid : danger ? t.ansi1 : t.border)
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground).hover((s) => s.opacity(0.88))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick).child(label);
  }

  input(state, t, width) {
    const box = div().h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().w_full().text_size(12.5).text_color(t.foreground));
    return width ? box.w(width).flex_none() : box;
  }

  textarea(state, t) {
    return div().px(10).py(8).rounded(8).border_1().border_color(t.input).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Textarea.new(state).w_full().text_size(12.5).text_color(t.foreground));
  }

  label(text, t) { return div().text_size(11).font_medium().text_color(t.dim).child(text); }

  pill(text, color, t) {
    const tint = (a) => /^#[0-9a-f]{6}$/i.test(color) ? color + a : color;
    return h_flex().flex_none().h(18).px(7).gap(5).items_center().rounded(9)
      .border_1().border_color(tint("66")).bg(tint("1f"))
      .child(div().size(6).rounded(3).bg(color))
      .child(div().text_size(10.5).font_medium().text_color(color).child(text));
  }

  itemPill(it, t) {
    if (it.existingId) return this.pill(`Existing #${it.existingId}`, t.ansi4, t);
    if (it.createdId) return this.pill(`Created #${it.createdId}`, t.ansi2, t);
    if (it.failed) return this.pill("Failed", t.ansi1, t);
    return this.pill("New", t.muted, t);
  }

  loginBox(t, tenant, message, retry) {
    const l = this.login && this.login.tenant === tenant ? this.login : null;
    const box = v_flex().gap(8).p(12).rounded(8).border_1().border_color(t.border).bg(t.surface);
    if (l?.code) {
      return box
        .child(div().text_size(12).text_color(t.muted).child("Enter this code on the Microsoft page that just opened (it is on your clipboard):"))
        .child(div().text_size(20).font_semibold().child(l.code))
        .child(h_flex().gap(6)
          .child(this.button("plan-open-login", "Open page", t, (_e, cx) => cx.open_url(l.uri)))
          .child(this.button("plan-cancel-login", "Cancel", t, (_e, cx) => { this.login = null; cx.notify(); })));
    }
    if (l && !l.error) return box.child(div().text_size(12).text_color(t.dim).child("Asking Microsoft for a code…"));
    return box
      .child(div().text_size(12).text_color(t.ansi1).child(l?.error || message))
      .child(h_flex().gap(6)
        .child(this.button("plan-signin", "Sign in with Microsoft", t, (_e, cx) => this.signIn(tenant, retry, cx), "primary")));
  }

  header(t, title, sub, right) {
    return h_flex().h(52).flex_none().px(20).gap(10).items_center().border_b(1).border_color(t.border)
      .child(div().text_size(15).font_semibold().child(title))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(sub))
      .children(right)
      .child(this.button("plan-close", "Close", t, () => this.close()));
  }

  hasError() { return Boolean(this.error) || this.needsLogin !== undefined; }

  errorLine(t, retry) {
    if (this.needsLogin !== undefined) return div().px(20).pt(12).child(this.loginBox(t, this.needsLogin, this.error, retry));
    if (!this.error) return null;
    return div().px(20).pt(10).text_size(12).text_color(t.ansi1).child(this.error);
  }

  renderList(t) {
    const where = `${orgName(this.link.org)} / ${this.link.project}`;
    const rows = this.index.filter((p) => p.org === this.link.org && p.project === this.link.project);
    return v_flex().size_full().min_h(0)
      .child(this.header(t, "PBI plans", where, [this.button("plan-new", "+ New plan", t, (_e, cx) => this.newPlan(cx), "primary")]))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("plan-list").absolute().inset_0().overflow_y_scroll().p(20).gap(8)
          .when(!rows.length, (el) => el.child(div().text_color(t.dim).child("No plans yet. Press + New plan, paste your text and let Claude draft the Features and PBIs.")))
          .children(rows.map((p) => h_flex().id(`plan-${p.id}`).flex_none().h(52).px(14).gap(12).items_center()
            .rounded(9).border_1().border_color(t.border).bg(t.surface).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.openPlan(p.id, cx))
            .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().child(p.name))
            .child(div().flex_none().text_size(12).text_color(t.dim).child(`${p.features} features · ${p.pbis} PBIs`))
            .child(this.pill(p.status === "created" ? "Created" : p.status === "partly created" ? `${p.created} of ${p.total} created` : p.status === "error" ? "Error" : "Draft",
              p.status === "created" ? t.ansi2 : p.status === "error" ? t.ansi1 : p.status === "partly created" ? t.ansi3 : t.muted, t))
            .child(div().id(`plan-del-${p.id}`).flex_none().text_size(11.5).text_color(t.dim).hover((s) => s.text_color(t.ansi1))
              .on_click((_e, cx) => { cx.stop_propagation(); this.deletePlan(p.id, cx); }).child("Delete")))))
        .child(Scrollbar.vertical("plan-list").absolute().inset_0()));
  }

  renderNew(t) {
    return v_flex().size_full().min_h(0)
      .child(this.header(t, "New plan", `${orgName(this.link.org)} / ${this.link.project}`, []))
      .child(v_flex().flex_1().min_h(0).p(20).gap(10)
        .child(this.label("Name", t))
        .child(this.input(this.nameInput, t))
        .child(this.label("Text", t))
        .child(this.textarea(this.textInput, t))
        .child(div().text_size(11.5).text_color(t.dim).child("Claude Code reads the text and the open Features of the project, and drafts Features with PBIs. It runs on your own Claude Code sign-in. Nothing goes to Azure DevOps until you press Create."))
        .when(this.hasError(), (el) => el.child(this.errorLine(t, (cx) => this.startDraft(cx))))
        .child(h_flex().gap(8)
          .child(div().flex_1())
          .child(this.button("plan-cancel", "Cancel", t, (_e, cx) => { this.screen = "list"; this.error = ""; cx.notify(); }))
          .child(this.button("plan-draft", "Draft with Claude", t, (_e, cx) => this.startDraft(cx), "primary"))));
  }

  card(p, fi, pi, t) {
    const first = p.description.split("\n").find((l) => l.trim()) ?? "";
    const meta = [`${p.acceptanceCriteria.length} AC`, p.effort && `effort ${p.effort}`, p.tags.join(", ")].filter(Boolean).join(" · ");
    return v_flex().id(`card-${p.key}`).flex_none().p(10).gap(5).rounded(9).border_1()
      .border_color(p.failed ? t.ansi1 : t.border).bg(t.surface).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openItem(fi, pi, cx))
      .child(h_flex().gap(6).items_center()
        .child(this.itemPill(p, t))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(meta)))
      .child(div().text_size(13).font_semibold().child(p.title))
      .when(Boolean(first), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(short(first))))
      .when(Boolean(p.failed), (el) => el.child(div().text_size(11).text_color(t.ansi1).child(short(p.failed, 200))));
  }

  column(f, fi, t) {
    return v_flex().id(`col-${f.key}`).w(300).flex_none().h_full().min_h(0).rounded(10).border_1()
      .border_color(f.failed ? t.ansi1 : t.border).bg(t.chrome)
      .child(v_flex().id(`col-head-${f.key}`).flex_none().p(12).gap(6).border_b(1).border_color(t.border).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openItem(fi, null, cx))
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(10.5).font_semibold().text_color(t.accent).child(f.existingId ? "★ FEATURE" : "FEATURE"))
          .child(div().flex_1())
          .child(this.itemPill(f, t)))
        .child(div().text_size(14).font_semibold().child(f.title))
        .child(div().text_size(11).text_color(t.dim).child(`${f.pbis.length} PBIs`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id(`col-list-${f.key}`).absolute().inset_0().overflow_y_scroll().p(8).gap(8)
          .children(f.pbis.map((p, pi) => this.card(p, fi, pi, t)))
          .child(div().id(`add-pbi-${f.key}`).flex_none().h(30).flex().items_center().justify_center().rounded(8)
            .border_1().border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.addPbi(fi, cx)).child("+ PBI")))
        .child(Scrollbar.vertical(`col-list-${f.key}`).absolute().inset_0()));
  }

  viewMode() {
    if (!this.view) { try { this.view = localStorage.getItem("planner.view") || "tree"; } catch { this.view = "tree"; } }
    return this.view;
  }

  legend(t) {
    const swatch = (color, label, dashed) => h_flex().gap(5).items_center()
      .child(dashed
        ? h_flex().gap(2).children([0, 1, 2].map(() => div().w(4).h(2).bg(color)))
        : div().w(16).h(2).bg(color))
      .child(div().text_size(10.5).text_color(t.dim).child(label));
    return h_flex().gap(12)
      .child(swatch(t.muted, "New"))
      .child(swatch(t.ansi4, "Existing in DevOps", true))
      .child(swatch(t.ansi2, "Created"))
      .child(swatch(t.ansi1, "Failed"));
  }

  // The plan as a tree, left to right: plan → Features → PBIs, joined by curved arrows.
  tree(plan, t) {
    const ROOT = { x: 24, w: 210, h: 96 };
    const FEAT = { x: 330, w: 270, h: 104 };
    const PBI = { x: 700, w: 330, h: 112 };
    const ADD = 34, GAP = 14, GROUP = 30, TOP = 24;
    const color = (it) => it.failed ? t.ansi1 : it.createdId ? t.ansi2 : it.existingId ? t.ansi4 : t.muted;

    // Each Feature is centered on its PBIs (plus the "+ PBI" row under them).
    let y = TOP;
    const groups = plan.features.map((f) => {
      const top = y;
      const pbis = f.pbis.map((p, pi) => ({ p, pi, y: top + pi * (PBI.h + GAP) }));
      const addY = top + f.pbis.length * (PBI.h + GAP);
      const bottom = addY + ADD;
      const fy = Math.max(top, (top + bottom) / 2 - FEAT.h / 2);
      y = Math.max(bottom, fy + FEAT.h) + GROUP;
      return { f, fy, pbis, addY };
    });
    const addFeatureY = y;
    const height = addFeatureY + 40 + TOP;
    const width = PBI.x + PBI.w + 40;
    // Centered on the Features, but never below the first screen, so the plan node stays in view.
    const centered = (groups.length ? (groups[0].fy + groups[groups.length - 1].fy + FEAT.h) / 2 : TOP + ROOT.h / 2) - ROOT.h / 2;
    const rootY = Math.max(TOP, Math.min(centered, 220));

    // Connectors: a cubic curve from the right edge of a node to the left edge of its child, with a head.
    const lines = [];
    const link = (x1, y1, x2, y2, c, dashed, w = 1.6) => {
      const mid = (x2 - x1) / 2;
      let path = PathBuilder.stroke(w);
      if (dashed) path = path.dash_array([5, 5]);
      lines.push({ path: path.move_to(x1, y1).cubic_bezier_to(x2 - 8, y2, x1 + mid, y1, x2 - mid - 8, y2).build(), c });
      lines.push({ path: PathBuilder.fill().add_polygon([[x2 - 9, y2 - 4.5], [x2, y2], [x2 - 9, y2 + 4.5]], true).build(), c });
    };
    const rootMid = rootY + ROOT.h / 2;
    for (const g of groups) {
      const fMid = g.fy + FEAT.h / 2;
      link(ROOT.x + ROOT.w, rootMid, FEAT.x, fMid, color(g.f), Boolean(g.f.existingId), 2);
      for (const { p, y: py } of g.pbis) link(FEAT.x + FEAT.w, fMid, PBI.x, py + PBI.h / 2, color(p), false);
    }

    const at = (el, x, top, w, h) => el.absolute().left(x).top(top).w(w).h(h);
    const nodes = [];
    nodes.push(at(v_flex().id("tree-root").p(14).gap(6).rounded(12).border_2().border_color(t.accent).bg(t.selected), ROOT.x, rootY, ROOT.w, ROOT.h)
      .child(div().text_size(10.5).font_semibold().text_color(t.accent).child("PLAN"))
      .child(div().text_size(14).font_semibold().child(short(plan.name, 60)))
      .child(div().text_size(11).text_color(t.dim).child(`${orgName(plan.org)} / ${plan.project}`)));
    groups.forEach(({ f, fy, pbis, addY }, fi) => {
      nodes.push(at(v_flex().id(`tree-f-${f.key}`).p(12).gap(5).rounded(11).border_1().border_color(color(f)).bg(t.surface)
        .overflow_hidden().cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openItem(fi, null, cx)), FEAT.x, fy, FEAT.w, FEAT.h)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(10.5).font_semibold().text_color(t.accent).child(f.existingId ? "★ FEATURE" : "FEATURE"))
          .child(div().flex_1())
          .child(this.itemPill(f, t)))
        .child(div().text_size(13.5).font_semibold().child(short(f.title, 70)))
        .child(div().text_size(11).text_color(t.dim).child(`${f.pbis.length} PBIs · ${f.pbis.reduce((n, p) => n + (p.effort || 0), 0)} effort`)));
      for (const { p, pi, y: py } of pbis) {
        const first = p.description.split("\n").find((l) => l.trim()) ?? "";
        const meta = [`${p.acceptanceCriteria.length} AC`, p.effort && `effort ${p.effort}`].filter(Boolean).join(" · ");
        nodes.push(at(v_flex().id(`tree-p-${p.key}`).p(10).gap(4).rounded(10).border_1().border_color(p.failed ? t.ansi1 : t.border).bg(t.surface)
          .overflow_hidden().cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openItem(fi, pi, cx)), PBI.x, py, PBI.w, PBI.h)
          .child(h_flex().gap(6).items_center()
            .child(this.itemPill(p, t))
            .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(meta)))
          .child(div().text_size(12.5).font_semibold().child(short(p.title, 80)))
          .child(div().text_size(11).text_color(t.muted).child(short(p.failed || first, 95))));
      }
      nodes.push(at(div().id(`tree-add-${f.key}`).flex().items_center().justify_center().rounded(8).border_1().border_color(t.border)
        .text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.addPbi(fi, cx)), PBI.x, addY, 110, ADD - 8).child("+ PBI"));
    });
    nodes.push(at(div().id("tree-add-feature").flex().items_center().justify_center().rounded(9).border_1().border_color(t.border)
      .text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => this.addFeature(cx)), FEAT.x, addFeatureY, 140, 34).child("+ Feature"));

    const canvas = div().relative().flex_none().w(width).h(height)
      .children(lines.map((l) => window.paint_path(l.path, l.c).absolute().left(0).top(0).w(width).h(height)))
      .children(nodes);
    return div().flex_1().min_h(0).relative().mt(8)
      .child(div().id("plan-tree").absolute().inset_0().overflow_scroll().child(canvas))
      .child(Scrollbar.vertical("plan-tree").absolute().inset_0());
  }

  renderBoard(t) {
    const plan = this.plan;
    const all = items(plan);
    const todo = all.filter((x) => !x.item.createdId && !x.item.existingId);
    const nf = todo.filter((x) => x.kind === "feature").length, np = todo.length - nf;
    const drafting = plan.status === "drafting";
    const actions = drafting || this.busy ? [] : [
      this.button("plan-back", "All plans", t, (_e, cx) => { this.screen = "list"; this.error = ""; cx.notify(); }),
      this.button("plan-redraft", "Redraft", t, (_e, cx) => this.draft(cx)),
      todo.length ? this.button("plan-create", `Create ${todo.length} items in DevOps`, t, (_e, cx) => { this.confirm = true; cx.notify(); }, "primary") : null,
    ].filter(Boolean);
    const status = drafting ? "Claude is drafting… (this can take a minute or two)"
      : this.busy || (plan.status === "error" ? plan.error : `${plan.features.length} features · ${all.length - plan.features.length} PBIs · ${plan.status}`);

    const root = v_flex().size_full().min_h(0)
      .child(this.header(t, plan.name, status, actions))
      .when(this.hasError(), (el) => el.child(this.errorLine(t, (cx) => (plan.features.length ? this.create(cx) : this.draft(cx)))));
    const withConfirm = root.when(this.confirm, (el) => el.child(h_flex().flex_none().mx(20).mt(12).p(12).gap(10).items_center().rounded(9).border_1().border_color(t.accent).bg(t.selected)
        .child(div().flex_1().text_size(12.5).child(`Create ${nf} Feature(s) and ${np} PBI(s) in ${orgName(plan.org)} / ${plan.project}? Existing Features are only linked.`))
        .child(this.button("plan-confirm-no", "Cancel", t, (_e, cx) => { this.confirm = false; cx.notify(); }))
        .child(this.button("plan-confirm-yes", "Create", t, (_e, cx) => this.create(cx), "primary"))));
    if (drafting || (!plan.features.length && plan.status === "error")) {
      return withConfirm.child(v_flex().flex_1().p(20).gap(8)
        .child(div().text_size(12).text_color(t.dim).child("Input text:"))
        .child(div().text_size(12).text_color(t.muted).child(short(plan.input, 1200))));
    }
    const view = this.viewMode();
    const toggle = h_flex().flex_none().mx(20).mt(12).gap(4).items_center()
      .child(div().text_size(11).text_color(t.dim).mr(4).child("View"))
      .children([["tree", "Tree"], ["columns", "Columns"]].map(([key, label]) => {
        const on = view === key;
        return div().id(`view-${key}`).h(24).px(10).flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
          .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.raised).text_color(on ? t.accent : t.muted)
          .on_click((_e, cx) => { try { localStorage.setItem("planner.view", key); } catch { /* no storage */ } this.view = key; cx.notify(); })
          .child(label);
      }))
      .child(div().flex_1())
      .child(this.legend(t));
    if (view === "tree") return withConfirm.child(toggle).child(this.tree(plan, t));
    return withConfirm.child(toggle).child(div().flex_1().min_h(0).p(20)
      .child(h_flex().id("plan-board").size_full().gap(14).items_start().overflow_x_scrollbar()
        .children(plan.features.map((f, fi) => this.column(f, fi, t)))
        .child(div().id("plan-add-feature").w(160).h(44).flex_none().flex().items_center().justify_center().rounded(10)
          .border_1().border_color(t.border).text_size(12.5).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.addFeature(cx)).child("+ Feature"))));
  }

  renderItem(t) {
    const { fi, pi } = this.edit;
    const f = this.plan.features[fi];
    const it = pi === null ? f : f.pbis[pi];
    const isPbi = pi !== null;
    const locked = Boolean(it.createdId || it.existingId);
    const url = it.createdId || it.existingId ? itemUrl(this.plan, it.createdId || it.existingId) : "";
    const body = v_flex().id("plan-item-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(16).gap(8)
      .when(locked, (el) => el.child(div().text_size(12).text_color(t.ansi4)
        .child("This item exists in Azure DevOps. Changes here stay in the plan; edit it in DevOps.")))
      .when(Boolean(it.failed), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(it.failed)))
      .child(this.label("Title", t)).child(this.input(this.f.title, t))
      .child(this.label("Description", t)).child(this.textarea(this.f.description, t));
    if (isPbi) {
      body
        .child(this.label("Acceptance criteria (one per line)", t)).child(this.textarea(this.f.ac, t))
        .child(h_flex().gap(16)
          .child(v_flex().gap(6).child(this.label("Effort", t)).child(this.input(this.f.effort, t, 120)))
          .child(v_flex().flex_1().gap(6).child(this.label("Tags (comma separated)", t)).child(this.input(this.f.tags, t))))
        .child(this.label("Feature", t))
        .child(h_flex().flex_wrap().gap(6).children(this.plan.features.map((x, i) => {
          const on = this.edit.parent === i;
          return div().id(`parent-${x.key}`).h(26).px(10).flex().items_center().rounded(7).text_size(11.5).cursor_pointer()
            .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.raised)
            .text_color(on ? t.accent : t.foreground)
            .on_click((_e, cx) => { this.edit.parent = i; cx.notify(); }).child(short(x.title, 50));
        })));
    }
    return v_flex().size_full().min_h(0)
      .child(h_flex().h(52).flex_none().px(20).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(10.5).font_semibold().text_color(t.accent).child(isPbi ? "PBI" : "FEATURE"))
        .child(this.itemPill(it, t))
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(it.title))
        .when(Boolean(url), (el) => el.child(this.button("item-open", "Open in DevOps", t, (_e, cx) => cx.open_url(url))))
        .when(!locked, (el) => el.child(this.button("item-delete", isPbi ? "Delete PBI" : `Delete Feature and ${f.pbis.length} PBIs`, t, (_e, cx) => this.deleteItem(cx), "danger")))
        .child(this.button("item-back", "Back", t, (_e, cx) => this.backToBoard(cx)))
        .child(this.button("item-save", "Save", t, (_e, cx) => this.saveItem(cx), "primary")))
      .child(body);
  }

  render(cx) {
    const t = theme();
    const root = v_flex().id("planner").size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13);
    if (!this.ready) return root.child(div().p(20).text_color(t.dim).child("Loading…"));
    if (!this.link) {
      return root.child(this.header(t, "PBI plans", this.spaceName, []))
        .child(div().p(20).text_color(t.muted).child("This space has no Azure DevOps project yet. Open the PBIs panel in the tab bar and link a project first."));
    }
    if (this.screen === "new") return root.child(this.renderNew(t));
    if (this.screen === "board" && this.plan) return root.child(this.renderBoard(t));
    if (this.screen === "item" && this.edit) return root.child(this.renderItem(t));
    return root.child(this.renderList(t));
  }
}
