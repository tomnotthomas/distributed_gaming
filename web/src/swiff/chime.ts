// The chime when a machine frees up, for renters who turned Interface sounds
// on in Profile. Two soft sine notes made on the spot, so there is no sound
// file to fetch. Silent wherever the browser has no Web Audio.

let context: AudioContext | null = null;

/** Play the "machine frees" chime once. Never throws: a chime is never worth an error. */
export function chime(): void {
  const Audio =
    window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Audio) return;
  try {
    context ??= new Audio();
    // Created before the renter's last gesture, a context can start suspended.
    void context.resume?.();
    const start = context.currentTime;
    for (const [i, hz] of [880, 1320].entries()) {
      const at = start + i * 0.12;
      const tone = context.createOscillator();
      const level = context.createGain();
      tone.type = "sine";
      tone.frequency.value = hz;
      level.gain.setValueAtTime(0.0001, at);
      level.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
      level.gain.exponentialRampToValueAtTime(0.0001, at + 0.6);
      tone.connect(level).connect(context.destination);
      tone.start(at);
      tone.stop(at + 0.65);
    }
  } catch {
    // No audio device, or the browser refused: stay quiet.
  }
}
