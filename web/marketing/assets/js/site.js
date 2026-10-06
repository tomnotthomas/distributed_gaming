/* Launch pages: language links, waitlist and host forms, nav, reveals.
   Each language is its own static URL (/ and /en/); the DE/EN buttons go to the page named by
   <link rel="alternate" hreflang>. Forms POST JSON to the endpoint in <meta name="form-endpoint">
   (or data-endpoint on the form). Without an endpoint they only show the confirmation state. */
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("js");
  if (!/[?&]static\b/.test(location.search)) root.classList.add("reveal");
  var current = root.lang === "en" ? "en" : "de";
  var T = window.SITE_T || {};
  var TXT = {};

  function snapshot() {
    document.querySelectorAll("[data-t]").forEach(function (el) {
      if (!(el.dataset.t in TXT)) TXT[el.dataset.t] = el.innerHTML;
    });
  }
  function fill() {
    document.querySelectorAll("[data-t]").forEach(function (el) {
      var v = TXT[el.dataset.t];
      if (v == null || v.indexOf("{email}") < 0) return;
      var form = el.closest("[data-email]");
      if (form) el.innerHTML = v.replace("{email}", escapeHtml(form.dataset.email));
    });
  }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  window.SiteLang = window.SwiffLang = {
    get: function () { return current; },
    t: function (k) { return T[k] != null ? T[k] : TXT[k]; },
  };

  function goLang(lang) {
    if (lang === current) return;
    var alt = document.querySelector('link[rel="alternate"][hreflang="' + lang + '"]');
    try { localStorage.setItem("site-lang", lang); } catch (e) {}
    // Keep the path only, so the switch works on any host (staging, preview, the final domain).
    if (!alt) return;
    var target = new URL(alt.getAttribute("href"), location.href).pathname;
    // On an invite route (/crew/<code>) carry the code over: canonical is the template's path.
    var canon = document.querySelector('link[rel="canonical"]');
    var own = canon ? new URL(canon.getAttribute("href"), location.href).pathname : "";
    if (own && location.pathname.indexOf(own) === 0) target += location.pathname.slice(own.length);
    location.href = target + location.search + location.hash;
  }

  /* The invite routes are /crew/<code>, /seat/<code>, /gift/<code>, /night/<code> (and the same under /en/). */
  function inviteFromPath() {
    var m = location.pathname.match(/^(?:\/en)?\/(crew|seat|gift|night)\/([^/]+)\/?$/);
    return m ? { type: m[1], code: m[2] } : null;
  }
  window.SiteInvite = inviteFromPath();

  /* ---------- Forms ---------- */
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var meta = document.querySelector('meta[name="form-endpoint"]');
  var ENDPOINT = meta ? meta.getAttribute("content") : "";

  function wireForm(form) {
    var input = form.querySelector("input[type=email]");
    var err = form.querySelector(".wl-err");
    var state = form.querySelector(".wl-state");
    var done = form.querySelector(".wl-done");
    var button = form.querySelector("button[type=submit]");
    input.addEventListener("input", function () {
      if (form.hasAttribute("data-invalid") && EMAIL.test(input.value.trim())) {
        form.removeAttribute("data-invalid");
        err.hidden = true;
        input.removeAttribute("aria-invalid");
      }
    });
    function show(msg) {
      form.setAttribute("data-invalid", "");
      err.innerHTML = msg;
      err.hidden = false;
      button.disabled = false;
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!EMAIL.test(v)) {
        input.setAttribute("aria-invalid", "true");
        show(TXT[err.dataset.t] || err.innerHTML);
        input.focus();
        return;
      }
      button.disabled = true;
      var url = form.dataset.endpoint || ENDPOINT;
      var params = new URLSearchParams(location.search);
      var body = {
        email: v,
        kind: form.hasAttribute("data-host") ? "host" : "player",
        lang: current,
        page: location.pathname,
        invite: params.get("i") || inviteFromPath(),
      };
      var finish = function () {
        form.dataset.email = v;
        state.hidden = true;
        done.hidden = false;
        fill();
        done.focus();
      };
      if (!url) {
        if (window.console) console.warn("no form endpoint configured, nothing was sent.");
        setTimeout(finish, 300);
        return;
      }
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function (r) { if (!r.ok) throw new Error(r.status); finish(); })
        .catch(function () { show(T["form.fail"] || "Error"); });
    });
  }

  /* ---------- Nav: a solid bar once the page moves ---------- */
  function wireNav() {
    var nav = document.querySelector("[data-nav]");
    var sentinel = document.querySelector("[data-nav-sentinel]");
    if (!nav || !sentinel || !("IntersectionObserver" in window)) return;
    new IntersectionObserver(function (entries) {
      nav.classList.toggle("is-scrolled", !entries[0].isIntersecting);
    }).observe(sentinel);
  }

  /* ---------- Reveal ---------- */
  function wireReveal() {
    var els = document.querySelectorAll(".rv");
    if (!("IntersectionObserver" in window)) {
      els.forEach(function (e) { e.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    els.forEach(function (e) { io.observe(e); });
  }

  /* ---------- Copy buttons (share page) ---------- */
  function wireCopy() {
    document.querySelectorAll("[data-copy]").forEach(function (b) {
      b.addEventListener("click", function () {
        var src = document.getElementById(b.dataset.copy);
        if (!src || !navigator.clipboard) return;
        navigator.clipboard.writeText(src.innerText).then(function () {
          var was = b.textContent;
          b.textContent = T["copy.done"] || "OK";
          setTimeout(function () { b.textContent = was; }, 1600);
        });
      });
    });
  }

  function init() {
    if (!root.classList.contains("reveal")) {
      document.querySelectorAll("img[loading=lazy]").forEach(function (i) { i.loading = "eager"; });
    }
    snapshot();
    document.querySelectorAll("[data-lang]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.lang === current));
      b.addEventListener("click", function () { goLang(b.dataset.lang); });
    });
    document.querySelectorAll("form[data-waitlist], form[data-host]").forEach(wireForm);
    wireNav();
    wireReveal();
    wireCopy();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
