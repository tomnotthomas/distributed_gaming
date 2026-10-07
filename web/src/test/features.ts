// The server's paid-gaming switch, as its meta tag in the page (web/src/swiff/features.ts).

/** Put the switch in the page as the server would, on or off. */
export function setPaidGaming(on: boolean): void {
  let meta = document.querySelector('meta[name="paid-gaming"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "paid-gaming");
    document.head.append(meta);
  }
  meta.setAttribute("content", on ? "on" : "off");
}
