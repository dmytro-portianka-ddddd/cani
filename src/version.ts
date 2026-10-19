/**
 * Version of the deterministic decision engine. Recorded in every decision —
 * the audit trail must be able to reproduce exactly which arithmetic produced
 * a verdict. Same inputs + same engine version = same verdict, forever.
 */
export const ENGINE_VERSION = "0.3.0";
