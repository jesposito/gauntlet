/**
 * Run `tasks` with at most `concurrency` in flight at a time. Preserves
 * input order in the returned array. Tasks that throw are caught and the
 * rejection propagates (after all in-flight have settled).
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency <= 1 || items.length <= 1) {
    const out: R[] = [];
    for (let i = 0; i < items.length; i++) {
      out.push(await worker(items[i]!, i));
    }
    return out;
  }
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const errors: unknown[] = [];

  async function spawn(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx]!, idx);
      } catch (err) {
        errors.push(err);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => spawn());
  await Promise.all(workers);

  if (errors.length > 0) {
    if (errors.length === 1) throw errors[0];
    const msg = errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
    throw new Error(`${errors.length} task(s) failed: ${msg}`);
  }
  return results;
}
