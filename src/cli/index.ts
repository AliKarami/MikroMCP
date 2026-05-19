import { Command } from "commander";
import { runServe } from "./serve.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";

declare const __MIKROMCP_VERSION__: string;

export const program = new Command()
  .name("mikromcp")
  .description("MikroTik RouterOS MCP server")
  .version(__MIKROMCP_VERSION__);

program
  .command("serve", { isDefault: true })
  .description("Start the MCP server (default)")
  .action(runServe);

program.command("doctor").description("Check config, connectivity, and permissions").action(runDoctor);

program.command("init").description("Interactive setup wizard").action(runInit);
