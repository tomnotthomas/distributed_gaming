// Adds the DOM matchers (toBeInTheDocument, toHaveTextContent, …) to expect.
// Importing it here also registers the type augmentation for the whole project,
// because tsconfig includes everything under src/.
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// React Testing Library does not auto-clean when globals are off.
afterEach(cleanup);

// jsdom 25 ships no PointerEvent, and Testing Library's fireEvent.pointerDown
// constructs one — so any pointer-driven component is untestable without this.
// MouseEvent already carries `button`, which is the only field we assert on.
if (!("PointerEvent" in globalThis)) {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(globalThis, "PointerEvent", {
    value: PointerEventPolyfill,
    writable: true,
    configurable: true,
  });
}
