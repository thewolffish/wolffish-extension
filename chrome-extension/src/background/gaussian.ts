const gaussianRandom = (mean: number, stddev: number): number => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return Math.round(mean + z * stddev);
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export const gaussianDelay = (min: number, max: number, mean?: number): number => {
  const center = mean ?? (min + max) / 2;
  const stddev = (max - min) / 4;
  return clamp(gaussianRandom(center, stddev), min, max);
};

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
