/* Swiff conversion test harness.
 *
 * Two jobs, both deliberately kept out of the .dc.html templates so the
 * prototypes stay editable:
 *   1. PostHog instrumentation (cookieless, free tier) behind window.swiff.track
 *   2. Two simulated flows the prototypes are missing: the Steam connect and
 *      the invite capture. Nothing is authenticated, nothing is stored locally,
 *      no Steam server is contacted. The consent screen never asks for a
 *      password, because a page that looks like a Steam login and collects
 *      credentials is a phishing page regardless of intent.
 *
 * The UI here borrows the prototypes' own classes (.card, .btn, .btn-primary,
 * .input, .tag) from the Nocturne design system, so these screens inherit the
 * glass treatment each prototype already applies. Local CSS is layout glue
 * only; it never restyles a design system component.
 */
(() => {
  "use strict";

  const CFG = window.SWIFF_TEST || {};
  const SIDE = CFG.side || "unknown";
  const TOKEN = CFG.posthogKey || "";
  const HOST = CFG.posthogHost || "https://eu.i.posthog.com";
  // ?swiffdebug logs every event to the console, for QA and post-deploy checks.
  const DEBUG = CFG.debug || /[?&]swiffdebug\b/.test(location.search);
  // ?steamdemo walks the connected state without a Steam account, for QA and
  // for screenshots. Every event it produces carries demo:true so it can be
  // filtered out of the funnel.
  const DEMO = /[?&]steamdemo\b/.test(location.search);

  // ---------------------------------------------------------------- analytics

  // Cookieless: no banner to show, and nothing is written to cookies, local or
  // session storage. Identity is a privacy-preserving hash PostHog derives on
  // its own servers from the request, which rotates daily. That is what keeps
  // a funnel intact across the Steam round trip: plain memory persistence gave
  // every page load a fresh id, so anyone returning from steamcommunity.com
  // counted as a new person and the conversion rate read as a floor.
  // Requires "Cookieless server hash mode" on in project settings; it is on.
  function loadPostHog() {
    if (!TOKEN) {
      console.warn("[swiff] no PostHog token, events log to console only");
      return null;
    }
    // Minimal async stub: queue calls until the real library lands.
    const stub = [];
    const q = { _q: stub };
    for (const m of ["capture", "identify", "register"]) {
      q[m] = (...a) => stub.push([m, a]);
    }
    const s = document.createElement("script");
    s.async = true;
    s.src = HOST.replace(/\/$/, "") + "/static/array.js";
    s.onload = () => {
      window.posthog.init(TOKEN, {
        api_host: HOST,
        cookieless_mode: "always",
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: true,
      });
      window.posthog.register({ side: SIDE, prototype: CFG.name || document.title });
      for (const [m, a] of stub) window.posthog[m](...a);
    };
    s.onerror = () => console.warn("[swiff] PostHog blocked or offline");
    document.head.appendChild(s);
    return q;
  }

  const ph = loadPostHog();
  const seen = new Set();

  function track(event, props) {
    const payload = Object.assign({ side: SIDE }, DEMO ? { demo: true } : null, props || {});
    if (ph) (window.posthog || ph).capture(event, payload);
    if (DEBUG) console.log("[swiff]", event, payload);
    window.dispatchEvent(new CustomEvent("swiff:track", { detail: { event, props: payload } }));
  }

  // Funnel steps must not double-count when a template re-renders.
  function step(event, props) {
    if (seen.has(event)) return;
    seen.add(event);
    track(event, props);
  }

  // ------------------------------------------------------------ overlay shell

  // Layout and motion only. Colour, type, radius and the glass treatment all
  // come from the page's own .card / .btn / .input rules.
  const css = `
    .sw-ov{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:var(--space-4,16px);
      background:color-mix(in srgb,var(--color-recessed,#03080F) 66%,transparent);
      backdrop-filter:blur(20px) saturate(1.2);-webkit-backdrop-filter:blur(20px) saturate(1.2);
      font-family:var(--font-body,system-ui,sans-serif);color:var(--color-text,#F7FBFF);
      animation:sw-fade .22s ease both}
    .sw-ov .card{width:min(440px,100%);box-sizing:border-box;display:flex;flex-direction:column;
      gap:var(--space-3,12px);padding:var(--space-6,24px);border-radius:var(--radius-lg,16px);
      animation:sw-rise .3s cubic-bezier(.2,.8,.2,1) both}
    .sw-ov h2{font-family:var(--font-heading,inherit);font-weight:500;font-size:22px;line-height:28px;
      letter-spacing:-.02em;margin:0}
    .sw-ov p{margin:0;font-size:14px;line-height:20px;color:var(--color-text-2,#CFE3F5)}
    .sw-ov .sw-note{font-size:12px;line-height:16px;color:var(--color-text-3,#8AA4BE)}
    .sw-row{display:flex;align-items:center;gap:var(--space-2,8px);margin-top:var(--space-2,8px);flex-wrap:wrap}
    .sw-row .btn{flex:1 1 auto;min-height:44px;justify-content:center}
    .sw-row .btn.sw-minor{flex:0 0 auto}
    .sw-ov .input{min-height:44px;padding:0 12px}
    .sw-scope{margin:0;padding:var(--space-3,12px) var(--space-4,16px);border-radius:var(--radius-md,10px);
      background:color-mix(in srgb,var(--color-recessed,#03080F) 45%,transparent);
      border:1px solid var(--glass-edge,rgba(255,255,255,.24))}
    .sw-scope ul{margin:0;padding:0}
    .sw-scope li{list-style:none;display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:19px;
      color:var(--color-text-2,#CFE3F5)}
    .sw-scope li + li{margin-top:8px}
    .sw-tick{color:var(--color-live,#A8E8FF);flex:none;margin-top:2px}
    .sw-bar{height:4px;border-radius:2px;overflow:hidden;background:color-mix(in srgb,var(--color-text-3,#8AA4BE) 25%,transparent)}
    .sw-bar > i{display:block;height:100%;width:0;background:var(--color-accent,#57ACD9);transition:width .3s linear}
    .sw-sim{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:14px}
    .sw-dot{width:5px;height:5px;border-radius:50%;background:var(--color-live,#A8E8FF);
      box-shadow:0 0 8px var(--color-live,#A8E8FF)}
    @keyframes sw-fade{from{opacity:0}to{opacity:1}}
    @keyframes sw-rise{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}
    @media (prefers-reduced-motion:reduce){.sw-ov,.sw-ov .card{animation:none}}
  `;

  let styled = false;
  function ensureStyle() {
    if (styled) return;
    styled = true;
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
  }

  function ready() {
    if (document.body) return Promise.resolve();
    return new Promise((r) => addEventListener("DOMContentLoaded", r, { once: true }));
  }

  function overlay() {
    ensureStyle();
    const ov = document.createElement("div");
    ov.className = "sw-ov";
    const card = document.createElement("div");
    card.className = "card";
    ov.appendChild(card);
    document.body.appendChild(ov);
    return { card, close: () => ov.remove() };
  }

  const SIM = `<span class="tag tag-neutral sw-sim"><span class="sw-dot"></span>
    Prototype &middot; simulated, nothing is sent or stored</span>`;

  const STEAM_MARK = `<svg width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
    <path d="M232.4 114.5 88.3 26.4a16 16 0 0 0-16.2-.3A15.9 15.9 0 0 0 64 40v176a15.9 15.9 0 0 0 8.1 13.9
    16 16 0 0 0 16.2-.3l144.1-88.1a15.9 15.9 0 0 0 0-27Z"/></svg>`;

  // ------------------------------------------------------------- real Steam

  // Steam OpenID 2.0. The sign-in itself happens on steamcommunity.com, so no
  // password ever reaches this page or the little server behind it. We come
  // back holding a verified SteamID, and the server reads the public profile
  // and owned-games list into memory for one single fetch. Nothing is stored.
  function steamConnect() {
    track("steam_connect_started");
    const ui = overlay();
    ui.card.innerHTML = `
      <h2>Taking you to Steam</h2>
      <p>You sign in on Steam's own page. Swiff never sees your password.</p>
      <div class="sw-bar"><i></i></div>
      <span class="sw-note">We read your public profile and your game list. Nothing is saved.</span>`;
    requestAnimationFrame(() => {
      const bar = ui.card.querySelector(".sw-bar > i");
      if (bar) bar.style.width = "100%";
    });
    const back = location.pathname + location.search;
    setTimeout(() => {
      location.href = "/auth/steam?return=" + encodeURIComponent(back);
    }, 650);
  }

  // Subscribers that want the profile whenever it lands, in either order.
  let profile = null;
  const waiting = [];
  function onSteam(cb) {
    if (profile) cb(profile);
    else waiting.push(cb);
  }
  function deliver(p) {
    profile = p;
    window.swiff.profile = p;
    while (waiting.length) {
      try { waiting.shift()(p); } catch (e) { console.error(e); }
    }
  }

  // A plausible library, used only by ?steamdemo. Never reaches PostHog as a
  // real conversion because every demo event is tagged.
  const DEMO_PROFILE = {
    id: "0000", persona: "demo_player", avatar: "", hours: 1840, size: 412, lib: true,
    // Curated wall titles the player owns: [appid, hours]
    owned: [[730, 301], [1245620, 61], [1091500, 22], [1086940, 9]],
    // Their other most-played games: [appid, name, hours]
    games: [
      [570, "Dota 2", 412], [440, "Team Fortress 2", 188], [271590, "Grand Theft Auto V", 96],
      [292030, "The Witcher 3: Wild Hunt", 74], [1174180, "Red Dead Redemption 2", 58],
      [620, "Portal 2", 31], [648800, "Raft", 27], [413150, "Stardew Valley", 22],
      [359550, "Tom Clancy's Rainbow Six Siege", 19], [252490, "Rust", 16],
      [582010, "Monster Hunter: World", 14], [1966720, "Lethal Company", 11],
      [322330, "Don't Starve Together", 8], [739630, "Phasmophobia", 6],
    ],
  };

  function b64urlDecode(v) {
    const b64 = v.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(pad))));
  }

  // Runs on every load: picks up the profile Steam's round trip left behind.
  async function resumeSteam() {
    if (DEMO) {
      await ready();
      step("steam_connected", { games: DEMO_PROFILE.size, hours: DEMO_PROFILE.hours, library_read: true });
      deliver(DEMO_PROFILE);
      return;
    }
    const m = /[#&]steam=([^&]+)/.exec(location.hash || "");
    if (!m) return;
    await ready();
    // Clear it out of the URL before anything can copy or share it.
    history.replaceState(null, "", location.pathname + location.search);

    if (m[1] === "denied") {
      track("steam_connect_abandoned", { at: "steam" });
      return;
    }

    let p = null;
    try { p = b64urlDecode(m[1]); } catch (e) { /* mangled on the way back */ }

    if (!p) {
      track("steam_connect_failed");
      const ui = overlay();
      ui.card.innerHTML = `
        <h2>That sign-in did not come through</h2>
        <p>Something mangled the response on the way back. Try connecting again.</p>
        <div class="sw-row"><button class="btn btn-primary" data-act="retry">Try again</button></div>`;
      ui.card.querySelector('[data-act="retry"]').onclick = () => { ui.close(); steamConnect(); };
      return;
    }

    step("steam_connected", {
      games: (p.owned || []).length,
      hours: p.hours || 0,
      library_size: p.size || 0,
      library_read: Boolean(p.lib),
    });
    deliver(p);
  }

  // -------------------------------------------------------- invite capture

  const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  async function captureEmail(opts) {
    const o = opts || {};
    await ready();
    const at = o.at || "unknown";
    track("invite_prompt_shown", { at });
    const ui = overlay();
    ui.card.innerHTML = `
      <h2>${o.title || "Get your invite"}</h2>
      <p>${o.body || "Swiff is not open to everyone yet. Leave an email and you are in the next group."}</p>
      <input class="input" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com">
      <div class="sw-row">
        <button class="btn btn-secondary sw-minor" data-act="skip">No thanks</button>
        <button class="btn btn-primary" data-act="join" disabled>${o.cta || "Join the list"}</button>
      </div>
      <span class="sw-note">One email when your invite is ready. Nothing else.</span>`;

    const input = ui.card.querySelector("input");
    const join = ui.card.querySelector('[data-act="join"]');
    input.oninput = () => { join.disabled = !EMAIL.test(input.value.trim()); };
    input.onkeydown = (e) => { if (e.key === "Enter" && !join.disabled) join.click(); };
    setTimeout(() => input.focus(), 60);

    ui.card.querySelector('[data-act="skip"]').onclick = () => {
      track("invite_declined", { at });
      ui.close();
    };
    join.onclick = () => {
      const email = input.value.trim();
      // identify() is what turns an anonymous funnel into a reachable lead.
      if (window.posthog && window.posthog.identify) {
        window.posthog.identify(email, { email, side: SIDE });
      }
      track("email_submitted", { at });
      const safe = email.replace(/[<>&"]/g, "");
      ui.card.innerHTML = `
        <h2>You are on the list</h2>
        <p>We will mail <strong>${safe}</strong> when Swiff opens up.</p>
        <div class="sw-row"><button class="btn btn-primary" data-act="done">Back to the prototype</button></div>`;
      ui.card.querySelector('[data-act="done"]').onclick = ui.close;
      o.onDone && o.onDone(email);
    };
  }

  // ----------------------------------------------------------------- exports

  window.swiff = { track, step, steamConnect, captureEmail, onSteam, side: SIDE, profile: null };

  // Time on page is the cheapest engagement signal we get for free.
  const t0 = Date.now();
  track("page_view", { path: location.pathname });
  resumeSteam().catch((e) => console.error("[swiff] steam resume failed", e));
  addEventListener("pagehide", () => {
    track("page_exit", { seconds: Math.round((Date.now() - t0) / 1000) });
  });
})();
