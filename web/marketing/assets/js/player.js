/* Player page: the hero slideshow (two games, picker, pause) and the drafted-title fitter.
   Pauses when the visitor asks, when the tab is hidden, and under reduced motion. */
(function () {
  "use strict";
  var slides = document.querySelectorAll("[data-slide]");
  var titles = document.querySelectorAll("[data-title]");
  var tabs = document.querySelectorAll("[data-go]");
  var pause = document.querySelector("[data-pause]");
  var at = 0, timer = 0;
  var paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function t(k) { return window.SwiffLang ? SwiffLang.t(k) : ""; }
  function show(i) {
    if (!slides.length) return;
    at = i;
    slides.forEach(function (s, n) { s.classList.toggle("on", n === i); });
    titles.forEach(function (s, n) { s.classList.toggle("on", n === i); });
    tabs.forEach(function (s, n) { s.setAttribute("aria-selected", String(n === i)); });
    var img = slides[i].querySelector("img");
    if (img && img.loading === "lazy") img.loading = "eager";
  }
  function tick() {
    clearTimeout(timer);
    if (slides.length < 2) return;
    if (!paused && !document.hidden) timer = setTimeout(function () { show((at + 1) % slides.length); tick(); }, 7000);
  }
  function label() {
    if (!pause) return;
    pause.querySelector("path").setAttribute("d", paused ? "M9 6.5v11l8.5-5.5z" : "M9 6v12M15 6v12");
    pause.setAttribute("aria-label", t(paused ? "hero.play" : "hero.pause") || (paused ? "Diashow fortsetzen" : "Diashow anhalten"));
  }
  function setPaused(p) { paused = p; label(); tick(); }
  tabs.forEach(function (b) { b.addEventListener("click", function () { show(+b.dataset.go); setPaused(true); }); });
  if (pause) pause.addEventListener("click", function () { setPaused(!paused); });
  document.addEventListener("visibilitychange", tick);
  document.addEventListener("swiff:lang", label);
  label();
  tick();

  /* The nav's sign-up pill steps back while the hero's own form is on screen. */
  var heroForm = document.querySelector(".hero form, .hero .wl"), cta = document.querySelector(".nav-cta");
  if (heroForm && cta && "IntersectionObserver" in window) {
    new IntersectionObserver(function (es) {
      cta.classList.toggle("is-quiet", es[0].isIntersecting);
    }).observe(heroForm);
  }

  /* Fit drafted titles: the largest size that fits the given share of the art's width. */
  function fit() {
    document.querySelectorAll("[data-fit]").forEach(function (el) {
      var box = el.closest("[data-fit-box]") || el.parentElement;
      var share = parseFloat(el.dataset.fit) || 0.7;
      var max = parseFloat(el.dataset.fitMax) || 112;
      var slot = el.closest("[data-title]"), was = slot && slot.style.display;
      if (slot) slot.style.display = "block";
      el.style.setProperty("--fs", "100px");
      // Measure the text itself: guide lines drawn as pseudo-elements would inflate scrollWidth.
      var r = document.createRange();
      r.selectNodeContents(el);
      var w = r.getBoundingClientRect().width || el.scrollWidth || 1;
      el.style.setProperty("--fs", Math.min(max, Math.floor((100 * box.clientWidth * share) / w)) + "px");
      if (slot) slot.style.display = was;
    });
  }
  fit();
  addEventListener("resize", fit);
  document.addEventListener("swiff:lang", fit);
  if (document.fonts) document.fonts.ready.then(fit);
})();
