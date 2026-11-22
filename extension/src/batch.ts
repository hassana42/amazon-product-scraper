import { BATCH_SIZE, parseTarget, type Product, type Target } from "./catalog.js";

export type ItemState = "queued" | "processing" | "succeeded" | "failed" | "skipped";
export type BatchItem = { input: string; target?: Target; state: ItemState; message?: string; product?: Product };

export class AccessRestricted extends Error {}

export function prepareCollection(input: string): BatchItem[] {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > BATCH_SIZE) throw new Error("Enter 1 to 40 product URLs, one per line.");
  const seen = new Set<string>();
  return lines.map((line) => {
    let target: Target;
    try {
      target = parseTarget(line);
    } catch {
      return { input: line, state: "failed", message: "Invalid or unsupported Amazon product link." };
    }
    if (seen.has(target.url)) {
      return { input: line, target, state: "skipped", message: "Duplicate product in this batch." };
    }
    seen.add(target.url);
    return { input: line, target, state: "queued" };
  });
}

export async function collectBatch(
  items: BatchItem[],
  scrape: (target: Target) => Promise<Product>,
  onUpdate: () => void,
  wait: () => Promise<void>,
): Promise<void> {
  const groups = new Map<string, BatchItem[]>();
  for (const item of items) {
    if (item.state !== "queued" || !item.target) continue;
    const market = item.target.marketplace;
    const group = groups.get(market) ?? [];
    group.push(item);
    groups.set(market, group);
  }
  const work = [...groups.values()];
  async function worker(): Promise<void> {
    for (let group = work.shift(); group; group = work.shift()) {
      let restricted = false;
      for (const [index, item] of group.entries()) {
        if (restricted) {
          item.state = "skipped";
          item.message = "Skipped after Amazon restricted access.";
        } else {
          item.state = "processing";
          onUpdate();
          try {
            item.product = await scrape(item.target as Target);
            item.state = "succeeded";
          } catch (error) {
            item.state = "failed";
            item.message = error instanceof Error ? error.message : "Unexpected collection error.";
            restricted = error instanceof AccessRestricted;
          }
        }
        onUpdate();
        if (!restricted && index + 1 < group.length) await wait();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, work.length) }, worker));
}
