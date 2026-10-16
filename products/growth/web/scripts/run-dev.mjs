import { spawn } from "node:child_process";

const useTurbopack = /^(1|true|yes)$/i.test(process.env.CLIENT_USE_TURBOPACK || "");
const nextDevArgs = useTurbopack ? ["exec", "next", "dev"] : ["exec", "next", "dev", "--webpack"];

const processes = [
  { cmd: "pnpm", args: nextDevArgs, label: "app" },
];

const children = processes.map(({ cmd, args, label }) => {
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR || "1",
    },
    stdio: ["inherit", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });

  child.on("exit", (code, signal) => {
    if (signal || code) {
      process.exitCode = code || 1;
      shutdown();
    }
  });

  return child;
});

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
