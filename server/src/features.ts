// Product switches the server reads from its environment once, at start, and
// tells the web app and the host app about (GET /api/features, and a meta tag
// in every page of the web app).
//
// PAID_GAMING=on turns on the paid marketplace: the game wall as the app's
// start page, PCs of people you don't know, and everything about earning
// money with your PC. Off, which is the default, Lanterel is crews only: "/"
// is the start page (marketing.ts, createStartPages), signed-in players land
// on their crew, and the host app shows nothing about money.

/** The switches, as GET /api/features answers them. */
export type Features = { paidGaming: boolean };

/** The switches from the environment: each is on only when set to "on". */
export function featuresFromEnv(env: NodeJS.ProcessEnv): Features {
  return { paidGaming: env.PAID_GAMING?.trim().toLowerCase() === "on" };
}

/** The meta tag the web app reads its switches from (web/src/swiff/features.ts). */
export const featuresMeta = (features: Features): string =>
  `<meta name="paid-gaming" content="${features.paidGaming ? "on" : "off"}">`;

/** `html` (the web app's index.html) with the switches in its head. */
export const withFeatures = (html: string, features: Features): string =>
  html.replace("</head>", `${featuresMeta(features)}</head>`);
