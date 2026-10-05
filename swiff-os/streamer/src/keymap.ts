// KeyboardEvent.code to the Linux key it is (linux/input-event-codes.h).
//
// The renter sends the physical key, not the character, so this is a fixed
// table with no layout in it: "KeyZ" is the key right of left Shift on every
// keyboard, and the game sees the same key whatever the renter's layout says.
//
// Left out on purpose, so a renter can never send them to the PC:
//
//   Power, Sleep, WakeUp  logind acts on them: the PC would switch off
//   PrintScreen           it is KEY_SYSRQ, and Alt+SysRq+<key> is the kernel's
//                         magic SysRq, which can reboot or kill processes
//   Eject, browser and launcher keys — nothing a game binds, and some start programs
//
// Combinations of mapped keys that act on the PC (Ctrl+Alt+Delete, and the
// console switches Alt+F<n>, Ctrl+Alt+F<n> and Alt+Left/Right) are dropped by
// the sink in uinputEvents.ts, which knows what is held.

// prettier-ignore
const LETTERS: Record<string, number> = {
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
};

// prettier-ignore
const KEYS: Record<string, number> = {
  ...LETTERS,
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
  NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  Lang5: 85, // KEY_ZENKAKUHANKAKU
  IntlBackslash: 86, // KEY_102ND, the extra key on ISO keyboards
  F11: 87, F12: 88,
  IntlRo: 89, Lang3: 90, Lang4: 91, Convert: 92, KanaMode: 93, NonConvert: 94,
  NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106,
  End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
  AudioVolumeMute: 113, AudioVolumeDown: 114, AudioVolumeUp: 115,
  NumpadEqual: 117, Pause: 119, NumpadComma: 121,
  Lang1: 122, Lang2: 123, IntlYen: 124,
  MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
  MediaTrackNext: 163, MediaPlayPause: 164, MediaTrackPrevious: 165, MediaStop: 166,
  F13: 183, F14: 184, F15: 185, F16: 186, F17: 187, F18: 188,
  F19: 189, F20: 190, F21: 191, F22: 192, F23: 193, F24: 194,
};

/** The Linux key code for a physical key, or null for one the PC does not take. */
export function linuxKey(code: string): number | null {
  return Object.hasOwn(KEYS, code) ? KEYS[code]! : null;
}

/** Every key the virtual keyboard can press, for its capability list. */
export const KEYBOARD_KEYS: readonly number[] = [...new Set(Object.values(KEYS))].sort((a, b) => a - b);
