import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";

const markets = JSON.parse(readFileSync(new URL("../marketplaces.json", import.meta.url)));
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { stdio: "inherit" });
cpSync("static", "dist", { recursive: true });
writeFileSync("dist/markets.js", `export default ${JSON.stringify(markets)};\n`);
cpSync("static/dashboard.html", "dist/index.html");
