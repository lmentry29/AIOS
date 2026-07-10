import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*",
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
