export function createConcurrencyGate(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  let active = 0;
  return {
    tryAcquire() {
      if (active >= limit) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      };
    },
    active: () => active,
  };
}

// formData() may hold the multipart file in memory. Keep the single-node
// runtime from parsing an unbounded number of 50 MB videos concurrently.
export const uploadConcurrencyGate = createConcurrencyGate(2);
