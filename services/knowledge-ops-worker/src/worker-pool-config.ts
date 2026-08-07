export function workerPoolConcurrency(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 16) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}
