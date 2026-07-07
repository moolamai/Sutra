/**
 * @module hlc_clock
 *
 * Hybrid Logical Clock (Kulkarni et al., 2014) — the time authority for
 * every replica in the Hybrid Harness. Produces timestamps that are
 * (a) close to wall time, (b) strictly monotonic per device, and
 * (c) totally ordered across devices, which is exactly what the LWW
 * registers and G-Set keys in the CRDT layer require.
 */

import { compareHLC, encodeHLC, type HLCTimestamp } from "./contract.js";

export class HlcClock {
  private lastPhysical = 0;
  private logical = 0;

  /**
   * @param deviceId - stable, unique per installed edge instance (or "cloud").
   * @param now - injectable time source for deterministic tests.
   */
  constructor(
    private readonly deviceId: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(deviceId)) {
      throw new Error(`invalid deviceId '${deviceId}': must match [A-Za-z0-9_-]{4,64}`);
    }
  }

  /** Issue the next local timestamp. Strictly monotonic per device. */
  tick(): HLCTimestamp {
    const physical = this.now();
    if (physical > this.lastPhysical) {
      this.lastPhysical = physical;
      this.logical = 0;
    } else {
      this.logical++;
    }
    return encodeHLC(this.lastPhysical, this.logical, this.deviceId);
  }

  /**
   * Advance the local clock past an observed remote timestamp so that
   * every event we emit after receiving a message happens-after it.
   */
  observe(remote: HLCTimestamp): void {
    const remotePhysical = Number(remote.slice(0, 15));
    const remoteLogical = Number(remote.slice(16, 22));
    const physical = this.now();
    const maxPhysical = Math.max(physical, remotePhysical, this.lastPhysical);

    if (maxPhysical === this.lastPhysical && maxPhysical === remotePhysical) {
      this.logical = Math.max(this.logical, remoteLogical) + 1;
    } else if (maxPhysical === remotePhysical) {
      this.logical = remoteLogical + 1;
    } else if (maxPhysical === this.lastPhysical) {
      this.logical++;
    } else {
      this.logical = 0;
    }
    this.lastPhysical = maxPhysical;
  }

  /** Latest timestamp issued by this clock, or the genesis sentinel. */
  peek(): HLCTimestamp {
    return encodeHLC(this.lastPhysical, this.logical, this.deviceId);
  }
}

export { compareHLC };
