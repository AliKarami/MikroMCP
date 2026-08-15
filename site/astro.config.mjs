import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://mikromcp.com",
  integrations: [
    sitemap({
      lastmod: new Date(),
      changefreq: "weekly",
      priority: 1.0,
      // The llms.txt endpoints are for crawlers that fetch them by convention, not pages to index.
      filter: (page) => !page.includes("/llms"),
    }),
  ],
  build: { inlineStylesheets: "auto" },
});
