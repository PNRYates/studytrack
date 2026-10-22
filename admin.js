/* =========================================================================
   STUDY TRACK — ADMIN CONSOLE
   -------------------------------------------------------------------------
   Moderation for the crew: read everything, correct or remove anything,
   and leave a record of having done it.

   WHERE THE SECURITY ACTUALLY IS
   ------------------------------
   Not in this file. Everything here runs in the browser, so treat every
   check below as cosmetic — anyone determined enough can call openAdmin()
   from the console and watch it paint. What stops them is schema.sql:

     * public.is_admin() reads auth.users, which the browser cannot forge.
     * The update/delete policies on every table allow a write only when
       the row is yours OR is_admin() is true.
     * admin_delete_user() re-checks is_admin() inside the function.

   So a non-admin who forces this panel open gets a working-looking screen
   whose every button quietly changes nothing. That is the intended
   failure mode. The gate here exists to keep the door out of sight, not
   to hold it shut.

   Reads are a different matter and worth being honest about: every signed
   in member can already read the whole database — that is what the crew
   view is. The console shows nothing that was ever private.
   ========================================================================= */

let IS_ADMIN = false;
const ADM = {
  open:false,
  tab:"overview",
  chat:null,                  /* the moderation queue, loaded with the console */
  q:"",                       /* session search */
  who:"",                     /* session owner filter */
  from:"", to:"",             /* session date filter */
  sel:new Set(),              /* bulk selection of session ids */
  audit:[],
  auditLoaded:false,
  annDraft:"",             /* the announcement being composed, kept across repaints */
  annLabel:"",             /* the badge it will wear; empty means the plain "Admin" */
  mq:"", mf:"all",         /* members search and filter */
  editReal:null            /* the member whose real name is being edited */
};

/* Ask the database, not the browser, whether this person is an admin.
   A failure here — the function missing because schema.sql has not been
   re-run — is not an error worth showing anyone: it just means no console. */
async function adminBoot() {
  IS_ADMIN = false;
  try {
    const { data, error } = await sb.rpc("is_admin");
    if (!error && data === true) IS_ADMIN = true;
  } catch (e) { /* older project, no function, no console */ }
  const row = $("s-adminrow");
  if (row) row.hidden = !IS_ADMIN;
  if (IS_ADMIN) admPendingStart();
  return IS_ADMIN;
}

/* ========================================================= NEW ACCOUNTS
   Anyone can join and use the site; chat waits for an admin (vetting.sql,
   chat_approval.sql). Every account out of chat is in VET, with what
   signup_log saw when it was made. One an admin has not looked at yet pops
   up here, on whatever page they are on: let them chat, keep them out of
   chat (the popup stops), or ban them (the account goes and the address is
   refused from then on). "Later" puts one aside for 15 minutes. The same
   list is the console's Awaiting vetting tab. Checked on boot and every
   minute while the tab is in view. */
const PEND = { list:[], snooze:{}, timer:null, busy:false, armed:null, loaded:false };
function admPendingStart() {
  if (PEND.timer) return;
  admPendingCheck();
  PEND.timer = setInterval(() => { if (!document.hidden) admPendingCheck(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && IS_ADMIN) admPendingCheck(); });
}
async function admPendingCheck() {
  if (!IS_ADMIN || PEND.busy) return;
  try {
    const { data, error } = await sb.rpc("admin_vetting");
    if (error || !Array.isArray(data)) return;   /* vetting.sql not run yet */
    PEND.list = data; PEND.loaded = true;
  } catch (e) { return; }
  admPendingPaint();
  if (ADM.open && ADM.tab === "vetting") renderAdmin();
}
const admVetRow = id => PEND.list.find(x => x.id === id) || null;
function admPendingNext() {
  const now = Date.now();
  return PEND.list.filter(a => !a.reviewed_at && !(PEND.snooze[a.id] > now));
}
function admUA(ua) {
  ua = String(ua || "");
  if (!ua) return "—";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Mac OS X|Macintosh/.test(ua) ? "Mac"
    : /Linux/.test(ua) ? "Linux" : "Unknown system";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Unknown browser";
  return br + " on " + os;
}
function admWhen(t) {
  if (!t) return "—";
  const d = new Date(t);
  return d.toLocaleString(undefined, { weekday:"short", day:"numeric", month:"short", hour:"numeric", minute:"2-digit" });
}
/* "Lewis CHRISTIE · Reid" with how sure the match is */
function admRealName(n) {
  if (!n || !n.real_name) return "";
  const how = { confirmed: "", likely: " (likely)", guess: " (guess)", none: "" }[n.name_match] || "";
  return n.real_name + how;
}
function admPendingPaint() {
  const ov0 = $("ov-pending");
  const queue = admPendingNext();
  if (!queue.length) { if (ov0) ov0.classList.remove("on"); return; }
  let ov = ov0;
  if (!ov) {
    ov = document.createElement("div");
    ov.className = "ov"; ov.id = "ov-pending";
    document.body.appendChild(ov);
    ov.addEventListener("click", e => {
      const b = e.target.closest("[data-pend]");
      if (b) admPendingAct(b.dataset.pend, b.dataset.id);
    });
  }
  const a = queue[0], d = a.device || {};
  const row = (k, v) => v === undefined || v === null || v === "" ? "" :
    `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`;
  const same = Array.isArray(a.same_ip) ? a.same_ip : [];
  ov.innerHTML = `<div class="modal pendsheet" role="dialog" aria-modal="true" aria-labelledby="pend-title">
    <header>
      <div><h2 id="pend-title">New account</h2>
        <div class="sub">${queue.length > 1 ? `1 of ${queue.length} new · ` : ""}They can use the site now. Chat stays closed until an admin lets them in.</div></div>
      <button class="x" data-pend="later" data-id="${esc(a.id)}" aria-label="Decide later" style="font-size:22px">&times;</button>
    </header>
    <div class="body">
      <div class="pendwho"><strong>${esc(a.name || a.signup_name || "(no name)")}</strong><span>${esc(a.email || "")}</span></div>
      ${same.length ? `<div class="msg err">Same IP address as: ${esc(same.join(", "))}</div>` : ""}
      ${a.note ? `<div class="msg">${esc(a.note)}</div>` : ""}
      <table class="pendtab">
        ${row("Real name", admRealName(a) || "not matched to the Year 12 list")}
        ${row("Signed up", admWhen(a.created_at))}
        ${row("Email confirmed", admWhen(a.confirmed_at))}
        ${row("Sign-up attempts", a.tries)}
        ${row("IP address", a.ip || "not recorded")}
        ${row("Country", a.country)}
        ${row("Browser", admUA(a.user_agent))}
        ${row("Device", [d.platform, d.mobile === true ? "phone/tablet" : d.mobile === false ? "computer" : ""].filter(Boolean).join(", "))}
        ${row("Screen", d.screen)}
        ${row("Time zone", d.tz)}
        ${row("Languages", Array.isArray(d.langs) ? d.langs.join(", ") : (a.language || ""))}
        ${row("Full browser string", a.user_agent)}
      </table>
      <div class="pendgo">
        <button type="button" class="btn ghost" data-pend="later" data-id="${esc(a.id)}">Later</button>
        <button type="button" class="btn ghost penddeny" data-pend="ban" data-id="${esc(a.id)}">${PEND.armed === a.id ? "Tap again to ban" : "Ban"}</button>
        <button type="button" class="btn ghost" data-pend="wait" data-id="${esc(a.id)}">Keep out of chat</button>
        <button type="button" class="btn pendok" data-pend="approve" data-id="${esc(a.id)}">Let them chat</button>
      </div>
    </div>
  </div>`;
  ov.classList.add("on");
}
/* approve / wait / ban, from the popup or the Awaiting vetting tab. Ban
   deletes the login, so it takes two taps (no browser confirm box). */
async function admVet(what, id, where) {
  const a = admVetRow(id) || {};
  const name = a.name || (profileOf(id) || {}).display_name || "That account";
  if (what === "ban" && PEND.armed !== id) {
    PEND.armed = id;
    if (where === "tab") { renderAdmin(); toast("Tap Ban again to delete " + name + " and block their email"); }
    else admPendingPaint();
    return false;
  }
  if (PEND.busy) return false;
  PEND.busy = true; PEND.armed = null;
  try {
    const { data, error } = await sb.rpc("admin_vet", { target: id, decision: what });
    if (error) { toast("Could not do that: " + error.message, 5200); return false; }
    if (data === "gone") toast("Someone else already dealt with " + name);
    else toast(data === "approved" ? name + " can chat now"
             : data === "waiting" ? name + " stays out of chat (still in Vetting)"
             : name + " banned: account deleted, email blocked", 3600);
    if (what === "wait") { if (a) a.reviewed_at = new Date().toISOString(); }
    else PEND.list = PEND.list.filter(x => x.id !== id);
    if (what === "approve") { const p = DB.profiles.find(x => x.id === id); if (p) p.chat_approved = true; }
    if (what === "ban") DB.profiles = DB.profiles.filter(x => x.id !== id);
    return true;
  } finally {
    PEND.busy = false;
    admPendingPaint();
    if (ADM.open) renderAdmin();
    if (what !== "wait" && typeof loadAll === "function") { try { await loadAll(); renderAll(); } catch (e) {} }
  }
}
async function admPendingAct(what, id) {
  if (what === "later") {
    PEND.snooze[id] = Date.now() + 15 * 60000; PEND.armed = null;
    admPendingPaint(); return;
  }
  document.querySelectorAll("#ov-pending [data-pend]").forEach(b => b.disabled = PEND.armed === id || what !== "ban");
  await admVet(what, id, "popup");
}

