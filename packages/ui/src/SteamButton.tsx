/**
 * Valve's own "Sign in through Steam" button, as published at
 * https://steamcommunity.com/dev and served from Steam's CDN.
 *
 * Hot-linked rather than vendored on purpose: it stays Valve's asset, byte for
 * byte, and the repo does not redistribute their trademark. The prototype
 * already loads game art and trailers from the same CDN.
 *
 * Their brand rules want the button as shipped, so nothing here re-colours,
 * re-crops or re-draws it. Width and height are explicit so the first-run hero
 * does not shift when the image lands.
 */

const LARGE = {
  src: "https://community.steamstatic.com/public/images/signinthroughsteam/sits_01.png",
  width: 180,
  height: 35,
};

const SMALL = {
  src: "https://community.steamstatic.com/public/images/signinthroughsteam/sits_small.png",
  width: 154,
  height: 23,
};

type Props = {
  /** The server route that redirects to Steam's OpenID endpoint. */
  href?: string;
  /** The 154×23 variant, for the profile's reconnect row. */
  small?: boolean;
  onClick?: () => void;
};

export function SteamButton({ href = "/auth/steam/login", small, onClick }: Props) {
  const art = small ? SMALL : LARGE;
  return (
    <a className="steam-btn" href={href} onClick={onClick}>
      <img
        src={art.src}
        width={art.width}
        height={art.height}
        alt="Sign in through Steam"
        decoding="async"
      />
    </a>
  );
}
