import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://mikromcp.com",
  integrations: [sitemap()],
  build: { inlineStylesheets: "auto" },
});
