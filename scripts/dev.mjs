import { realpathSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const enteredPath = process.cwd();
const projectPath = realpathSync.native(enteredPath);

if (enteredPath !== projectPath) {
  rmSync(join(projectPath, ".next"), { recursive: true, force: true });
  console.log(`Normalized project path to ${projectPath}`);
}

process.chdir(projectPath);

const next = spawn(
  process.execPath,
  [join(projectPath, "node_modules", "next", "dist", "bin", "next"), "dev", "--webpack"],
  { cwd: projectPath, env: { ...process.env, INIT_CWD: projectPath }, stdio: "inherit" },
);

next.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
