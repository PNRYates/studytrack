/* =========================================================================
   THE HSC IS DONE — confetti, everywhere, for good
   -------------------------------------------------------------------------
   From the moment your last paper finishes, confetti rains over the whole
   app, every tab, for as long as you keep coming back. Alongside it:
     · a card the first time, with what you put into Study Track
     · Today's countdown turns into the celebration (plan.js asks for it)
     · a 🎓 badge in the masthead and 🎉 on the browser tab

   "Your last paper" is the latest one on your own exam list, the same list
   the countdown and the calendar use (plnExams in plan.js), so all three
   agree on when you finished. With no exams on the list it is the end of
   the whole HSC, from the timetable in catalogue.js.

   The confetti can be turned off: a faint 🎊 in the bottom-left corner, or
   the link on Today's card. That choice is per device, and a device set to
   reduce motion starts with it off. Nothing else is switched off by it.

   The rain is one canvas behind every overlay, never clickable, a fixed
   number of pieces for the size of the screen, and it stops drawing when
   the tab is not in view.
   ========================================================================= */

const HSC_STORE = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* this visit only */ } }
};
const HSC_DONE_MEMO = { at: 0, val: null };

/* When the whole HSC finishes: the latest paper on the timetable. */
function hscOverallEnd() {
  if (hscOverallEnd.v !== undefined) return hscOverallEnd.v;
  let last = null;
  const C = window.HSC_CATALOGUE;
  ((C && C.subjects) || []).filter(s => !s.retired).forEach(s => (s.exams || []).forEach(e => {
    const t = plnAt(e.date, e.end, 17);
    if (!last || t > last) last = t;
  }));
  return (hscOverallEnd.v = last);
}

/* When your HSC finishes: the end of the last paper on your list. */
function hscDoneAt() {
  if (typeof plnExams !== "function") return hscOverallEnd();
  const list = plnExams().list;
  if (!list.length) return hscOverallEnd();
  return list.reduce((m, e) => (!m || e.endAt > m ? e.endAt : m), null);
}
/* Asked every second by the tab title, so it is worked out at most every
   few seconds. */
function hscDone() {
  if (!UID || !ME) return false;
  if (Date.now() - HSC_DONE_MEMO.at < 5000 && HSC_DONE_MEMO.val !== null) return HSC_DONE_MEMO.val;
  const at = hscDoneAt();
  HSC_DONE_MEMO.val = !!at && Date.now() >= at.getTime();
  HSC_DONE_MEMO.at = Date.now();
  return HSC_DONE_MEMO.val;
}

/* ---------------------------------------------------------------------------
   Everybody else's: profiles.hsc_done_at (hsc_done.sql)

   Other people's subjects never reach this app, so each app writes its own
   person's moment onto their profile row, which everybody reads already.
   The database filled it in for everyone from the timetable to begin with;
   your app corrects it whenever it knows better (a hand-typed subject name,
   a date of your own). It may be ahead: the tag appears once it has passed.
   --------------------------------------------------------------------------- */
function hscDoneFor(id) {
  const p = profileRow(id);
  const at = p && p.hsc_done_at ? new Date(p.hsc_done_at).getTime() : 0;
  return at > 0 && Date.now() >= at;
}
/* The tag, for beside a name. `small` is just the hat, for tight rows. */
function hscTag(id, small) {
  if (!UID || !hscDoneFor(id)) return "";
  const who = id === UID ? "You've" : esc((profileRow(id) || {}).display_name || "This member") + " has";
  return `<span class="hsc-tag${small ? " sm" : ""}" title="${who} finished the HSC 🎉">🎓${small ? "" : " HSC done"}</span>`;
}

