import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*",
  "apps/*",
  {
    test: {
      name: "integration",
      root: "./tests/integration",
    },
  },
  {
    test: {
      name: "conformance",
      root: "./tests/conformance",
    },
  },
]);
