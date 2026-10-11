/* =========================================================================
   POLLS IN CHAT
   -------------------------------------------------------------------------
   A poll hangs off a chat message (polls.sql) and can ask several questions.
   Tap an option to vote; the live split shows once you have answered that
   question, so everyone guesses before seeing what the room thinks. Tap your
   pick again to take it back. Votes are public: each option shows who picked
   it (people in private mode are counted, not named).
   ========================================================================= */
const POLL = { byMsg: {}, res: {}, who: {}, open: new Set(), busy: new Set(), at: 0 };

/* the polls on whatever messages are loaded, and their counts */
async function loadChatPolls(force) {
  if (typeof sb === "undefined" || !UID || !CHAT.rows.length) return;
  const ids = CHAT.rows.map(m => m.id).filter(id => id && !(id in POLL.byMsg));
  if (ids.length) {
    const { data, error } = await sb.from("chat_polls").select("id,message_id,questions,closes_at").in("message_id", ids.slice(-300));
    if (error) return;                       /* not set up: messages show as they are */
    ids.forEach(id => { POLL.byMsg[id] = null; });
    (data || []).forEach(p => { POLL.byMsg[p.message_id] = p; });
  }
  await loadPollResults(force);
}
async function loadPollResults(force) {
  const polls = Object.values(POLL.byMsg).filter(Boolean).map(p => p.id);
  if (!polls.length) return;
  if (!force && Date.now() - POLL.at < 4000) return;
  POLL.at = Date.now();
  const [{ data, error }, vw] = await Promise.all([
    sb.rpc("poll_results", { p_polls: polls }),
    sb.rpc("poll_voters", { p_polls: polls })
  ]);
  if (error) return;
  if (!vw.error) {
    const who = {};
    (vw.data || []).forEach(r => { who[r.poll_id + "|" + r.q + "|" + r.opt] = { ids: r.who || [], hidden: Number(r.hidden) || 0 }; });
    POLL.who = who;
  }
  const next = {};
  (data || []).forEach(r => {
    const p = next[r.poll_id] || (next[r.poll_id] = {});
    const q = p[r.q] || (p[r.q] = { voters: Number(r.voters), opts: {}, mine: [] });
    q.opts[r.opt] = Number(r.n);
    if (r.mine) q.mine.push(r.opt);
  });
  /* a vote still on its way keeps showing as cast */
  POLL.busy.forEach(k => { const [pid] = k.split("|"); if (POLL.res[pid]) next[pid] = POLL.res[pid]; });
  POLL.res = next;
}

/* a message that arrived live may carry a poll */
function pollSeen(m) {
  if (!m || !m.announcement || m.id in POLL.byMsg) return;
  setTimeout(() => loadChatPolls(true).then(() => { if (chatIsOpen()) paintChat(); }), 400);
}

