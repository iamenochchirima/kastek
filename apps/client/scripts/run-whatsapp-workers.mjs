import { spawn } from "node:child_process";

const workers = [
  ["worker:whatsapp-inbox", "inbox"],
  ["worker:whatsapp-webhook", "webhook"],
];

const children = workers.map(([script, label]) => {
  const child = spawn("pnpm", ["run", script], {
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR || "1",
    },
    cwd: process.cwd(),
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

process.on("SIGINT", () => {
  shutdown();
});

process.on("SIGTERM", () => {
  shutdown();
});