/* ---------------------------------------------------------------- helpers */
const admPct = (n, d) => d > 0 ? Math.round(n / d * 100) : 0;
const admShort = s => s ? String(s).slice(0, 8) : "—";
function admAvatar(p) {
  const c = (p && p.colour) || "#68738B";
  if (p && p.avatar_url) return `<span class="adm-av"><img src="${esc(p.avatar_url)}" alt=""></span>`;
  return `<span class="adm-av" style="background:${esc(c)}">${esc(initials(p && p.display_name))}</span>`;
}
/* Emails live in auth.users, which the app itself cannot read. admin_emails()
   hands back the address and nothing else, and only to an administrator —
   anybody else calling it gets an empty set. Loaded with the console rather
   than with the app, so an ordinary session never carries them at all. */
let ADM_EMAIL = {};
async function admLoadEmails() {
  const { data, error } = await sb.rpc("admin_emails");
  if (error) return;
  ADM_EMAIL = {};
  (data || []).forEach(r => { ADM_EMAIL[r.id] = r.email; });
}
const admEmail = id => ADM_EMAIL[id] || "";

/* Notes on members that only administrators can read or write (admin_notes,
   chat_approval.sql). Shown beside an account in Awaiting vetting so whoever
   is approving sees why it was flagged, and who last said so. */
let ADM_NOTES = {};
async function admLoadNotes() {
  const { data, error } = await sb.from("admin_notes").select("user_id,note,updated_by,updated_at,reviewed_at,real_name,roster_code,name_match");
  if (error) return;
  ADM_NOTES = {};
  (data || []).forEach(r => { ADM_NOTES[r.user_id] = r; });
}
async function admSaveNote(uid, text) {
  const note = String(text || "").trim().slice(0, 1000);
  const was = ADM_NOTES[uid];
  if ((was ? was.note : "") === note) return;
  const row = { user_id: uid, note, updated_by: UID, updated_at: new Date().toISOString() };
  const { error } = await sb.from("admin_notes").upsert(row, { onConflict: "user_id" });
  if (error) { toast("Could not save the note — " + error.message, 4600); return; }
  ADM_NOTES[uid] = Object.assign({}, was || {}, row);
  toast("Note saved");
  renderAdmin();
}
function admNoteMeta(uid) {
  const n = ADM_NOTES[uid];
  if (!n || !n.updated_at) return "";
  const who = n.updated_by === UID ? "you" : ((profileOf(n.updated_by) || {}).display_name || "an admin");
  return `Last edited by ${esc(who)}, ${esc(new Date(n.updated_at).toLocaleString("en-AU",
    { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}`;
}

function admWho(id, noReal, you) {
  const p = profileOf(id);
  const mail = admEmail(id);
  const real = noReal ? "" : admRealName(ADM_NOTES[id]);
  return `<span class="adm-who">${admAvatar(p)}<span class="nm">${esc(p.display_name)}${
    you ? `<span class="adm-flag mute adm-you">You</span>` : ""}${
    real ? `<span class="adm-real">${esc(real)}</span>` : ""}${
    mail ? `<span class="adm-mail">${esc(mail)}</span>` : ""}</span></span>`;
}
const admSessions = uid => admAll().filter(s => s.user_id === uid);
const admHours = list => list.reduce((a, s) => a + s.minutes / 60, 0);
function admLastActive(uid) {
  const days = admSessions(uid).map(s => s.day).sort();
  return days.length ? days[days.length - 1] : null;
}
function admJoined(p) { return p.created_at ? String(p.created_at).slice(0, 10) : null; }

/* ------------------------------------------------------------- audit trail
   Written before the change, so a row exists even if the write then fails.
   The table has no update or delete policy: an admin can remove a member's
   session but cannot remove the record of having removed it. RLS with no
   policy for a command matches no rows, so an attempt to tamper does not
   error — it simply changes nothing. */
async function admLog(action, targetUser, targetName, summary, snapshot) {
  try {
    await sb.from("admin_audit").insert({
      actor_id: UID,
      actor_name: (ME && ME.display_name) || null,
      action, target_user: targetUser || null, target_name: targetName || null,
      summary: summary || null, snapshot: snapshot || null
    });
    ADM.auditLoaded = false;
  } catch (e) { /* never let logging block the moderation itself */ }
}
async function admLoadAudit() {
  try {
    const { data, error } = await sb.from("admin_audit")
      .select("*").order("created_at", { ascending: false }).limit(300);
    if (!error) { ADM.audit = data || []; ADM.auditLoaded = true; }
  } catch (e) { ADM.audit = []; }
}

/* ============================================================== INTEGRITY
   The point of the console. Every rule below is a *signal*, never a verdict
   — a long session on a Saturday before trials is completely normal, and the
   console says so rather than accusing anyone. Nothing is auto-removed. */
const ADM_RULES = {
  marathon:  { level:"warn",     icon:"◷", label:"Long session",
               why:"One unbroken block of 5 hours or more." },
  impossible:{ level:"critical", icon:"▲", label:"Impossible day",
               why:"More than 16 hours logged across a single day." },
  future:    { level:"critical", icon:"▲", label:"Future date",
               why:"Dated after today — usually a typo, occasionally not." },
  prejoin:   { level:"serious",  icon:"◆", label:"Before joining",
               why:"Dated before this member's account existed." },
  duplicate: { level:"serious",  icon:"❐", label:"Exact duplicate",
               why:"Same member, day, subject, length and description as another entry." },
  stale:     { level:"warn",     icon:"◷", label:"Timer left running",
               why:"A live timer has been going for more than 8 hours." }
};

function admFlags() {
  const out = [];
  const today = todayISO();
  const byDay = {};       /* uid|day -> minutes */
  const seen  = {};       /* uid|day|subject|area|minutes|note -> first id */

  admAll().forEach(s => {
    const p = profileOf(s.user_id);
    const push = (rule, detail) => out.push({ rule, detail, session:s, user_id:s.user_id });

    if (s.minutes >= 300) push("marathon", f1(s.minutes / 60) + " hours in one block");
    if (s.day > today)   push("future", "dated " + fmtD(s.day));

    const joined = admJoined(p);
    if (joined && s.day < joined) push("prejoin", "dated " + fmtD(s.day) + ", joined " + fmtD(joined));

    const dk = s.user_id + "|" + s.day;
    byDay[dk] = (byDay[dk] || 0) + s.minutes;

    /* The description has to match too, or two honest two-hour blocks of the
       same subject on one day — a morning and an evening — get called copies.
       Compared after trimming, and a blank note matches only a blank note. */
    const sk = JSON.stringify([s.user_id, s.day, s.subject_id || "-", s.area_id || "-", s.minutes,
                               (s.note || "").trim()]);
    if (seen[sk]) push("duplicate", "matches another entry on " + fmtD(s.day));
    else seen[sk] = s.id;
  });

  Object.keys(byDay).forEach(k => {
    if (byDay[k] <= 960) return;
    const [uid, day] = k.split("|");
    const worst = admAll()
      .filter(s => s.user_id === uid && s.day === day)
      .sort((a, b) => b.minutes - a.minutes)[0];
    if (worst) out.push({ rule:"impossible", user_id:uid, session:worst,
      detail:f1(byDay[k] / 60) + " hours total on " + fmtD(day) });
  });

  (DB.timers || []).forEach(t => {
    const ms = (t.acc_ms || 0) + (t.running ? Date.now() - new Date(t.started_at).getTime() : 0);
    if (ms > 8 * 3600e3) out.push({ rule:"stale", user_id:t.user_id, timer:t,
      detail:"running " + f1(ms / 3600e3) + " hours" });
  });

  const order = { critical:0, serious:1, warn:2 };
  return out.sort((a, b) =>
    order[ADM_RULES[a.rule].level] - order[ADM_RULES[b.rule].level] ||
    ((b.session && b.session.day) || "").localeCompare((a.session && a.session.day) || ""));
}
function admFlagPill(rule) {
  const r = ADM_RULES[rule];
  const cls = r.level === "warn" ? "warn" : r.level;
  return `<span class="adm-flag ${cls}" title="${esc(r.why)}"><i class="fi">${r.icon}</i>${esc(r.label)}</span>`;
}

/* ================================================================== SHELL */
/* The console is the one place that genuinely needs everybody's sessions: it
   exists to find and fix other people's rows. The app itself stopped carrying
   them — four hundred people's sessions in every browser is what this release
   is about — so the console fetches them when it opens, and works from its own
   copy. Every reference below goes through admAll() rather than the app's.  */
const admAll = () => DB.allSessions || [];
async function admLoadSessions() {
  const { data, error } = await sb.from("sessions")
    .select("*, subjects(name, colour), areas(name)")
    .order("day", { ascending: false });
  if (error) { toast("Could not load sessions — " + error.message, 4600); return; }
  DB.allSessions = (data || []).map(r => Object.assign({}, r, {
    subject_name:   r.subjects ? r.subjects.name   : null,
    subject_colour: r.subjects ? r.subjects.colour : null,
    area_name:      r.areas    ? r.areas.name      : null,
    subjects: undefined, areas: undefined
  }));
}

