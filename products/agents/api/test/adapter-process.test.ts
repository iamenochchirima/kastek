import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { MCP_ADAPTER_LIMITS } from "../src/platform/mcp-adapter";

it.each(["for(;;){}", "const retained=[];for(;;)retained.push(new Array(50000).fill('bounded'))"])("enforces actual process CPU/heap limits while the parent remains responsive", async program => {
  const child = spawn("/usr/bin/prlimit", [`--cpu=${MCP_ADAPTER_LIMITS.cpuSeconds}:${MCP_ADAPTER_LIMITS.cpuSeconds}`, `--as=${MCP_ADAPTER_LIMITS.addressBytes}`, process.execPath, "--jitless", `--max-old-space-size=${MCP_ADAPTER_LIMITS.heapMiB}`, "--max-semi-space-size=4", "--disable-proto=throw", "-e", program], { stdio: "ignore", env: { LANG: "C.UTF-8", TZ: "UTC" } });
  const started = Date.now();
  let ticks = 0; const timer = setInterval(() => ticks++, 10);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { const [code, signal] = await once(child, "close"); expect(code !== 0 || signal).toBeTruthy(); expect(["SIGKILL", "SIGABRT"]).toContain(signal); expect(ticks).toBeGreaterThan(5); expect(Date.now() - started).toBeLessThan(4500); }
  finally { clearInterval(timer); clearTimeout(deadline); child.kill("SIGKILL"); }
}, 7000);
