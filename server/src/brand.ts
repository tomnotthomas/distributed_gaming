// The product's name on the public marketing pages, their emails and invite
// texts (marketing.ts): the one place to change it. The pages hold it as a
// token (server/scripts/import-launch-pages.mjs), so a new name needs no new
// import. Code, routes and file names never carry it.

/** The product's name, as people read it. */
export const BRAND = "Lanterel";

/** The name as the logo sets it. */
export const WORDMARK = BRAND.toUpperCase();