async function openAdmin() {
  if (!IS_ADMIN) { toast("The console is for administrators"); return; }
  ADM.open = true;
  $("adm").hidden = false;
  document.body.style.overflow = "hidden";
  renderAdmin();                      /* frame first, so it does not sit blank */
  await Promise.all([admLoadSessions(), admLoadChat(), admLoadEmails(), admLoadNotes(), admPendingCheck()]);
  if (ADM.open) renderAdmin();
}
function closeAdmin() {
  ADM.open = false;
  $("adm").hidden = true;
  document.body.style.overflow = "";
}
function admGo(tab) { ADM.tab = tab; ADM.sel.clear(); renderAdmin(); }

/* every write goes through here so the panel and the app agree afterwards */
async function admAfterWrite() {
  await refresh();
  if (typeof openProfileId !== "undefined" && openProfileId &&
      $("ov-profile").classList.contains("on")) openProfile(openProfileId);
  if (ADM.open) renderAdmin();
}

const ADM_TABS = [
  ["overview",  "◎", "Overview"],
  ["vetting",   "✓", "Vetting"],
  ["members",   "☗", "Members"],
  ["sessions",  "▤", "Sessions"],
  ["chat",      "✽", "Chat"],
  ["integrity", "⚑", "Flags"],
  ["audit",     "⎘", "Audit log"]
];

/* ---------------------------------------------------------------------------
   CHAT MODERATION

   Four hundred people in one room needs a way to take something down quickly
   and a way to stop whoever keeps putting it up. Both are here: delete one or
   many, and mute a member so send_message() turns them away. Removals go to
   the audit log like every other removal in this console.

   Loads the last two hundred, which is a moderation queue rather than an
   archive — the room's own history is paged in the app.
   --------------------------------------------------------------------------- */
const ADM_CHAT_PAGE = 200;
async function admLoadChat() {
  const { data, error } = await sb.from("messages").select("*")
    .order("created_at", { ascending: false }).limit(ADM_CHAT_PAGE);
  if (error) { toast("Could not load chat — " + error.message, 4600); return; }
  ADM.chat = data || [];
}

function admChatView() {
  const rows = (ADM.chat || []).filter(m => {
    if (ADM.who && m.user_id !== ADM.who) return false;
    if (!ADM.q) return true;
    const p = profileOf(m.user_id);
    const hay = (m.body + " " + (p.display_name || "")).toLowerCase();
    return hay.indexOf(ADM.q.toLowerCase()) > -1;
  });
  const selCount = ADM.sel.size;
  const muted = DB.profiles.filter(p => p.chat_muted);

  return `<div class="adm-card"><header>
      <div><h3>Messages</h3><div class="sub">The last ${ADM_CHAT_PAGE}, newest first. Deleting cannot be undone.</div></div>
      <div class="adm-bar" style="margin-left:auto">
        <input id="adm-q" class="adm-in" placeholder="Search messages or names" value="${esc(ADM.q)}">
        <select id="adm-who" class="adm-in">
          <option value="">Everyone</option>
          ${DB.profiles.map(p => `<option value="${esc(p.id)}"${ADM.who === p.id ? " selected" : ""}>${esc(p.display_name)}</option>`).join("")}
        </select>
        <button class="adm-btn" id="adm-clear">Clear</button>
      </div>
    </header>

    ${muted.length ? `<div class="adm-bar pad">Muted: ${muted.map(p =>
      `<button class="adm-btn sm" data-admunmute="${esc(p.id)}" title="Let them post again">${esc(p.display_name)} ✕</button>`).join(" ")}</div>` : ""}

    ${selCount ? `<div class="adm-bar pad">
      <strong>${selCount}</strong> selected
      <button class="adm-btn danger" id="adm-chatdelsel">Delete selected</button>
      <button class="adm-btn" id="adm-chatclearsel">Clear selection</button>
    </div>` : ""}

    <div class="adm-scroll"><table class="adm-t"><thead><tr>
      <th class="l" style="width:34px"><input type="checkbox" class="adm-ck" id="adm-selall"
        ${selCount && selCount === rows.length ? "checked" : ""}></th>
      <th class="l">When</th><th class="l">Member</th><th class="l">Message</th><th></th>
    </tr></thead>
    <tbody>${rows.length ? rows.map(m => `<tr class="${ADM.sel.has(m.id) ? "sel" : ""}">
      <td class="l"><input type="checkbox" class="adm-ck" data-admsel="${esc(m.id)}"
        ${ADM.sel.has(m.id) ? "checked" : ""}></td>
      <td class="l adm-mono">${esc(new Date(m.created_at).toLocaleString())}</td>
      <td class="l">${admWho(m.user_id)}</td>
      <td class="l"><div class="adm-note" title="${esc(m.body)}">${
        m.image_path ? `<span class="adm-flag mute"><i class="fi">▤</i>picture</span> ` : ""}${
        esc(m.body) || `<span style="color:var(--a-ink-soft)">no text</span>`}</div></td>
      <td><div class="adm-act">
        <button class="adm-btn sm" data-admmute="${esc(m.user_id)}">${
          (profileOf(m.user_id) || {}).chat_muted ? "Unmute" : "Mute"}</button>
        <button class="adm-btn sm danger" data-admchatdel="${esc(m.id)}">Delete</button>
      </div></td>
    </tr>`).join("") : `<tr><td colspan="5"><div class="adm-empty">Nothing to moderate.</div></td></tr>`}
    </tbody></table></div></div>`;
}

async function admDeleteMessages(ids) {
  const rows = (ADM.chat || []).filter(m => ids.includes(m.id));
  const { error } = await sb.from("messages").delete().in("id", ids);
  if (error) { toast("Could not delete — " + error.message, 4600); return; }
  /* Take the picture with it. The bucket is private and the links are signed
     and short-lived, but a file nobody deleted is still a file sitting there —
     removing the message has to mean removing the thing it showed. */
  const files = rows.map(m => m.image_path).filter(Boolean);
  if (files.length) {
    const { error: fe } = await sb.storage.from("chat").remove(files);
    if (fe) toast("Message removed, but its picture could not be: " + fe.message, 5200);
  }
  for (const m of rows) {
    await admLog("chat.delete", m.user_id, profileOf(m.user_id).display_name,
      m.body.slice(0, 120), m);
  }
  ADM.chat = (ADM.chat || []).filter(m => !ids.includes(m.id));
  ADM.sel.clear();
  renderAdmin();
  toast(ids.length === 1 ? "Message deleted" : ids.length + " messages deleted");
}

/* ---------------------------------------------------------------------------
   ANNOUNCEMENTS

   The one place in this console that writes to the room rather than tidying
   it, so it is the one place that asks twice before acting.

   The rule people will actually care about — that a member cannot announce —
   is not enforced here. It is enforced by is_admin() inside
   send_announcement(), the same way every other privileged thing in this file
   is. What this screen is for is the other half: an announcement has to be a
   deliberate act. The ordinary chat box cannot produce one at all, because it
   calls send_message(), which has no way to set the flag. So an admin saying
   something in the room says it as themselves, and only a trip in here puts
   the badge on it.
   --------------------------------------------------------------------------- */
const ANN_MAX = 1000;
const ANN_LABEL_MAX = 24;
const admAnnouncements = () => (ADM.chat || []).filter(m => m.announcement);

/* The slab exactly as the room will get it, built by the room's own annHTML so
   the preview cannot drift from the thing it is previewing. The delete control
   is stripped because there is nothing yet to delete. */
function admAnnPreview() {
  const txt = (ADM.annDraft || "").trim();
  if (!txt) return `<div class="adm-empty">Nothing to preview yet.</div>`;
  return annHTML({
    id: "preview", user_id: UID, body: txt,
    mentions: mentionsInText(txt), announcement: true,
    ann_label: (ADM.annLabel || "").trim() || null,
    created_at: new Date().toISOString()
  }).replace(/<button class="ann-del"[\s\S]*?<\/button>/, "");
}

