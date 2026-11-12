import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
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
    ],
  },
});
