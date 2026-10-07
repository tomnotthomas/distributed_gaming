// Adds the DOM matchers (toBeInTheDocument, toHaveTextContent, …) to expect.
// Importing it here also registers the type augmentation for the whole project,
// because tsconfig includes everything under src/.
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// React Testing Library does not auto-clean when globals are off.
afterEach(cleanup);

// Most screens are tested on the paid marketplace, as the server serves them
// with PAID_GAMING=on (features.ts); the crews-only tests take the switch out.
import { beforeEach } from "vitest";
import { setPaidGaming } from "./features";

beforeEach(() => setPaidGaming(true));