function admAnnounceView() {
  const past = admAnnouncements();
  const draft = ADM.annDraft || "";
  const left = ANN_MAX - draft.length;

  return `
  <div class="adm-h"><div>
    <h2>Chat</h2>
    <p>Post an announcement, then moderate the room below.</p>
  </div></div>

  <div class="adm-anngrid">
    <div class="adm-card"><div class="pad">
      <label class="adm-lbl" for="adm-annlabel">Badge &mdash; what this one is called</label>
      <input id="adm-annlabel" class="adm-in adm-annlabelin" maxlength="${ANN_LABEL_MAX}"
        placeholder="Admin" value="${esc(ADM.annLabel || "")}">
      <div class="adm-sub" style="margin-top:6px">Left empty it reads <b>Admin</b>.</div>

      <label class="adm-lbl" style="margin-top:18px" for="adm-anntext">What the year group will read</label>
      <div class="adm-annwrap">
        <textarea id="adm-anntext" class="adm-in adm-annbox" maxlength="${ANN_MAX}"
          placeholder="e.g. Trials feedback is up on Canvas. Log the reading you do for it.">${esc(draft)}</textarea>
        <div class="mentionbox" id="adm-mentionbox" hidden role="listbox" aria-label="Mention somebody"></div>
      </div>
      <div class="adm-annfoot">
        <span class="adm-annleft${left < 80 ? " near" : ""}" id="adm-annleft">${left} left</span>
        <button class="adm-btn primary" id="adm-annsend"${draft.trim() ? "" : " disabled"}>Post announcement</button>
      </div>
      <div class="adm-sub">Type <b>@</b> to tag somebody. ${"\u2318"}/Ctrl + Enter posts it.</div>
    </div></div>

    <div class="adm-card"><div class="pad">
      <label class="adm-lbl">How it lands in chat</label>
      <div class="adm-annprev" id="adm-annprev">${admAnnPreview()}</div>
    </div></div>
  </div>

  <div class="adm-h" style="margin-top:22px"><div>
    <h2>Posted</h2>
    <p>${past.length ? `Every announcement in the last ${ADM_CHAT_PAGE} messages of the room.`
                     : `Nothing announced in the last ${ADM_CHAT_PAGE} messages.`}</p>
  </div></div>

  ${past.length ? `<div class="adm-card"><div class="adm-scroll"><table class="adm-t">
    <thead><tr><th class="l">When</th><th class="l">Badge</th><th class="l">By</th>
      <th class="l">Announcement</th><th></th></tr></thead>
    <tbody>${past.map(m => `<tr>
      <td class="l adm-mono">${esc(new Date(m.created_at).toLocaleString())}</td>
      <td class="l"><span class="adm-flag warn">${esc(annLabel(m))}</span></td>
      <td class="l">${admWho(m.user_id)}</td>
      <td class="l"><div class="adm-note" title="${esc(m.body)}">${esc(m.body)}</div></td>
      <td><div class="adm-act">
        <button class="adm-btn sm danger" data-admchatdel="${esc(m.id)}">Delete</button>
      </div></td></tr>`).join("")}</tbody></table></div></div>` : ""}`;
}

async function admSendAnnouncement() {
  const box = $("adm-anntext"), lblBox = $("adm-annlabel");
  const txt = ((box && box.value) || "").trim();
  const lbl = ((lblBox && lblBox.value) || "").trim();
  if (!txt) return;

  /* Only the people whose name is still in the box actually go on it, the same
     rule the room's composer uses — deleting "@Sam" takes Sam off the notice. */
  const said = mentionsInText(txt);
  const names = said.map(id => profileOf(id).display_name).filter(Boolean);

  if (!confirm(`Post this to the whole year group, badged "${lbl || "Admin"}"?\n\n` +
    `"${txt}"\n\n` +
    (names.length ? `Tagged: ${names.join(", ")} \u2014 they each get a mention.\n\n` : "") +
    `It appears in chat straight away. It carries no name, so nothing on it says it was you.`)) return;

  const btn = $("adm-annsend");
  if (btn) { btn.disabled = true; btn.textContent = "Posting\u2026"; }

  const { data, error } = await sb.rpc("send_announcement",
    { body: txt, label: lbl || null, mentions: said });
  if (btn) { btn.disabled = false; btn.textContent = "Post announcement"; }
  if (error) {
    /* The one failure that is not about this announcement at all. PostgREST
       answers rpc() from a cached picture of the schema, so a database that
       has never had migrate.sql run on it — or has had it run and not
       been told — reports the function as missing, in words that read like a
       bug in the app. Say what it actually is and what fixes it. */
    const missing = /schema cache|could not find the function|does not exist/i.test(error.message || "");
    toast(missing
      ? "The database has not been set up for announcements yet \u2014 run migrate.sql in the Supabase SQL editor, then try again."
      : "Could not post \u2014 " + error.message, 7000);
    return;
  }
  if (data && !data.ok)  { toast(data.why || "Could not post", 4600); return; }

  /* An announcement is an admin action taken in public, so it is recorded like
     every other one — the audit log is the only place it survives the message
     itself being deleted, and the only place the room's anonymity does not
     apply, which is the point of having one. */
  await admLog("chat.announce", null, null,
    `[${lbl || "Admin"}] ${txt.slice(0, 180)}` + (names.length ? ` \u2014 tagged ${names.join(", ")}` : ""),
    null);

  ADM.annDraft = "";
  ADM.annLabel = "";
  mentionDraft = [];
  await admLoadChat();                 /* so it shows in the list below at once */
  renderAdmin();
  toast("Announcement posted");
}

async function admSetMuted(uid, on) {
  const { error } = await sb.from("profiles").update({ chat_muted: on }).eq("id", uid);
  if (error) { toast("Could not change that — " + error.message, 4600); return; }
  await admLog(on ? "chat.mute" : "chat.unmute", uid, profileOf(uid).display_name,
    on ? "muted in chat" : "unmuted in chat", null);
  const p = DB.profiles.find(x => x.id === uid);
  if (p) p.chat_muted = on;
  renderAdmin();
  toast(on ? "Muted" : "Unmuted");
}

/* Everyone out of chat: the popup's list, or the profiles while it loads. */
const admPending = () => PEND.loaded ? PEND.list
  : DB.profiles.filter(p => p.chat_approved === false).map(p => ({ id: p.id, name: p.display_name, created_at: p.created_at }));

/* Members tab "Approve" goes the same way as the popup. */
async function admSetApproved(uid, on) {
  if (on) { await admVet("approve", uid, "tab"); return; }
  const { error } = await sb.from("profiles").update({ chat_approved: false }).eq("id", uid);
  if (error) { toast("Could not change that — " + error.message, 4600); return; }
  const p = DB.profiles.find(x => x.id === uid);
  await admLog("chat.unapprove", uid, p ? p.display_name : null, "sent back to awaiting vetting", { email: admEmail(uid) || null });
  if (p) p.chat_approved = false;
  admPendingCheck();
  toast("Back to awaiting vetting");
}

function admVetting() {
  const rows = admPending();
  return `
  <div class="adm-h"><div>
    <h2>Vetting</h2>
    <p>Accounts that can use the site but not chat. Let them chat, or ban a fake (account deleted,
       email blocked for good). Notes save when you click away.</p>
  </div></div>
  ${rows.length ? `<div class="adm-card"><div class="adm-scroll"><table class="adm-t adm-stack">
    <thead><tr><th class="l">Account</th><th class="l">Real name</th><th class="l">Signed up</th><th>Hours</th>
      <th class="l" style="min-width:240px">Note (admins only)</th><th></th></tr></thead>
    <tbody>${rows.map(a => {
      const n = ADM_NOTES[a.id] || a;
      const same = Array.isArray(a.same_ip) ? a.same_ip : [];
      const where = [a.country, a.user_agent ? admUA(a.user_agent) : "", a.ip].filter(Boolean).join(" · ");
      return `<tr>
        <td class="l">${profileOf(a.id) && profileOf(a.id).id ? admWho(a.id) : `<span class="adm-who"><span class="nm">${esc(a.name || "")}<span class="adm-mail">${esc(a.email || "")}</span></span></span>`}
          ${a.reviewed_at ? "" : `<span class="adm-flag warn" style="margin-top:4px">New</span>`}</td>
        <td class="l">${esc(admRealName(n) || "—")}</td>
        <td class="l"><span class="adm-mono">${esc(admWhen(a.created_at))}</span>
          ${where ? `<div class="adm-note-meta">${esc(where)}</div>` : ""}
          ${same.length ? `<div class="adm-note-meta" style="color:var(--a-critical)">Same IP as ${esc(same.join(", "))}</div>` : ""}</td>
        <td>${f1(admHours(admSessions(a.id)))}</td>
        <td class="l"><textarea class="adm-in adm-note-in" rows="3" maxlength="1000" data-admnote="${esc(a.id)}"
            placeholder="Why it's here, for the other admins">${esc((ADM_NOTES[a.id] || {}).note || a.note || "")}</textarea>
          <div class="adm-note-meta">${admNoteMeta(a.id)}</div></td>
        <td><div class="adm-act">
          <button class="adm-btn sm go" data-admvet="approve" data-id="${esc(a.id)}">Let them chat</button>
          <button class="adm-btn sm" data-admprofile="${esc(a.id)}">View</button>
          <button class="adm-btn sm danger" data-admvet="ban" data-id="${esc(a.id)}">${PEND.armed === a.id ? "Tap again to ban" : "Ban"}</button>
        </div></td>
      </tr>`;
    }).join("")}</tbody></table></div></div>`
  : `<div class="adm-card"><div class="pad" style="color:var(--a-ink-soft)">Nobody waiting. New accounts will show up here and pop up for you.</div></div>`}`;
}