function hscPublish() {
  if (!UID || !ME || typeof plnExams !== "function" || !sb) return;
  const at = hscDoneAt();
  if (!at) return;
  const iso = at.toISOString();
  const had = ME.hsc_done_at ? new Date(ME.hsc_done_at).getTime() : 0;
  if (Math.abs(had - at.getTime()) < 60000 || hscPublish.sent === iso) return;
  hscPublish.sent = iso;
  sb.from("profiles").update({ hsc_done_at: iso }).eq("id", UID).then(({ error }) => {
    if (error) { hscPublish.sent = null; return; }   /* try again on the next check */
    ME.hsc_done_at = iso;
  });
}

/* For paintTimer: a party hat on the tab whenever no timer is running. */
function hscTitle(base) {
  return hscDone() && base === APP_NAME ? "🎉 " + base + " · HSC done" : base;
}

/* ---------------------------------------------------------------------------
   The switch
   --------------------------------------------------------------------------- */
function cfWanted() {
  const v = HSC_STORE.get("st.confetti");
  if (v === "on") return true;
  if (v === "off") return false;
  try { return !matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return true; }
}
function cfSetWanted(on) {
  HSC_STORE.set("st.confetti", on ? "on" : "off");
  celebrateRender();
  toast(on ? "Confetti's back 🎊" : "Confetti off. The 🎊 in the corner brings it back.", 3800);
}
document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest("[data-cftoggle]");
  if (b) cfSetWanted(!cfWanted());
});

/* ---------------------------------------------------------------------------
   The rain
   --------------------------------------------------------------------------- */
const CF = { on: false, cv: null, ctx: null, parts: [], burst: [], raf: 0, w: 0, h: 0, dpr: 1, last: 0 };
const CF_COLOURS = ["#E8402A", "#FF7A4D", "#F4B740", "#19A974", "#0FA3B1", "#3E7CA6", "#7A4FD6", "#E85D9A"];

function cfPiece(top) {
  const big = Math.random() < .5;
  return {
    x: Math.random() * CF.w,
    y: top ? -20 - Math.random() * 40 : Math.random() * CF.h * 1.1 - CF.h * .1,
    vy: .55 + Math.random() * 1.15,
    vx: (Math.random() - .5) * .35,
    sw: Math.random() * 6.28, sws: .01 + Math.random() * .03,
    r: Math.random() * 6.28, vr: (Math.random() - .5) * .12,
    w: big ? 7 + Math.random() * 4 : 5 + Math.random() * 3,
    h: big ? 10 + Math.random() * 6 : 4 + Math.random() * 3,
    round: Math.random() < .22,
    c: CF_COLOURS[Math.floor(Math.random() * CF_COLOURS.length)]
  };
}
function cfSize() {
  if (!CF.cv) return;
  CF.dpr = Math.min(2, window.devicePixelRatio || 1);
  CF.w = window.innerWidth; CF.h = window.innerHeight;
  CF.cv.width = Math.round(CF.w * CF.dpr); CF.cv.height = Math.round(CF.h * CF.dpr);
  CF.ctx.setTransform(CF.dpr, 0, 0, CF.dpr, 0, 0);
  /* about one piece per 14,000 px², so a phone gets a light shower and a
     big monitor a proper one, without either costing much */
  const want = Math.round(Math.max(36, Math.min(120, CF.w * CF.h / 14000)));
  while (CF.parts.length < want) CF.parts.push(cfPiece(false));
  CF.parts.length = want;
}
function cfCanvas() {
  if (CF.cv) return;
  CF.cv = document.createElement("canvas");
  CF.cv.id = "cf-rain";
  CF.cv.setAttribute("aria-hidden", "true");
  document.body.appendChild(CF.cv);
  CF.ctx = CF.cv.getContext("2d");
  cfSize();
  window.addEventListener("resize", cfSize);
}
function cfDraw(p) {
  const x = CF.ctx;
  x.save();
  x.translate(p.x, p.y);
  x.rotate(p.r);
  /* the flutter: a strip of paper turning edge-on and back */
  x.scale(1, Math.cos(p.r * 1.7));
  x.fillStyle = p.c;
  if (p.round) { x.beginPath(); x.arc(0, 0, p.w / 2, 0, 6.283); x.fill(); }
  else x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
  x.restore();
}
function cfFrame(ts) {
  CF.raf = 0;
  if (!CF.on && !CF.burst.length) { CF.ctx.clearRect(0, 0, CF.w, CF.h); return; }
  const dt = Math.min(3, (ts - (CF.last || ts)) / 16.67) || 1;
  CF.last = ts;
  CF.ctx.clearRect(0, 0, CF.w, CF.h);
  if (CF.on) CF.parts.forEach(p => {
    p.sw += p.sws * dt;
    p.y += p.vy * dt;
    p.x += (p.vx + Math.sin(p.sw) * .55) * dt;
    p.r += p.vr * dt;
    if (p.y > CF.h + 24 || p.x < -30 || p.x > CF.w + 30) Object.assign(p, cfPiece(true));
    cfDraw(p);
  });
  CF.burst = CF.burst.filter(p => {
    p.vy += .16 * dt; p.vx *= .985;
    p.y += p.vy * dt; p.x += p.vx * dt; p.r += p.vr * dt;
    cfDraw(p);
    return p.y < CF.h + 30;
  });
  /* a tab out of view gets no frames at all, so this costs nothing there */
  CF.raf = requestAnimationFrame(cfFrame);
}
function cfKick() {
  cfCanvas();
  if (!CF.raf) { CF.last = 0; CF.raf = requestAnimationFrame(cfFrame); }
}
function cfStart() { if (CF.on) return; CF.on = true; cfKick(); }
function cfStop() { CF.on = false; }   /* the next frame clears it */

