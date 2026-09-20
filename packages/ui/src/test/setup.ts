// Adds the DOM matchers (toBeInTheDocument, toHaveTextContent, …) to expect.
// Importing it here also registers the type augmentation for the whole project,
// because tsconfig includes everything under src/.
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// React Testing Library does not auto-clean when globals are off.
afterEach(cleanup);
