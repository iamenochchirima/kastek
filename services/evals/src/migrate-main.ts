import "dotenv/config";
import { migrate } from "./migrate.js";

const url = process.env.EVALS_DATABASE_URL;
if (!url) throw new Error("EVALS_DATABASE_URL is required");
await migrate(url);
process.stdout.write("Evaluation control-plane schema ready\n");
