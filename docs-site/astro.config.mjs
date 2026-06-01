import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.mikromcp.com",
  integrations: [
    starlight({
      title: "MikroMCP Docs",
    }),
  ],
});
