import { Command } from "commander";
import { createRequire } from "module";
import { runServe } from "./serve.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

export const program = new Command()
  .name("mikromcp")
  .description("MikroTik RouterOS MCP server")
  .version(version);

program
  .command("serve", { isDefault: true })
  .description("Start the MCP server (default)")
  .action(runServe);

program.command("doctor").description("Check config, connectivity, and permissions").action(runDoctor);

program.command("init").description("Interactive setup wizard").action(runInit);
