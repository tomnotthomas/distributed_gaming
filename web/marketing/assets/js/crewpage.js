/* Crew page (/share/): the decided crew flow (data/swiff-crew-flow, Flow A "Sofort-Crew").
   The crew exists right away, with a name and a link; a gaming PC can join now or later.
   ?state=new (just started, the default) | people (friends joined) | ready (a gaming PC is in);
   ?joined=1 (you joined someone's crew; the PC-owner card comes first); ?pc=1 (you bring the PC);
   ?name= (your Steam name: the app knows it, the preview passes it after the sign-in stand-in);
   ?code= (crew code; the app uses GET /api/me/invite). WhatsApp: the phone's share sheet (navigator.share),
   wa.me everywhere else. */
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var body = document.body;
  function ss(k, v) {
    try {
      if (v === undefined) return sessionStorage.getItem(k);
      sessionStorage.setItem(k, v);
    } catch (e) { return null; }
  }
  var joined = q.get("joined") === "1" || ss("crew-joined") === "1";
  if (joined) ss("crew-joined", "1");
  // Joining someone's crew means it already has people in it.
  var state = { people: "people", ready: "ready" }[q.get("state")] || (joined ? "people" : "new");
  var bringsPc = q.get("pc") === "1";
  var code = (q.get("code") || ss("crew-code") || "K7Q2MX").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "K7Q2MX";
  var name = (q.get("name") || ss("crew-name") || "").replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 24);
  if (name) ss("crew-name", name);
  var crewName = (ss("crew-title") || "").slice(0, 24);
  var nameIdx = Number(ss("crew-title-idx") || 0);
  var day = Number(ss("crew-day") || 1);
  var time = ss("crew-time") || "21:00";
  var token = null;
  body.dataset.state = state;
  var phone = window.matchMedia && matchMedia("(pointer: coarse)").matches;
  var canShare = typeof navigator.share === "function";

  function lang() { return document.documentElement.lang === "en" ? "en" : "de"; }
  function M() { var m = window.SITE_MSGS || {}; return m[lang()] || m.de || { ui: {} }; }
  function crew() {
    if (crewName) return crewName;
    var names = M().ui.names || [];
    return names[nameIdx] || names[0] || "Crew";
  }
  function origin() {
    if (/^https?:$/.test(location.protocol)) {
      if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return location.origin;
      var canon = document.querySelector('link[rel="canonical"]');
      return canon ? new URL(canon.href).origin : location.origin;
    }
    return "{{site}}";
  }
  // In the app the link comes from GET /api/me/invite ({token, crew}, #96): the app's crew links are
  // /invite/<token>. The preview and the design files use a demo code.
  function link() {
    if (token) return origin() + "/invite/" + token;
    return origin() + "/" + ((M().invite || {}).path || "crew") + "/" + code;
  }
  function fill(s) {
    var days = M().ui.days || [];
    return String(s || "").replace("{crew}", crew()).replace("{link}", link()).replace("{day}", days[day] || "").replace("{time}", time);
  }
  function message(kind) {
    if (kind === "ask") return fill((M().ask || {}).whatsapp);
    if (kind === "night") return fill((M().night || {}).whatsapp);
    if (kind === "telegram") return fill((M().invite || {}).telegram);
    return fill((M().invite || {}).whatsapp);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function host() { return link().replace(/^https?:\/\//, ""); }

  var toastEl = document.querySelector(".cp-toast");
  var timer;
  function toast(text) {
    if (!toastEl || !text) return;
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(function () { toastEl.hidden = true; }, 5200);
  }
  function sent(kind, quiet) {
    if (kind !== "ask" && kind !== "night") ss("crew-sent", "1");
    mark();
    if (!quiet) toast(M().ui[kind === "ask" ? "asked" : kind === "night" ? "night" : "sent"]);
  }
  function copy(text, done) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      ta.remove();
      done();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  function pasteHint(app) { return (M().ui.pasted || "").replace("{app}", app); }

  // When each progress stop counts as done. The stops are the <ol class="lb-prog"> list in the page
  // (data-step keys); to change the flow, change that list and these rules, nothing else.
  var STEP_DONE = {
    made: function () { return true; },
    people: function (c) { return c.state !== "new" || c.sent || c.joined; },
    pc: function (c) { return c.state === "ready"; },
    ready: function (c) { return c.state === "ready"; },
  };
  function mark() {
    var c = { state: state, sent: ss("crew-sent") === "1", joined: joined };
    document.querySelectorAll(".lb-prog").forEach(function (list) {
      var now = false;
      list.style.setProperty("--n", list.children.length);
      list.querySelectorAll("li[data-step]").forEach(function (li) {
        var rule = STEP_DONE[li.dataset.step];
        var done = rule ? !!rule(c) : false;
        li.classList.toggle("done", done);
        li.classList.toggle("now", !done && !now);
        if (!done) now = true;
      });
    });
    var pcItem = document.querySelector("[data-pc-item]");
    if (pcItem) pcItem.classList.toggle("ok", state === "ready");
  }

  // Show the parts marked data-show="new people ready founder joined" that fit the crew right now.
  function show() {
    var STATES = ["new", "people", "ready"], ROLES = ["founder", "joined"];
    document.querySelectorAll("[data-show]").forEach(function (el) {
      var tokens = el.dataset.show.split(/\s+/);
      var st = tokens.filter(function (x) { return STATES.indexOf(x) >= 0; });
      var ro = tokens.filter(function (x) { return ROLES.indexOf(x) >= 0; });
      var ok = (!st.length || st.indexOf(state) >= 0) && (!ro.length || ro.indexOf(joined ? "joined" : "founder") >= 0);
      el.hidden = !ok;
    });
  }

  function render() {
    show();
    document.querySelectorAll("[data-me-name]").forEach(function (el) {
      el.textContent = name ? name + (lang() === "en" ? " (you)" : " (du)") : (lang() === "en" ? "You" : "Du");
    });
    document.querySelectorAll("[data-me-initial]").forEach(function (el) {
      el.textContent = (name || (lang() === "en" ? "Y" : "D")).charAt(0).toUpperCase();
    });
    document.querySelectorAll("[data-crew-name]").forEach(function (el) { el.textContent = crew(); });
    document.querySelectorAll("[data-code]").forEach(function (el) { el.textContent = token ? token.slice(0, 6).toUpperCase() : code; });
    var names = M().ui.names || [];
    document.querySelectorAll("[data-name-pick]").forEach(function (b) {
      var i = Number(b.dataset.namePick);
      b.textContent = names[i] || "";
      b.setAttribute("aria-pressed", String(!crewName && i === nameIdx));
    });
    var own = document.querySelector("[data-name-own]");
    if (own) own.setAttribute("aria-pressed", String(!!crewName));
    var days = document.querySelector(".fa-days");
    if (days) {
      days.innerHTML = "";
      (M().ui.days || []).forEach(function (d, i) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "fa-chip"; b.dataset.day = i; b.textContent = d;
        b.setAttribute("aria-pressed", String(i === day));
        days.appendChild(b);
      });
    }
    document.querySelectorAll("[data-time]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.time === time)); });
    var yes = document.querySelector("[data-yes]");
    if (yes) yes.textContent = state === "new" ? "1" : state === "people" ? "3" : "4";
    var url = document.getElementById("cp-url");
    if (url) url.textContent = host();
    var msg = document.getElementById("cp-msg");
    if (msg) msg.innerHTML = esc(message()).replace(esc(link()), '<span class="cp-msg-link">' + esc(link()) + "</span>");
    var ask = document.getElementById("fa-ask-q");
    if (ask) ask.textContent = message("ask").replace(" " + link(), "");
    var og = document.getElementById("cp-og");
    var inv = M().invite || {};
    if (og && inv.og_img) {
      var cur = og.getAttribute("src");
      og.setAttribute("src", cur.slice(0, cur.lastIndexOf("/") + 1) + inv.og_img);
    }
    var ogt = document.getElementById("cp-og-t");
    if (ogt && inv.og_title) ogt.textContent = inv.og_title;
    var ogd = document.getElementById("cp-og-d");
    if (ogd) ogd.textContent = host().split("/")[0];
    var nat = document.querySelector('[data-share="native"]');
    if (nat) nat.hidden = !canShare;
    if (ss("crew-pc-later") === "1") { var pcc = document.getElementById("fa-pcc"); if (pcc) pcc.classList.add("is-later"); }
    mark();
  }

  function share(kind) {
    var text = message(kind);
    if (phone && canShare) navigator.share({ text: text }).then(function () { sent(kind); }, function () {});
    else { window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener"); sent(kind); }
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("button, a");
    if (!b) return;
    if (b.hasAttribute("data-lang")) { setTimeout(render, 40); return; }
    if (b.hasAttribute("data-name-pick")) {
      crewName = ""; nameIdx = Number(b.dataset.namePick);
      ss("crew-title", ""); ss("crew-title-idx", String(nameIdx));
      document.querySelector(".fa-name-in").hidden = true;
      render(); return;
    }
    if (b.hasAttribute("data-name-own")) {
      var inp = document.querySelector(".fa-name-in");
      inp.hidden = false; inp.value = crewName || ""; inp.focus(); return;
    }
    if (b.dataset.day !== undefined && b.classList.contains("fa-chip")) { day = Number(b.dataset.day); ss("crew-day", String(day)); render(); return; }
    if (b.hasAttribute("data-time")) { time = b.dataset.time; ss("crew-time", time); render(); return; }
    if (b.hasAttribute("data-night-open")) {
      var n = document.getElementById("fa-night");
      n.hidden = !n.hidden;
      if (!n.hidden) n.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    if (b.hasAttribute("data-pc-open")) {
      var p = document.getElementById("fa-pcc");
      p.classList.remove("is-later"); ss("crew-pc-later", "0");
      p.scrollIntoView({ behavior: "smooth", block: "start" }); return;
    }
    if (b.hasAttribute("data-pc-later")) { document.getElementById("fa-pcc").classList.add("is-later"); ss("crew-pc-later", "1"); return; }
    if (b.hasAttribute("data-copy-link")) { copy(link(), function () { toast(M().ui.copied); }); return; }
    var kind = b.dataset.share;
    if (!kind) return;
    var what = b.dataset.msg || "invite";
    if (kind === "whatsapp") share(what);
    else if (kind === "telegram") {
      window.open("https://t.me/share/url?url=" + encodeURIComponent(link()) + "&text=" + encodeURIComponent(message("telegram")), "_blank", "noopener");
      sent("invite");
    } else if (kind === "discord") copy(message(), function () { toast(pasteHint("Discord")); sent("invite", true); });
    else if (kind === "signal") {
      if (phone && canShare) navigator.share({ text: message() }).then(function () { sent("invite"); }, function () {});
      else copy(message(), function () { toast(pasteHint("Signal")); sent("invite", true); });
    } else if (kind === "native" && canShare) navigator.share({ text: message() }).then(function () { sent("invite"); }, function () {});
  });
  document.addEventListener("input", function (e) {
    if (!e.target.classList.contains("fa-name-in")) return;
    crewName = e.target.value.replace(/[<>]/g, "").slice(0, 24);
    ss("crew-title", crewName);
    render();
  });

  render();
  // Joined someone's crew, or bringing the PC: the PC-owner card comes first (X's card, after joining).
  if ((joined || bringsPc) && state !== "ready") {
    var pcc = document.getElementById("fa-pcc");
    var path = document.querySelector(".lb-path");
    if (pcc && path) path.before(pcc);
  }
  if (/^https?:$/.test(location.protocol) && !/^(127\.0\.0\.1|localhost)$/.test(location.hostname) && !q.get("code")) {
    fetch("/api/me/invite", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.token) { token = j.token; render(); } })
      .catch(function () {});
  }
})();