function renderAdmin() {
  if (!ADM.open) return;
  const flags = admFlags();

  $("adm-rail").innerHTML =
    `<div class="adm-navlabel">Console</div>` +
    ADM_TABS.map(([id, ic, label]) => {
      const n = id === "members" ? DB.profiles.length
              : id === "vetting" ? (admPending().length || "")
              : id === "sessions" ? admAll().length
              : id === "chat" ? ((ADM.chat && ADM.chat.length) || "")
              : id === "integrity" ? flags.length
              : id === "audit" ? (ADM.audit.length || "") : "";
      return `<button class="adm-nav" data-admtab="${id}" aria-current="${ADM.tab === id}">
        <span class="ic">${ic}</span>${esc(label)}
        ${n !== "" ? `<span class="ct">${n}</span>` : ""}</button>`;
    }).join("") +
    `<div class="adm-railfoot">Signed in as <strong style="color:var(--a-ink)">${esc((ME && ME.display_name) || "admin")}</strong>.
      Everything you do here goes in the audit log.</div>`;

  $("adm-live").innerHTML =
    `<span class="adm-dot"></span><span class="adm-livetext">PRIVILEGED SESSION</span>` +
    (flags.length ? `<span class="adm-livetext"> · </span>
       <span style="color:var(--a-critical)" title="${flags.length} flagged entries">${flags.length} flagged</span>` : ``);

  const body = $("adm-body");
  if (ADM.tab === "overview")  body.innerHTML = admOverview(flags);
  if (ADM.tab === "vetting")   body.innerHTML = admVetting();
  if (ADM.tab === "members")   body.innerHTML = admMembers();
  if (ADM.tab === "sessions")  body.innerHTML = admSessionsView();
  if (ADM.tab === "chat")      body.innerHTML = admAnnounceView() + admChatView();
  if (ADM.tab === "announce")  { ADM.tab = "chat"; body.innerHTML = admAnnounceView() + admChatView(); }
  if (ADM.tab === "integrity") body.innerHTML = admIntegrity(flags);
  if (ADM.tab === "audit")     body.innerHTML = admAudit();

  admWire();
}

/* =============================================================== OVERVIEW */
/* The few things an admin should act on, each with the button that does it. */
function admNeedsYou(flags) {
  const fresh = PEND.list.filter(a => !a.reviewed_at).length;
  const waiting = admPending().length;
  const unlinked = DB.profiles.filter(p => admLink(p.id).tag === "Not linked" && p.chat_approved !== false).length;
  const unsure = DB.profiles.filter(p => ["Guess", "Likely"].includes(admLink(p.id).tag)).length;
  const crit = flags.filter(f => ADM_RULES[f.rule].level === "critical").length;
  const items = [
    fresh ? [`<b>${fresh}</b> new account${fresh === 1 ? "" : "s"} to look at`, "vetting", "Vet"] : null,
    !fresh && waiting ? [`<b>${waiting}</b> account${waiting === 1 ? "" : "s"} kept out of chat`, "vetting", "Open"] : null,
    unlinked ? [`<b>${unlinked}</b> can chat but ${unlinked === 1 ? "is" : "are"} not linked to a real name`, "members:unlinked", "Link"] : null,
    unsure ? [`<b>${unsure}</b> real-name match${unsure === 1 ? "" : "es"} still a guess`, "members:unsure", "Check"] : null,
    flags.length ? [`<b>${flags.length}</b> flagged session${flags.length === 1 ? "" : "s"}${crit ? `, ${crit} critical` : ""}`, "integrity", "Review"] : null
  ].filter(Boolean);
  return `<div class="adm-card"><header><div><h3>Needs you</h3></div></header>
    <div class="adm-needs">${items.length ? items.map(([t, go, b]) => `<div class="adm-need"><span>${t}</span>
      <button class="adm-btn sm primary" data-admgo="${go}">${b}</button></div>`).join("")
      : `<div class="adm-need"><span>All clear. Nothing waiting on an admin.</span></div>`}</div></div>`;
}

function admOverview(flags) {
  const today = todayISO();
  const totalH = admHours(admAll());
  const todayH = admAll().filter(s => s.day === today).reduce((a, s) => a + s.minutes / 60, 0);
  const wk = []; for (let i = 13; i >= 0; i--) wk.push(addDays(today, -i));
  const perDay = wk.map(d => admAll().filter(s => s.day === d).reduce((a, s) => a + s.minutes / 60, 0));
  const live = (DB.timers || []).filter(t => t.running).length;
  const crit = flags.filter(f => ADM_RULES[f.rule].level === "critical").length;
  const notOnboarded = DB.profiles.filter(p => !p.onboarded).length;

  return `
  <div class="adm-h"><div>
    <h2>Overview</h2>
    <p>What needs you, then how the year group is going.</p>
  </div></div>

  ${admNeedsYou(flags)}

  <div class="adm-tiles">
    <div class="adm-tile"><div class="v">${DB.profiles.length}</div><div class="k">Members</div>
      <div class="d">${notOnboarded ? notOnboarded + " mid-setup" : "all set up"}</div></div>
    <div class="adm-tile"><div class="v">${admAll().length}</div><div class="k">Sessions logged</div>
      <div class="d">${f1(totalH)} hours all up</div></div>
    <div class="adm-tile"><div class="v">${f1(todayH)}</div><div class="k">Hours logged today</div>
      <div class="d">${admAll().filter(s => s.day === today).length} sessions</div></div>
    <div class="adm-tile"><div class="v">${live}</div><div class="k">Timers running now</div>
      <div class="d">${live ? "live on the peloton strip" : "nobody studying"}</div></div>
    <div class="adm-tile ${crit ? "alert" : ""}"><div class="v">${flags.length}</div><div class="k">Flagged entries</div>
      <div class="d">${crit ? crit + " critical" : "nothing critical"}</div></div>
  </div>

  <div class="adm-card">
    <header><div><h3>Peloton output, last 14 days</h3>
      <div class="sub">Total hours logged per day by everyone</div></div></header>
    <div class="pad adm-scroll">${admBars(wk, perDay)}</div>
  </div>

  <div class="adm-card">
    <header><div><h3>Most recent activity</h3>
      <div class="sub">The last ten sessions logged by anyone</div></div>
      <button class="adm-btn sm" data-admtab="sessions" style="margin-left:auto">See all sessions</button></header>
    <div class="adm-scroll"><table class="adm-t">
      <thead><tr><th class="l">Member</th><th class="l">Worked on</th><th class="l">Day</th>
        <th>Hours</th><th class="l">Note</th></tr></thead>
      <tbody>${admAll().slice()
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
        .slice(0, 10).map(s => `<tr>
          <td class="l">${admWho(s.user_id)}</td>
          <td class="l">${esc(labelOf(s))}</td>
          <td class="l adm-mono">${esc(s.day)}</td>
          <td>${f1(s.minutes / 60)}</td>
          <td class="l"><div class="adm-note">${esc(s.note || "—")}</div></td>
        </tr>`).join("") || `<tr><td colspan="5" class="l" style="color:var(--a-ink-soft)">Nothing logged yet.</td></tr>`}
      </tbody></table></div>
  </div>`;
}

/* A single series of magnitude over time: one hue, bars, no legend needed —
   the heading names the series. Values are labelled on hover rather than
   printed on every bar. */
function admBars(days, vals) {
  const W = 760, H = 190, ml = 34, mr = 8, mt = 12, mb = 26;
  const iw = W - ml - mr, ih = H - mt - mb;
  const max = Math.max(1, ...vals);
  const slot = iw / days.length;
  /* Thin marks: the bar never grows past 22px however wide the card gets, and
     it keeps a 2px gap from its neighbour on either side. */
  const bw = Math.min(22, slot - 6);
  const ticks = 3;
  let g = "";
  for (let i = 0; i <= ticks; i++) {
    const v = max * i / ticks, y = mt + ih - (v / max) * ih;
    g += `<line class="grid" x1="${ml}" x2="${ml + iw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>
          <text class="axis" x="${ml - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${f0(v)}</text>`;
  }
  const bars = days.map((d, i) => {
    const v = vals[i];
    const h = Math.max(v > 0 ? 2 : 0, (v / max) * ih);
    const x = ml + i * slot + (slot - bw) / 2, y = mt + ih - h;
    /* 4px rounded end, anchored to the baseline; hover names the day and value */
    return `<g class="adm-bararea"><rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
      width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4"
      fill="var(--a-data)"><title>${esc(fmtD(d))} — ${f1(v)} hours</title></rect></g>`;
  }).join("");
  const labels = days.map((d, i) =>
    (i % 3 === 0 || i === days.length - 1)
      ? `<text class="axis" x="${(ml + i * slot + slot / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(d.slice(8))}/${esc(d.slice(5,7))}</text>`
      : "").join("");
  return `<svg class="adm-chart" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Total peloton hours per day over the last 14 days">${g}${bars}${labels}</svg>`;
}

