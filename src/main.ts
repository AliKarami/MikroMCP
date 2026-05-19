import { config as loadDotenv } from "dotenv";
import { program } from "./cli/index.js";

// Load .env if present (ignore if not found)
loadDotenv({ override: false });

program.parse();
