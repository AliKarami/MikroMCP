import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://mikromcp.com",
  integrations: [sitemap({ lastmod: new Date(), changefreq: "weekly", priority: 1.0 })],
  build: { inlineStylesheets: "auto" },
});
