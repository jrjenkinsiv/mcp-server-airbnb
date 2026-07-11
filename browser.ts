import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export class AirbnbBrowserError extends Error {}

function helperPath() {
  const configured = process.env.AIRBNB_BROWSER_HELPER;
  if (configured?.startsWith("~/")) return join(homedir(), configured.slice(2));
  return configured || join(homedir(), "Development", "homelab-agents", "skills", "trip-planner", "scripts", "airbnb-cdp.mjs");
}

export async function runTripPlanner(input: Record<string, unknown>): Promise<unknown> {
  const endpoint = process.env.AIRBNB_CDP_URL || "http://127.0.0.1:9226";
  const helper = helperPath();
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, "run", "--endpoint", endpoint], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new AirbnbBrowserError("Airbnb trip planning timed out"));
    }, 240000);
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) child.kill("SIGTERM");
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(new AirbnbBrowserError(`Unable to start Airbnb browser helper: ${error.message}`));
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        try {
          const parsed = JSON.parse(stderr.trim().split("\n").at(-1) || "{}");
          reject(new AirbnbBrowserError(parsed.status === "browser_unavailable"
            ? "Airbnb browser unavailable. Launch the dedicated profile and sign in."
            : parsed.error || "Airbnb browser helper failed"));
        } catch {
          reject(new AirbnbBrowserError("Airbnb browser helper failed"));
        }
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new AirbnbBrowserError("Airbnb browser helper returned invalid JSON"));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