/* ================================================================ MEMBERS */
/* Who an account belongs to: linked to the Year 12 list or not (vetting.sql). */
function admLink(id) {
  const n = ADM_NOTES[id] || {};
  if (!n.real_name) return { cls: "critical", tag: "Not linked", name: "", how: "" };
  if (n.name_match === "none") return { cls: "critical", tag: "Not linked", name: n.real_name, how: "" };
  if (n.name_match === "guess") return { cls: "warn", tag: "Guess", name: n.real_name, how: "guess" };
  if (n.name_match === "likely") return { cls: "warn", tag: "Likely", name: n.real_name, how: "likely" };
  return { cls: "good", tag: "Linked", name: n.real_name, how: "" };
}
function admChatState(p) {
  if (p.chat_muted) return { cls: "critical", tag: "Muted" };
  if (p.chat_approved === false) return { cls: "warn", tag: "Out of chat" };
  return { cls: "good", tag: "Can chat" };
}
/* Inline real-name editor on Members. The roster list fills the suggestions. */
let ADM_ROSTER = null;
async function admLoadRoster() {
  if (ADM_ROSTER) return;
  const { data, error } = await sb.from("school_roster").select("code,preferred,surname,house").order("surname");
  if (!error) ADM_ROSTER = data || [];
}
function admRealEditor(id) {
  const n = ADM_NOTES[id] || {};
  const opts = (ADM_ROSTER || []).map(r => `<option value="${esc(r.preferred + " " + r.surname + " · " + r.house)}">`).join("");
  return `<div class="adm-realedit">
    <input class="adm-in" id="adm-realname" list="adm-rosterlist" placeholder="Start typing a name" value="${esc(n.real_name || "")}">
    <datalist id="adm-rosterlist">${opts}</datalist>
    <select class="adm-sel" id="adm-realhow">
      ${[["confirmed", "Linked (sure)"], ["likely", "Likely"], ["guess", "Guess"], ["none", "Not a student / unknown"]]
        .map(([v, t]) => `<option value="${v}"${(n.name_match || "confirmed") === v ? " selected" : ""}>${t}</option>`).join("")}
    </select>
    <div class="adm-act" style="justify-content:flex-start">
      <button class="adm-btn sm go" data-admrealsave="${esc(id)}">Save</button>
      <button class="adm-btn sm" data-admrealcancel="1">Cancel</button>
    </div></div>`;
}
async function admSaveReal(id) {
  const name = ($("adm-realname").value || "").trim().slice(0, 200);
  const how = $("adm-realhow").value;
  const r = (ADM_ROSTER || []).find(x => (x.preferred + " " + x.surname + " · " + x.house) === name);
  const row = { user_id: id, real_name: name || null, name_match: name ? how : null,
                roster_code: r ? r.code : null, updated_by: UID, updated_at: new Date().toISOString() };
  const { error } = await sb.from("admin_notes").upsert(row, { onConflict: "user_id" });
  if (error) { toast("Could not save — " + error.message, 4600); return; }
  ADM_NOTES[id] = Object.assign({}, ADM_NOTES[id] || {}, row);
  await admLog("member.realname", id, (profileOf(id) || {}).display_name, name ? `real name set: ${name} (${how})` : "real name cleared", null);
  ADM.editReal = null;
  renderAdmin();
  toast("Real name saved");
}

