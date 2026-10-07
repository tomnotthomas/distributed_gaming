/* Launch pages: language links, nav, reveals.
   Each language is its own static URL (/ and /en/); the DE/EN buttons go to the page named by
   <link rel="alternate" hreflang>. */
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
    wireNav();
    wireReveal();
    wireCopy();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
