import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.mikromcp.com",
  integrations: [
    starlight({
      title: "MikroMCP Docs",
      description:
        "Documentation for MikroMCP — an MCP server exposing MikroTik RouterOS as 122 typed, auditable tools for AI assistants.",
      logo: {
        src: "./public/assets/MikroMCP-logo-transparent.png",
        alt: "MikroMCP",
        replacesTitle: false,
      },
      favicon: "/favicon.png",
      customCss: ["./src/styles/custom.css"],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/AliKarami/MikroMCP" },
        { icon: "external", label: "Main site", href: "https://mikromcp.com" },
      ],
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Getting Started", slug: "getting-started" },
            { label: "RouterOS API Setup", slug: "routeros-api-setup" },
            { label: "Configuration", slug: "configuration" },
            { label: "Running", slug: "running" },
          ],
        },
        {
          label: "Connect an assistant",
          items: [
            { label: "Claude Desktop", slug: "connecting-to-claude-desktop" },
            { label: "AI Assistants", slug: "connecting-to-ai-assistants" },
            { label: "Using the Skill", slug: "using-the-skill" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Available Tools", slug: "available-tools" },
            { label: "Architecture", slug: "architecture" },
            { label: "Error Handling", slug: "error-handling" },
            { label: "Security", slug: "security" },
          ],
        },
        {
          label: "Contributing",
          items: [
            { label: "Development", slug: "development" },
            { label: "Contributing", slug: "contributing" },
            { label: "Roadmap", slug: "roadmap" },
          ],
        },
      ],
    }),
  ],
});