function admMembers() {
  const q = (ADM.mq || "").trim().toLowerCase();
  const f = ADM.mf || "all";
  const all = DB.profiles.slice().sort((a, b) => admHours(admSessions(b.id)) - admHours(admSessions(a.id)));
  const counts = {
    all: all.length,
    unlinked: all.filter(p => admLink(p.id).tag === "Not linked").length,
    unsure: all.filter(p => ["Guess", "Likely"].includes(admLink(p.id).tag)).length,
    out: all.filter(p => p.chat_approved === false || p.chat_muted).length
  };
  const rows = all.filter(p => {
    const L = admLink(p.id);
    if (f === "unlinked" && L.tag !== "Not linked") return false;
    if (f === "unsure" && !["Guess", "Likely"].includes(L.tag)) return false;
    if (f === "out" && !(p.chat_approved === false || p.chat_muted)) return false;
    if (!q) return true;
    return (p.display_name + " " + admEmail(p.id) + " " + L.name).toLowerCase().includes(q);
  });
  const chip = (id, label) => `<button class="adm-btn sm${f === id ? " primary" : ""}" data-admmf="${id}">${label} <span class="adm-ct">${counts[id]}</span></button>`;

  return `
  <div class="adm-h"><div>
    <h2>Members</h2>
    <p>Everyone with an account and who they really are. Real names are from the Year 12 house list
       and only admins see them.</p>
  </div></div>

  <div class="adm-bar">
    ${chip("all", "Everyone")} ${chip("unlinked", "Not linked")} ${chip("unsure", "Unsure match")} ${chip("out", "Out of chat")}
    <input class="adm-in adm-grow" id="adm-mq" type="search" placeholder="Search name, email or real name" value="${esc(ADM.mq || "")}">
  </div>

  <div class="adm-card"><div class="adm-scroll"><table class="adm-t adm-members adm-stack">
    <thead><tr>
      <th class="l">Account</th><th class="l">Real name</th><th class="l">Chat</th>
      <th>Hours</th><th class="l">Last active</th><th></th>
    </tr></thead>
    <tbody>${rows.map(p => {
      const ss = admSessions(p.id);
      const last = admLastActive(p.id);
      const L = admLink(p.id), C = admChatState(p);
      const timer = DB.timers.some(t => t.user_id === p.id);
      const me = p.id === UID;
      return `<tr>
        <td class="l">${admWho(p.id, true, me)}</td>
        <td class="l">${ADM.editReal === p.id ? admRealEditor(p.id) : `
          <button class="adm-realbtn" data-admreal="${esc(p.id)}" title="Edit real name">
            <span class="adm-flag ${L.cls}">${L.tag}</span>
            <span class="adm-realcell">${L.name ? esc(L.name) : "Add real name"}</span></button>`}</td>
        <td class="l"><span class="adm-flag ${C.cls}">${C.tag}</span></td>
        <td style="font-weight:650">${f1(admHours(ss))}</td>
        <td class="l adm-mono">${last ? esc(last) : "never"}</td>
        <td><div class="adm-act">
          ${me ? "" : p.chat_approved === false
            ? `<button class="adm-btn sm go" data-admapprove="${esc(p.id)}">Let them chat</button>`
            : `<button class="adm-btn sm" data-admtovet="${esc(p.id)}">Send to vetting</button>`}
          <button class="adm-btn sm" data-admprofile="${esc(p.id)}">View</button>
          <details class="adm-more"><summary class="adm-btn sm">More</summary><div class="adm-menu">
            <button class="adm-btn sm" data-admedituser="${esc(p.id)}">Edit profile</button>
            ${timer ? `<button class="adm-btn sm danger" data-admtimer="${esc(p.id)}">Stop timer</button>` : ""}
            <button class="adm-btn sm danger" data-admwipe="${esc(p.id)}" ${ss.length ? "" : "disabled"}>Clear sessions</button>
            <button class="adm-btn sm danger" data-admkill="${esc(p.id)}" ${me ? "disabled" : ""}>Delete account</button>
          </div></details>
        </div></td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" class="l" style="color:var(--a-ink-soft)">Nobody matches.</td></tr>`}</tbody></table></div></div>

  <p class="adm-sub" style="margin-top:10px">Deleting an account is final: it removes the login and everything they own.
    Clearing sessions keeps the account. To ban someone and block their email, send them to Vetting and use Ban there.</p>`;
}

/* ================================================================ SESSIONS */
function admFilteredSessions() {
  const q = ADM.q.toLowerCase();
  return admAll().filter(s => {
    if (ADM.who && s.user_id !== ADM.who) return false;
    if (ADM.from && s.day < ADM.from) return false;
    if (ADM.to && s.day > ADM.to) return false;
    if (!q) return true;
    return (labelOf(s) + " " + (s.note || "") + " " + profileOf(s.user_id).display_name)
      .toLowerCase().includes(q);
  }).sort((a, b) => b.day.localeCompare(a.day) ||
      String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

function admSessionsView() {
  const rows = admFilteredSessions();
  const shown = rows.slice(0, 400);
  const selCount = ADM.sel.size;

  return `
  <div class="adm-h"><div>
    <h2>Sessions</h2>
    <p>Every session anyone has logged.</p>
  </div></div>

  <div class="adm-card"><div class="pad">
    <div class="adm-bar">
      <input class="adm-in adm-grow" id="adm-q" type="text" placeholder="Search notes, subjects, members…"
        value="${esc(ADM.q)}">
      <select class="adm-sel" id="adm-who">
        <option value="">Everyone</option>
        ${DB.profiles.map(p => `<option value="${esc(p.id)}"${ADM.who === p.id ? " selected" : ""}>${esc(p.display_name)}</option>`).join("")}
      </select>
      <input class="adm-in" id="adm-from" type="date" value="${esc(ADM.from)}" title="From this date">
      <input class="adm-in" id="adm-to" type="date" value="${esc(ADM.to)}" title="Up to this date">
      <button class="adm-btn" id="adm-clear">Reset</button>
    </div>
    <div class="adm-sub">${rows.length} session${rows.length === 1 ? "" : "s"} ·
      ${f1(admHours(rows))} hours${rows.length > shown.length
        ? ` · showing the newest ${shown.length}, narrow the filters to see the rest` : ""}</div>
  </div></div>

  ${selCount ? `<div class="adm-selbar">
    <strong>${selCount} selected</strong>
    <span style="color:var(--a-ink-mid)">${f1(admHours(rows.filter(s => ADM.sel.has(s.id))))} hours</span>
    <button class="adm-btn sm" id="adm-selnone" style="margin-left:auto">Clear selection</button>
    <button class="adm-btn sm danger" id="adm-selkill">Delete ${selCount} session${selCount === 1 ? "" : "s"}</button>
  </div>` : ""}

  <div class="adm-card"><div class="adm-scroll"><table class="adm-t">
    <thead><tr>
      <th class="l" style="width:34px"><input type="checkbox" class="adm-ck" id="adm-selall"
        ${selCount && selCount === shown.length ? "checked" : ""}></th>
      <th class="l">Day</th><th class="l">Member</th><th class="l">Worked on</th>
      <th>Hours</th><th class="l">Note</th><th></th>
    </tr></thead>
    <tbody>${shown.length ? shown.map(s => `<tr class="${ADM.sel.has(s.id) ? "sel" : ""}">
      <td class="l"><input type="checkbox" class="adm-ck" data-admsel="${esc(s.id)}"
        ${ADM.sel.has(s.id) ? "checked" : ""}></td>
      <td class="l adm-mono">${esc(s.day)}</td>
      <td class="l">${admWho(s.user_id)}</td>
      <td class="l"><span style="color:${colourOf(s)};font-weight:650">${esc(labelOf(s))}</span></td>
      <td>${f1(s.minutes / 60)}</td>
      <td class="l"><div class="adm-note" title="${esc(s.note || "")}">${esc(s.note || "—")}</div></td>
      <td><div class="adm-act">
        <button class="adm-btn sm" data-admedit="${esc(s.id)}">Edit</button>
        <button class="adm-btn sm danger" data-admdel="${esc(s.id)}">Delete</button>
      </div></td>
    </tr>`).join("") : `<tr><td colspan="7"><div class="adm-empty">Nothing matches those filters.</div></td></tr>`}
    </tbody></table></div></div>`;
}

/* =============================================================== INTEGRITY */
function admIntegrity(flags) {
  const counts = {};
  flags.forEach(f => counts[f.rule] = (counts[f.rule] || 0) + 1);

  return `
  <div class="adm-h"><div>
    <h2>Flags</h2>
    <p>Sessions that look off. A signal, not a verdict: nothing here has been changed.</p>
  </div></div>

  ${flags.length ? "" : `<div class="adm-empty" style="padding:44px">
    <div style="font-size:26px;margin-bottom:10px;color:var(--a-good)">●</div>
    Nothing looks wrong. Every session sits inside every rule below.</div>`}

  ${flags.length ? `<div class="adm-tiles">${Object.keys(ADM_RULES).map(r => {
    const n = counts[r] || 0;
    return `<div class="adm-tile ${n && ADM_RULES[r].level === "critical" ? "alert" : ""}">
      <div class="v">${n}</div><div class="k">${esc(ADM_RULES[r].label)}</div>
      <div class="d">${esc(ADM_RULES[r].why)}</div></div>`;
  }).join("")}</div>` : ""}

  ${flags.length ? `<div class="adm-card"><div class="adm-scroll"><table class="adm-t">
    <thead><tr><th class="l">Flag</th><th class="l">Member</th><th class="l">Entry</th>
      <th class="l">Why it is flagged</th><th></th></tr></thead>
    <tbody>${flags.map(f => `<tr>
      <td class="l">${admFlagPill(f.rule)}</td>
      <td class="l">${admWho(f.user_id)}</td>
      <td class="l">${f.session
        ? `<span class="adm-mono">${esc(f.session.day)}</span> · ${esc(labelOf(f.session))} ·
           ${f1(f.session.minutes / 60)} h`
        : `<span style="color:var(--a-ink-mid)">${esc((f.timer && f.timer.label) || "live timer")}</span>`}</td>
      <td class="l" style="color:var(--a-ink-mid)">${esc(f.detail)}</td>
      <td><div class="adm-act">
        ${f.session ? `<button class="adm-btn sm" data-admedit="${esc(f.session.id)}">Edit</button>
          <button class="adm-btn sm danger" data-admdel="${esc(f.session.id)}">Delete</button>`
        : `<button class="adm-btn sm danger" data-admtimer="${esc(f.user_id)}">Stop timer</button>`}
      </div></td>
    </tr>`).join("")}</tbody></table></div></div>` : ""}

  <div class="adm-card">
    <header><div><h3>What each rule looks for</h3>
      <div class="sub">Thresholds live in ADM_RULES and admFlags() in admin.js</div></div></header>
    <div class="pad" style="font-size:12.5px;color:var(--a-ink-mid);line-height:1.75">
      ${Object.keys(ADM_RULES).map(r =>
        `<div style="margin-bottom:7px">${admFlagPill(r)} &nbsp;${esc(ADM_RULES[r].why)}</div>`).join("")}
    </div>
  </div>`;
}

/* =================================================================== AUDIT */
function admAudit() {
  if (!ADM.auditLoaded) {
    admLoadAudit().then(() => { if (ADM.open && ADM.tab === "audit") renderAdmin(); });
    return `<div class="adm-h"><div><h2>Audit log</h2></div></div>
            <div class="adm-empty">Loading…</div>`;
  }
  return `
  <div class="adm-h"><div>
    <h2>Audit log</h2>
    <p>Everything any admin has done here. Nobody can edit or delete it.</p>
  </div></div>

  ${ADM.audit.length ? `<div class="adm-card"><div class="adm-scroll"><table class="adm-t">
    <thead><tr><th class="l">When</th><th class="l">Admin</th><th class="l">Action</th>
      <th class="l">Affected</th><th class="l">Detail</th></tr></thead>
    <tbody>${ADM.audit.map(a => `<tr>
      <td class="l adm-mono">${esc(String(a.created_at || "").slice(0, 16).replace("T", " "))}</td>
      <td class="l">${esc(a.actor_name || admShort(a.actor_id))}</td>
      <td class="l">${(d => `<span class="adm-flag ${d ? "critical" : "mute"}">
        <i class="fi">${d ? "▲" : "✎"}</i>${esc(a.action)}</span>`)(/delete|wipe|clear/.test(a.action))}</td>
      <td class="l">${esc(a.target_name || admShort(a.target_user))}</td>
      <td class="l" style="color:var(--a-ink-mid)"><div class="adm-note"
        title="${esc(a.snapshot ? JSON.stringify(a.snapshot) : "")}">${esc(a.summary || "—")}</div></td>
    </tr>`).join("")}</tbody></table></div></div>`
  : `<div class="adm-empty">Nothing has been done from the console yet.</div>`}`;
}

/* ================================================================= ACTIONS */
function admWire() {
  const $$ = sel => Array.from($("adm").querySelectorAll(sel));

  $$("[data-admtab]").forEach(b => b.onclick = () => admGo(b.dataset.admtab));
  $$("[data-admprofile]").forEach(b => b.onclick = () => {
    closeAdmin(); openProfile(b.dataset.admprofile);
  });

  /* ---- session edit / delete ---- */
  $$("[data-admedit]").forEach(b => b.onclick = () => openEdit(b.dataset.admedit));
  $$("[data-admdel]").forEach(b => b.onclick = () => admDeleteSession(b.dataset.admdel));

  /* ---- filters ---- */
  const q = $("adm-q");
  if (q) q.oninput = () => {
    ADM.q = q.value; ADM.sel.clear();
    const at = q.selectionStart; renderAdmin();
    const n = $("adm-q"); if (n) { n.focus(); n.setSelectionRange(at, at); }
  };
  const who = $("adm-who");  if (who)  who.onchange  = () => { ADM.who = who.value; ADM.sel.clear(); renderAdmin(); };
  const fr  = $("adm-from"); if (fr)   fr.onchange   = () => { ADM.from = fr.value; renderAdmin(); };
  const to  = $("adm-to");   if (to)   to.onchange   = () => { ADM.to = to.value; renderAdmin(); };
  const cl  = $("adm-clear");if (cl)   cl.onclick    = () => {
    ADM.q = ADM.who = ADM.from = ADM.to = ""; ADM.sel.clear(); renderAdmin();
  };

  /* ---- bulk selection ---- */
  $$("[data-admsel]").forEach(b => b.onchange = () => {
    b.checked ? ADM.sel.add(b.dataset.admsel) : ADM.sel.delete(b.dataset.admsel);
    renderAdmin();
  });
  const all = $("adm-selall");
  if (all) all.onchange = () => {
    ADM.sel.clear();
    if (all.checked) {
      /* the same checkbox serves both tables, so it selects whichever is showing */
      const rows = ADM.tab === "chat" ? (ADM.chat || []) : admFilteredSessions();
      rows.slice(0, 400).forEach(r => ADM.sel.add(r.id));
    }
    renderAdmin();
  };

  /* ---- chat moderation ---- */
  $$("[data-admchatdel]").forEach(b => b.onclick = () => admDeleteMessages([b.dataset.admchatdel]));
  $$("[data-admmute]").forEach(b => b.onclick = () => {
    const uid = b.dataset.admmute;
    admSetMuted(uid, !(profileOf(uid) || {}).chat_muted);
  });
  $$("[data-admunmute]").forEach(b => b.onclick = () => admSetMuted(b.dataset.admunmute, false));
  $$("[data-admapprove]").forEach(b => b.onclick = () => admSetApproved(b.dataset.admapprove, true));
  $$("[data-admvet]").forEach(b => b.onclick = () => admVet(b.dataset.admvet, b.dataset.id, "tab"));
  $$("[data-admtovet]").forEach(b => b.onclick = () => admSetApproved(b.dataset.admtovet, false));
  $$("[data-admreal]").forEach(b => b.onclick = async () => { ADM.editReal = b.dataset.admreal; await admLoadRoster(); renderAdmin();
    const i = $("adm-realname"); if (i) i.focus(); });
  $$("[data-admrealsave]").forEach(b => b.onclick = () => admSaveReal(b.dataset.admrealsave));
  $$("[data-admrealcancel]").forEach(b => b.onclick = () => { ADM.editReal = null; renderAdmin(); });
  const rn = $("adm-realname");
  if (rn) rn.onkeydown = e => { if (e.key === "Enter") admSaveReal(ADM.editReal); if (e.key === "Escape") { ADM.editReal = null; renderAdmin(); } };
  $$("[data-admgo]").forEach(b => b.onclick = () => {
    const [tab, filter] = b.dataset.admgo.split(":");
    if (filter) ADM.mf = filter;
    admGo(tab);
  });
  $$("[data-admmf]").forEach(b => b.onclick = () => { ADM.mf = b.dataset.admmf; renderAdmin(); });
  const mq = $("adm-mq");
  if (mq) mq.oninput = () => {
    const at = mq.selectionStart; ADM.mq = mq.value; renderAdmin();
    const n = $("adm-mq"); if (n) { n.focus(); n.setSelectionRange(at, at); }
  };
  $$("[data-admnote]").forEach(t => t.onblur = () => admSaveNote(t.dataset.admnote, t.value));
  const cdel = $("adm-chatdelsel");
  if (cdel) cdel.onclick = () => {
    const ids = [...ADM.sel];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} message${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    admDeleteMessages(ids);
  };
  const cclr = $("adm-chatclearsel");
  if (cclr) cclr.onclick = () => { ADM.sel.clear(); renderAdmin(); };
  const none = $("adm-selnone"); if (none) none.onclick = () => { ADM.sel.clear(); renderAdmin(); };
  const kill = $("adm-selkill"); if (kill) kill.onclick = () => admDeleteSelected();

  /* ---- announcements ---- */
  const ann = $("adm-anntext"), annLbl = $("adm-annlabel");
  if (ann) {
    /* Repainting the whole console on every keystroke would rebuild the mention
       list out from under the caret, so the three things that actually change
       are updated in place instead: the counter, the send button and the
       preview. Nothing else on this screen depends on the draft. */
    const annPaint = () => {
      ADM.annDraft = ann.value;
      ADM.annLabel = annLbl ? annLbl.value : "";
      const left = ANN_MAX - ann.value.length;
      const l = $("adm-annleft");
      if (l) { l.textContent = left + " left"; l.classList.toggle("near", left < 80); }
      const go = $("adm-annsend"); if (go) go.disabled = !ann.value.trim();
      const pv = $("adm-annprev"); if (pv) pv.innerHTML = admAnnPreview();
    };
    /* The room's composer and this one share the one mention list, so each
       claims it before use rather than trusting whatever touched it last. */
    const claim = () => useMentions("adm-anntext", "adm-mentionbox", annPaint, true);

    ann.onfocus = claim;
    ann.oninput = () => { claim(); annPaint(); refreshMentionBox(); };
    ann.onblur  = () => { mentionOpen = false; paintMentionBox(); };
    ann.onkeydown = e => {
      claim();
      /* while the mention list is up it owns the arrows, tab and enter */
      if (mentionOpen && mentionMatches.length) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          mentionIdx = (mentionIdx + (e.key === "ArrowDown" ? 1 : -1) + mentionMatches.length) % mentionMatches.length;
          paintMentionBox();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault(); insertMention(mentionMatches[mentionIdx].id); return;
        }
        if (e.key === "Escape") { e.preventDefault(); mentionOpen = false; paintMentionBox(); return; }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); admSendAnnouncement(); }
    };
    if (annLbl) annLbl.oninput = annPaint;
  }
  const annGo = $("adm-annsend");
  if (annGo) annGo.onclick = () => admSendAnnouncement();

  /* ---- member actions ---- */
  $$("[data-admedituser]").forEach(b => b.onclick = () => admEditMember(b.dataset.admedituser));
  $$("[data-admwipe]").forEach(b => b.onclick = () => admWipeSessions(b.dataset.admwipe));
  $$("[data-admkill]").forEach(b => b.onclick = () => admDeleteMember(b.dataset.admkill));
  $$("[data-admtimer]").forEach(b => b.onclick = () => admStopTimer(b.dataset.admtimer));
}

async function admDeleteSession(id) {
  const s = admAll().find(x => x.id === id);
  if (!s) return;
  const p = profileOf(s.user_id);
  if (!confirm(`Delete ${p.display_name}'s ${f1(s.minutes / 60)} hour session on ${fmtLong(s.day)}?\n\n` +
    `"${s.note || "no note"}"\n\nThis cannot be undone. It will be recorded in the audit log.`)) return;

  await admLog("session.delete", s.user_id, p.display_name,
    `${f1(s.minutes / 60)} h on ${s.day} — ${labelOf(s)}`, s);
  const { error } = await sb.from("sessions").delete().eq("id", id);
  if (error) { toast("Could not delete: " + error.message); return; }
  ADM.sel.delete(id);
  toast("Session deleted");
  await admAfterWrite();
}

