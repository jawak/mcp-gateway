/**
 * Backoff + failure tracking (T-06 mechanism, used by T-08 restarts and the
 * T-09 circuit breaker).
 *
 * Rules from the PRD: 3 consecutive probe failures → `down`; 2 consecutive
 * successes → `healthy`; probe interval doubles per failure, capped at 5 minutes.
 */

export type BackoffOptions = { baseMs?: number; maxMs?: number; jitter?: boolean };

/** Exponential backoff with full jitter, so 50 upstreams don't respawn in lockstep. */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
	const baseMs = options.baseMs ?? 1_000;
	const maxMs = options.maxMs ?? 300_000;
	const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
	if (options.jitter === false) return exponential;
	return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

export type HealthState = 'healthy' | 'degraded' | 'down' | 'unconfigured';

const FAILURE_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 2;

/**
 * Small state machine: feed it probe outcomes, it reports the status and when the
 * next probe is allowed. `unconfigured` is terminal until the config changes
 * (an upstream with missing env vars must not be hammered).
 */
export class FailureTracker {
	#state: HealthState;
	#consecutiveFailures = 0;
	#consecutiveSuccesses = 0;
	#nextProbeAt = 0;
	#lastLatencyMs: number | undefined;

	constructor(options: { state?: HealthState } = {}) {
		this.#state = options.state ?? 'healthy';
	}

	get state(): HealthState {
		return this.#state;
	}

	get latencyMs(): number | undefined {
		return this.#lastLatencyMs;
	}

	get consecutiveFailures(): number {
		return this.#consecutiveFailures;
	}

	/** Probe scheduling gate: true when a probe may run now. */
	get due(): boolean {
		return Date.now() >= this.#nextProbeAt;
	}

	get retryAfterMs(): number {
		return Math.max(0, this.#nextProbeAt - Date.now());
	}

	record(input: { ok: boolean; latencyMs?: number; degradedAboveMs?: number }): {
		state: HealthState;
		changed: boolean;
		previous: HealthState;
	} {
		const previous = this.#state;
		this.#lastLatencyMs = input.latencyMs;

		if (input.ok) {
			this.#consecutiveFailures = 0;
			this.#consecutiveSuccesses += 1;
			const degraded =
				input.degradedAboveMs !== undefined &&
				input.latencyMs !== undefined &&
				input.latencyMs > input.degradedAboveMs;
			if (this.#consecutiveSuccesses >= RECOVERY_THRESHOLD || previous !== 'down') {
				this.#state = degraded ? 'degraded' : 'healthy';
			}
			this.#nextProbeAt = 0;
		} else {
			this.#consecutiveSuccesses = 0;
			this.#consecutiveFailures += 1;
			if (this.#consecutiveFailures >= FAILURE_THRESHOLD) this.#state = 'down';
			this.#nextProbeAt = Date.now() + backoffDelayMs(this.#consecutiveFailures);
		}
		return { state: this.#state, changed: previous !== this.#state, previous };
	}

	/** Config changed: forget history so a fixed upstream can recover immediately. */
	reset(state: HealthState = 'healthy'): void {
		this.#state = state;
		this.#consecutiveFailures = 0;
		this.#consecutiveSuccesses = 0;
		this.#nextProbeAt = 0;
	}
}
