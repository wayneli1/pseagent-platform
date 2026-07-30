process.env.PSE_PROBE_CASE = "EC07";
process.env.PSE_PROBE_VARIANT ??= "1";
await import("./probe-live.mts");
