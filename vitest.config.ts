import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The Containers SDK imports workerd-only modules; stub them for Vitest.
      "cloudflare:workers": fileURLToPath(
        new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
  },
});