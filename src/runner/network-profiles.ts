import type { Network } from "../persona/schema.ts";

export interface NetworkProfile {
  downloadBps: number;
  uploadBps: number;
  latencyMs: number;
  offline: boolean;
}

export const NETWORK_PROFILES: Record<Network, NetworkProfile> = {
  "fast-fiber": {
    downloadBps: 100 * 1024 * 1024 / 8,
    uploadBps: 100 * 1024 * 1024 / 8,
    latencyMs: 10,
    offline: false,
  },
  "home-wifi": {
    downloadBps: 25 * 1024 * 1024 / 8,
    uploadBps: 10 * 1024 * 1024 / 8,
    latencyMs: 30,
    offline: false,
  },
  "fast-3g": {
    downloadBps: 1.6 * 1024 * 1024 / 8,
    uploadBps: 768 * 1024 / 8,
    latencyMs: 150,
    offline: false,
  },
  "slow-3g": {
    downloadBps: 500 * 1024 / 8,
    uploadBps: 500 * 1024 / 8,
    latencyMs: 400,
    offline: false,
  },
  "offline-flaky": {
    downloadBps: 0,
    uploadBps: 0,
    latencyMs: 0,
    offline: true,
  },
};
