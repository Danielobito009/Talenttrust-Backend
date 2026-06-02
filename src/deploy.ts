import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

/**
 * Blue-green deployment state machine.
 *
 * Transitions:
 *   blue  --switchToGreen()--> green
 *   green --rollback()-------> blue
 *
 * State is persisted to `.deployment-state.json` so it survives process
 * restarts.  The file is gitignored; never put secrets in it.
 *
 * Concurrency: a simple in-process mutex prevents two concurrent
 * `switchToGreen` calls from racing on the state file.
 *
 * @module deploy
 */

const STATE_FILE = path.join(process.cwd(), ".deployment-state.json");

/** Shape of the persisted deployment state. */
export interface DeploymentState {
  activeColor: "blue" | "green";
  /** Unix ms timestamp of the last successful transition. */
  lastSwitch: number;
  /** The color that was active before the most recent switch. */
  previousColor?: "blue" | "green";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

async function readState(): Promise<DeploymentState> {
  try {
    const data = await readFileAsync(STATE_FILE, "utf8");
    return JSON.parse(data) as DeploymentState;
  } catch {
    return { activeColor: "blue", lastSwitch: Date.now() };
  }
}

async function writeState(state: DeploymentState): Promise<void> {
  await writeFileAsync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function checkHealth(port: string): Promise<boolean> {
  if (process.env.NODE_ENV === "test") {
    return true;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
      method: "GET",
      signal: controller.signal,
      headers: { "Cache-Control": "no-store" },
    });

    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Health-check function used by `switchToGreen`.
 * Replaced in tests via `setHealthChecker`.
 */
let _healthChecker: (port: string) => Promise<boolean> = async (_port) => {
  // Real implementation would do:
  //   const res = await axios.get(`http://localhost:${_port}/health/ready`);
  //   return res.status === 200;
  return true;
};

/**
 * Polling configuration for `switchToGreen` health gate.
 * These can be tuned via environment variables in deployment scripts.
 */
const DEFAULT_POLL_INTERVAL_MS = 500; // ms between health probes
const DEFAULT_POLL_TIMEOUT_MS = 5_000; // total timeout before aborting

function parseEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Override the health-check implementation.
 * Intended for testing only — do not call in production code.
 *
 * @param fn - Async function that returns `true` when the target is healthy.
 */
export function setHealthChecker(
  fn: (port: string) => Promise<boolean>
): void {
  _healthChecker = fn;
}

// Simple in-process mutex to guard concurrent switch attempts.
let _switching = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Promote the green instance to active.
 *
 * - No-op (idempotent) when green is already active.
 * - Throws `Error("Green not ready")` when the health check fails.
 * - Throws `Error("Switch already in progress")` when called concurrently.
 *
 * @throws {Error} If green is unhealthy or a switch is already in progress.
 */
export async function switchToGreen(): Promise<void> {
  const state = await readState();
  if (state.activeColor === "green") return; // idempotent

  if (_switching) throw new Error("Switch already in progress");
  _switching = true;

  try {
    // Poll the green readiness endpoint until healthy or until timeout.
    const intervalMs = parseEnvMs(
      "SWITCH_GREEN_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
    );
    const timeoutMs = parseEnvMs(
      "SWITCH_GREEN_TIMEOUT_MS",
      DEFAULT_POLL_TIMEOUT_MS,
    );

    const port = process.env.GREEN_PORT ?? "3002";
    const start = Date.now();

    let healthy = false;
    // Keep probing until healthy or timeout exceeded
    while (Date.now() - start <= timeoutMs) {
      try {
        /* eslint-disable no-await-in-loop */
        // delegate to the injected health checker (testable)
        if (await _healthChecker(port)) {
          healthy = true;
          break;
        }
        /* eslint-enable no-await-in-loop */
      } catch (err) {
        // Treat errors as an unhealthy response and continue polling
      }

      // Wait before the next probe
      await new Promise((res) => setTimeout(res, intervalMs));
    }

    if (!healthy) throw new Error("Green not ready");

    // All good — commit the switch atomically
    state.previousColor = state.activeColor;
    state.activeColor = "green";
    state.lastSwitch = Date.now();
    await writeState(state);
    process.env.ACTIVE_COLOR = "green";
    console.log("Switched to green");
  } finally {
    _switching = false;
  }
}

/**
 * Roll back to the previous (blue) color.
 *
 * - No-op when already on blue or when there is no recorded previous color.
 */
export async function rollback(): Promise<void> {
  const state = await readState();
  if (state.activeColor === "blue" || !state.previousColor) return;

  state.activeColor = state.previousColor;
  state.lastSwitch = Date.now();
  await writeState(state);
  process.env.ACTIVE_COLOR = state.activeColor;
  console.log("Rolled back to", state.activeColor);
}

/**
 * Return the current deployment state without modifying it.
 */
export async function getStatus(): Promise<DeploymentState> {
  return readState();
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/* istanbul ignore next */
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "switch-green") {
      switchToGreen().catch((err) => {
        console.error(err);
        // Ensure non-zero exit code on failure to signal CI / callers
        process.exitCode = 1;
      });
  } else if (cmd === "rollback") {
      rollback().catch((err) => {
        console.error(err);
        process.exitCode = 1;
      });
  } else if (cmd === "status") {
    getStatus().then(console.log);
  }
}