function pollHTML(m) {
  const p = POLL.byMsg[m.id];
  if (!p || !Array.isArray(p.questions)) return "";
  const closed = p.closes_at && new Date(p.closes_at) < new Date();
  const res = POLL.res[p.id] || {};
  return `<div class="poll" data-poll="${esc(p.id)}">${p.questions.map((q, qi) => {
    const r = res[qi] || { voters: 0, opts: {}, mine: [] };
    const max = Math.max(1, Number(q.max) || 1);
    const answered = r.mine.length > 0;
    const show = answered || closed;
    const top = Math.max(0, ...Object.values(r.opts));
    return `<div class="poll-q">
      <div class="poll-qt">${esc(q.q)}${max > 1 ? `<span class="poll-hint">pick up to ${max}</span>` : ""}</div>
      <div class="poll-opts">${(q.options || []).map((o, oi) => {
        const n = r.opts[oi] || 0, pct = r.voters ? Math.round(n / r.voters * 100) : 0;
        const mine = r.mine.includes(oi);
        const w = POLL.who[p.id + "|" + qi + "|" + oi] || { ids: [], hidden: 0 };
        const names = w.ids.map(id => (profileOf(id) || {}).display_name || "someone");
        return `<button type="button" class="poll-opt${mine ? " mine" : ""}${show ? " shown" : ""}${show && n === top && n > 0 ? " lead" : ""}"
          data-pollvote="${esc(p.id)}|${qi}|${oi}" ${closed ? "disabled" : ""} aria-pressed="${mine}"
          ${show && names.length ? `title="${esc(names.join(", "))}${w.hidden ? ` +${w.hidden}` : ""}"` : ""}>
          ${show ? `<i style="width:${pct}%"></i>` : ""}
          <span class="poll-ol">${mine ? "✓ " : ""}${esc(o)}</span>
          ${show && w.ids.length ? `<span class="poll-faces">${w.ids.slice(-4).map(id => avatarHTML(profileOf(id), "sm")).join("")}</span>` : ""}
          ${show ? `<span class="poll-pc">${pct}%</span>` : ""}
        </button>`;
      }).join("")}</div>
      <div class="poll-foot">${r.voters} ${r.voters === 1 ? "guess" : "guesses"}${show ? "" : " · vote to see the split"}${closed ? " · closed" : ""}${
        show && r.voters ? ` · <button type="button" class="poll-who" data-pollwho="${esc(p.id)}|${qi}">${POLL.open.has(p.id + "|" + qi) ? "Hide names" : "See who voted"}</button>` : ""} · votes are public</div>
      ${show && POLL.open.has(p.id + "|" + qi) ? `<div class="poll-names">${(q.options || []).map((o, oi) => {
        const w = POLL.who[p.id + "|" + qi + "|" + oi] || { ids: [], hidden: 0 };
        if (!w.ids.length && !w.hidden) return "";
        return `<div class="poll-nrow"><b>${esc(o)}</b><span>${w.ids.map(id => `<span class="poll-name" data-profile="${esc(id)}">${esc(id === UID ? "You" : (profileOf(id) || {}).display_name || "someone")}</span>`).join(", ")}${w.hidden ? `${w.ids.length ? ", " : ""}${w.hidden} private` : ""}</span></div>`;
      }).join("")}</div>` : ""}
    </div>`;
  }).join("")}</div>`;
}

async function pollVote(pid, qi, oi) {
  const key = pid + "|" + qi;
  if (POLL.busy.has(key)) return;
  const p = Object.values(POLL.byMsg).find(x => x && x.id === pid);
  if (!p) return;
  const q = p.questions[qi] || {}, max = Math.max(1, Number(q.max) || 1);
  const res = POLL.res[pid] || (POLL.res[pid] = {});
  const r = res[qi] || (res[qi] = { voters: 0, opts: {}, mine: [] });
  const before = JSON.parse(JSON.stringify(r));
  let mine = r.mine.slice();
  if (mine.includes(oi)) mine = mine.filter(x => x !== oi);
  else if (max === 1) mine = [oi];
  else if (mine.length >= max) { toast(`Pick up to ${max}. Tap one of yours to swap it.`); return; }
  else mine.push(oi);
  /* show it now */
  r.mine.forEach(x => { r.opts[x] = Math.max(0, (r.opts[x] || 0) - 1); });
  mine.forEach(x => { r.opts[x] = (r.opts[x] || 0) + 1; });
  r.voters += (before.mine.length ? 0 : 1) - (mine.length ? 0 : 1);
  r.mine = mine;
  POLL.busy.add(key);
  paintChat();
  try {
    const { data, error } = await sb.rpc("vote_poll", { p_poll: pid, p_q: qi, p_opts: mine });
    if (error || !data || data.ok === false) throw new Error((data && data.why) || (error && error.message) || "Could not vote");
  } catch (e) {
    res[qi] = before;
    toast(e.message);
  }
  POLL.busy.delete(key);
  await loadPollResults(true);
  if (chatIsOpen()) paintChat();
}

document.addEventListener("click", e => {
  const t = e.target.closest && e.target.closest("[data-pollwho]");
  if (t) { const k = t.dataset.pollwho; POLL.open.has(k) ? POLL.open.delete(k) : POLL.open.add(k); paintChat(); return; }
  const b = e.target.closest && e.target.closest("[data-pollvote]");
  if (!b || b.disabled) return;
  const [pid, qi, oi] = b.dataset.pollvote.split("|");
  pollVote(pid, Number(qi), Number(oi));
});

/* the split moves while you watch */
setInterval(() => {
  if (!UID || document.hidden || typeof chatIsOpen !== "function" || !chatIsOpen()) return;
  if (!Object.values(POLL.byMsg).some(Boolean)) return;
  const was = JSON.stringify(POLL.res);
  loadPollResults(true).then(() => { if (!POLL.busy.size && JSON.stringify(POLL.res) !== was) paintChat(); }).catch(() => {});
}, 20000);
