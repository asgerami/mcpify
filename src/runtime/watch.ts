import { ingest, type ParseOptions } from "../parser/openapi.js";
import type { GeneratedServer } from "../types.js";

/**
 * Poll a spec source and fire `onChange` whenever the generated tools differ
 * from the last seen version — the polling half of the "live sync" feature.
 * (A webhook endpoint would call the same reload path; polling needs no inbound
 * connectivity.)
 */

export interface WatchHandle {
  stop(): void;
}

export interface WatchOptions {
  intervalMs: number;
  parse?: ParseOptions;
  /** Baseline to diff against, so the first poll doesn't fire spuriously. */
  seed: GeneratedServer;
  /** Called when a poll fails (network blip, transient bad spec). */
  onError?: (err: unknown) => void;
}

export function watchSpec(
  specSource: string,
  opts: WatchOptions,
  onChange: (next: GeneratedServer) => void | Promise<void>,
): WatchHandle {
  let lastFingerprint = fingerprint(opts.seed);
  let polling = false;

  const tick = async (): Promise<void> => {
    if (polling) return; // skip if a slow poll is still in flight
    polling = true;
    try {
      const next = await ingest(specSource, opts.parse);
      const fp = fingerprint(next);
      if (fp !== lastFingerprint) {
        lastFingerprint = fp;
        await onChange(next);
      }
    } catch (err) {
      opts.onError?.(err);
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(tick, opts.intervalMs);
  // Don't keep the event loop alive solely for the poller.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** Stable signature of the parts of a generated server the runtime depends on. */
function fingerprint(gen: GeneratedServer): string {
  return JSON.stringify({
    baseUrl: gen.baseUrl,
    schemes: gen.securitySchemes,
    tools: gen.tools,
  });
}
