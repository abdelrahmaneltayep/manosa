import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

declare module "@remix-run/node" {
  interface Future {
    v3_singleFetch: true;
  }
}

// Shopify's tunnel (cloudflare/ngrok) terminates TLS, so HMR must be told the
// public host/port explicitly or the client tries to reach localhost.
const host = process.env.SHOPIFY_APP_URL
  ? new URL(process.env.SHOPIFY_APP_URL).hostname
  : "localhost";

const hmrConfig =
  host === "localhost"
    ? { protocol: "ws" as const, host: "localhost", port: 64999, clientPort: 64999 }
    : { protocol: "wss" as const, host, port: 443, clientPort: 443 };

export default defineConfig({
  server: {
    allowedHosts: [host],
    port: Number(process.env.PORT ?? 3000),
    hmr: hmrConfig,
    fs: {
      // Let Vite read files from the project root and node_modules.
      allow: ["app", "node_modules", "packages"],
    },
  },
  plugins: [
    remix({
      ignoredRouteFiles: ["**/*.css", "**/*.test.ts", "**/*.test.tsx"],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_lazyRouteDiscovery: true,
        v3_singleFetch: true,
        v3_routeConfig: false,
      },
    }),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/shopify-app-remix/server"],
  },
}) satisfies UserConfig;