/* One big pop from the top of the screen, for the moment itself. */
function cfBurst(n) {
  cfCanvas();
  for (let i = 0; i < (n || 180); i++) {
    const p = cfPiece(false), a = Math.random() * Math.PI;
    p.x = CF.w / 2 + (Math.random() - .5) * CF.w * .3;
    p.y = CF.h * .28;
    p.vx = Math.cos(a) * (3 + Math.random() * 9);
    p.vy = -Math.sin(a) * (6 + Math.random() * 9);
    p.vr = (Math.random() - .5) * .4;
    CF.burst.push(p);
  }
  cfKick();
}

/* ---------------------------------------------------------------------------
   The rest of the party
   --------------------------------------------------------------------------- */
function hscMyTotals() {
  const e = DB.daily && DB.daily.get(UID);
  if (!e) return null;
  const days = Object.values(e.days || {}).filter(v => (v && v[0]) > 0).length;
  return { hours: e.total_minutes / 60, sessions: e.total_sessions, days };
}
function hscFirstName() {
  return String((ME && ME.display_name) || "").trim().split(/\s+/)[0] || "legend";
}

/* Today's countdown, once there is nothing left to count down to. Called by
   plan.js (your papers) and app.js (anybody with none on their list). */
function hscDoneCardHTML(papers) {
  const T = hscMyTotals();
  const stat = (v, k) => `<div class="hd-stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`;
  return `<div class="xc xc-done hsc-done">
    <div class="xc-hero">
      <div class="xc-k">That's the HSC</div>
      <div class="xc-big">Done 🎓</div>
      <div class="xc-what">${papers ? `All ${papers} of your papers are behind you.` : "Every paper is behind you."}</div>
    </div>
    <div class="xc-side hd-side">
      <div class="hd-head">You did it, ${esc(hscFirstName())}. Go celebrate. 🎉</div>
      ${T && T.hours > 0 ? `<div class="hd-stats">
        ${stat(f0(T.hours), "hours logged")}
        ${stat(f0(T.sessions), T.sessions === 1 ? "session" : "sessions")}
        ${stat(f0(T.days), T.days === 1 ? "day studied" : "days studied")}
      </div>` : ""}
      <div class="hd-foot">Every one of those hours counted. Results come out in December.
        <button type="button" class="hd-cf" data-cftoggle>${cfWanted() ? "Turn the confetti off" : "Bring back the confetti"}</button></div>
    </div>
  </div>`;
}