async function admDeleteSelected() {
  const ids = Array.from(ADM.sel);
  if (!ids.length) return;
  const rows = admAll().filter(s => ids.includes(s.id));
  const people = Array.from(new Set(rows.map(s => profileOf(s.user_id).display_name)));
  if (!confirm(`Delete ${ids.length} sessions (${f1(admHours(rows))} hours) belonging to ` +
    `${people.join(", ")}?\n\nThis cannot be undone.`)) return;

  await admLog("session.bulk_delete", rows.length === 1 ? rows[0].user_id : null,
    people.join(", "), `${ids.length} sessions, ${f1(admHours(rows))} hours`, { ids, rows });
  const { error } = await sb.from("sessions").delete().in("id", ids);
  if (error) { toast("Could not delete: " + error.message); return; }
  ADM.sel.clear();
  toast(`${ids.length} sessions deleted`);
  await admAfterWrite();
}

async function admWipeSessions(uid) {
  const p = profileOf(uid);
  const ss = admSessions(uid);
  if (!ss.length) return;
  if (!confirm(`Delete all ${ss.length} of ${p.display_name}'s sessions (${f1(admHours(ss))} hours)?\n\n` +
    `Their account, subjects, areas and goals stay. This cannot be undone.`)) return;

  await admLog("member.clear_sessions", uid, p.display_name,
    `${ss.length} sessions, ${f1(admHours(ss))} hours`, { count: ss.length });
  const { error } = await sb.from("sessions").delete().eq("user_id", uid);
  if (error) { toast("Could not clear: " + error.message); return; }
  toast(`Cleared ${p.display_name}'s sessions`);
  await admAfterWrite();
}

async function admDeleteMember(uid) {
  const p = profileOf(uid);
  if (uid === UID) { toast("Remove your own account from Setup instead"); return; }
  const ss = admSessions(uid);
  const typed = prompt(
    `This deletes ${p.display_name}'s login and everything they own — ` +
    `${ss.length} sessions, ${f1(admHours(ss))} hours, their subjects, areas and goals.\n\n` +
    `There is no undo.\n\nType their display name exactly to confirm:`);
  if (typed === null) return;
  if (typed.trim() !== p.display_name) { toast("Name did not match — nothing deleted"); return; }

  await admLog("member.delete", uid, p.display_name,
    `account removed with ${ss.length} sessions (${f1(admHours(ss))} h)`,
    { profile: p, sessions: ss.length });

  const { error } = await sb.rpc("admin_delete_user", { target: uid });
  if (error) {
    /* The RPC is missing on projects that have not re-run schema.sql. Falling
       back to clearing their rows is better than doing nothing, but it leaves
       the login alive — say so rather than claiming success. */
    await sb.from("sessions").delete().eq("user_id", uid);
    await sb.from("subjects").delete().eq("user_id", uid);
    await sb.from("goals").delete().eq("user_id", uid);
    await sb.from("profiles").delete().eq("id", uid);
    toast("Data cleared, but the login remains — re-run schema.sql for admin_delete_user()", 5200);
    await admAfterWrite();
    return;
  }
  toast(`${p.display_name} removed`);
  await admAfterWrite();
}

async function admStopTimer(uid) {
  const p = profileOf(uid);
  if (!confirm(`Clear ${p.display_name}'s running timer? It drops them off the live strip. ` +
    `Nothing they have logged is touched.`)) return;
  await admLog("timer.clear", uid, p.display_name, "cleared a stale live timer", null);
  const { error } = await sb.from("live_timers").delete().eq("user_id", uid);
  if (error) { toast("Could not clear: " + error.message); return; }
  toast("Timer cleared");
  await admAfterWrite();
}

/* Profile editing reuses the crew's own vocabulary — name, colour and
   the default goal. Anything more (avatars, weekday goals) belongs to the
   person, and there is no moderation reason to reach into it. */
async function admEditMember(uid) {
  const p = profileOf(uid);
  const name = prompt(`Display name for this member:`, p.display_name || "");
  if (name === null) return;
  if (!name.trim()) { toast("A display name cannot be empty"); return; }
  const patch = { display_name: name.trim() };
  await admLog("member.edit", uid, p.display_name,
    `name "${p.display_name}" → "${patch.display_name}"`,
    { before: { display_name: p.display_name } });

  const { error } = await sb.from("profiles").update(patch).eq("id", uid);
  if (error) { toast("Could not save: " + error.message); return; }
  toast("Profile updated");
  await admAfterWrite();
}

/* ==================================================================== BOOT
   app.js calls adminBoot() as soon as a session comes up — but that can happen
   before the browser has even fetched this file, since app.js is parsed first
   and its sign-in resolves on the next microtask. So cover the other order
   too: if a session is already live by the time we load, ask now. */
if (typeof UID !== "undefined" && UID) adminBoot();

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && ADM.open && !editingId) { e.stopImmediatePropagation(); closeAdmin(); }
});
