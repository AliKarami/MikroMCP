import { config as loadDotenv } from "dotenv";
import { join } from "node:path";
import { homedir } from "node:os";
import { program } from "./cli/index.js";

loadDotenv({ path: join(homedir(), ".mikromcp", ".env"), override: false });

program.parse();