/* The first time, a card of its own and one big pop. Once per account per
   device. */
function hscShowOnce() {
  const key = "st.hscdone." + UID;
  if (HSC_STORE.get(key)) return;
  HSC_STORE.set(key, String(Date.now()));
  const T = hscMyTotals();
  let ov = $("hsc-cele");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "hsc-cele"; ov.className = "pl-cele hsc-cele";
    document.body.appendChild(ov);
    ov.addEventListener("click", e => {
      if (e.target === ov || e.target.closest("[data-hscclose]")) ov.classList.remove("on");
    });
  }
  ov.innerHTML = `<div class="pl-celebox" role="dialog" aria-label="You've finished the HSC">
    <div class="pl-celek">That's the HSC</div>
    <div class="pl-celeart hsc-art">🎓</div>
    <h2>You're done, ${esc(hscFirstName())}!</h2>
    <p>${T && T.hours > 0
      ? `Every paper is behind you. You put <b>${esc(f0(T.hours))} hours</b> into Study Track across ${esc(f0(T.sessions))} sessions. That's a serious effort, so go and enjoy it.`
      : "Every paper is behind you. Go and enjoy it."}</p>
    <div class="pl-celebtns"><button class="btn sm" data-hscclose>Let's go 🎉</button></div>
  </div>`;
  requestAnimationFrame(() => ov.classList.add("on"));
  if (cfWanted()) cfBurst(220);
}

/* The faint corner switch. Small on purpose: the confetti is the point, the
   way out is there for whoever needs it. */
function hscPaintToggle(show) {
  let b = $("cf-tog");
  if (!show) { if (b) b.hidden = true; return; }
  if (!b) {
    b = document.createElement("button");
    b.type = "button"; b.id = "cf-tog"; b.className = "cf-tog";
    b.setAttribute("data-cftoggle", "");
    b.textContent = "🎊";
    document.body.appendChild(b);
  }
  const on = cfWanted();
  b.hidden = false;
  b.classList.toggle("off", !on);
  b.setAttribute("aria-pressed", String(on));
  const t = on ? "Confetti on. Tap to turn it off" : "Confetti off. Tap to bring it back";
  b.title = t; b.setAttribute("aria-label", t);
}

function hscPaintBadge(show) {
  let b = $("hscbadge");
  if (!b) {
    const after = $("crewchip");
    if (!after) return;
    b = document.createElement("span");
    b.id = "hscbadge"; b.className = "hscbadge";
    b.textContent = "🎓 HSC done";
    b.title = "You've finished the HSC";
    after.insertAdjacentElement("afterend", b);
  }
  b.hidden = !show;
}

function celebrateRender() {
  let done = false;
  try { done = hscDone(); hscPublish(); } catch (e) { console.error("celebrate", e); }
  hscPaintBadge(done);
  hscPaintToggle(done);
  if (done && cfWanted()) cfStart(); else cfStop();
  const link = document.querySelector(".hd-cf");
  if (link) link.textContent = cfWanted() ? "Turn the confetti off" : "Bring back the confetti";
  if (!done) return;
  /* the countdown card may still be the one from before the last paper */
  if ($("countdown") && !$("countdown").querySelector(".hsc-done") && typeof paintCountdown === "function") {
    try { paintCountdown(); } catch (e) { console.error(e); }
  }
  hscShowOnce();
}

/* Signed in, and the last paper ends while the app is open: every fifteen
   seconds is close enough to the bell. */
setInterval(() => {
  if (!UID || !ME || document.hidden) return;
  HSC_DONE_MEMO.at = 0;
  celebrateRender();
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && UID && ME) { HSC_DONE_MEMO.at = 0; celebrateRender(); }
});
/* app.js may have signed in and drawn everything before this file arrived */
if (typeof UID !== "undefined" && UID && ME) celebrateRender();
