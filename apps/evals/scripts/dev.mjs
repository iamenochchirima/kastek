import { spawn } from "node:child_process";

const children = [
  spawn("pnpm", ["run", "dev:server"], { stdio: "inherit" }),
  spawn("pnpm", ["run", "dev:web"], { stdio: "inherit" }),
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
for (const child of children) child.on("exit", (code) => {
  if (!stopping) {
    stop();
    process.exitCode = code ?? 1;
  }
});
