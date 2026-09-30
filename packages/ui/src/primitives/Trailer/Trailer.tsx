import type { SyntheticEvent, VideoHTMLAttributes } from "react";

/**
 * Store trailers bookend the footage with studio logos, title cards and rating
 * screens. Playing one from 0 puts a scoreboard or a logo behind the hero copy,
 * which reads as broken art — so play only the middle and loop within it.
 */
const START = 0.25;
const END = 0.7;

/** Short clips have no bookends worth skipping. */
const MIN_DURATION = 20;

const startAt = (video: HTMLVideoElement) => (video.duration > MIN_DURATION ? video.duration * START : 0);

const endAt = (video: HTMLVideoElement) =>
  video.duration > MIN_DURATION ? video.duration * END : video.duration;

/** One encoding of a trailer. `type` lets the browser skip ones it cannot play without fetching them. */
export type VideoSource = { src: string; type?: string };

type Props = Omit<VideoHTMLAttributes<HTMLVideoElement>, "src"> & {
  /** One URL, or encodings in order of preference; the browser plays the first it can. */
  src: string | readonly VideoSource[];
};

/** A muted, looping store trailer that plays only its gameplay middle. */
export function Trailer({ src, ...rest }: Props) {
  // Seeking can throw while the media is still opening; a trailer that will not
  // scrub is a cosmetic loss, never a reason to break the page.
  const seekToGameplay = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    try {
      video.currentTime = startAt(video);
    } catch {
      /* not seekable yet */
    }
  };

  const loopWithinGameplay = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (video.duration && video.currentTime > endAt(video)) seekToGameplay(event);
  };

  return (
    <video
      {...rest}
      src={typeof src === "string" ? src : undefined}
      autoPlay
      muted
      loop
      playsInline
      onLoadedMetadata={seekToGameplay}
      onTimeUpdate={loopWithinGameplay}
    >
      {typeof src === "string" ? null : src.map((s) => <source key={s.src} src={s.src} type={s.type} />)}
    </video>
  );
}
