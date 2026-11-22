import type { Product } from "./catalog.js";
import { evidence, productTypeTerms, terms } from "./relevance.js";
import marketplaces from "./markets.js";

export interface Job {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  submitted_at: string;
  upserted: number | null;
  error: string | null;
}

export interface SearchResult {
  product: Product;
  url?: string;
  reasons?: string[];
  distance?: number | null;
  ranking?: "lexical" | "gemini";
  matched_features?: string[];
}

export function productIdentity(product: Product): string {
  return `${product.marketplace}:${product.asin}`;
}

export function fixtureRank(catalog: Product[], query: string, marketplace?: string | null, source?: Product): SearchResult[] {
  const requested = terms(query);
  const types = source ? productTypeTerms(source) : [];
  return catalog.filter((product) => (!marketplace || product.marketplace === marketplace) && product !== source)
    .flatMap((product) => {
      const match = types.length
        ? types.map((term) => evidence([term], product)).find((match) => match.relevant)
        : evidence(requested, product);
      return match?.relevant ? [{ product, match }] : [];
    })
    .sort((a, b) => b.match.identityMatches - a.match.identityMatches || a.product.title.localeCompare(b.product.title))
    .map(({ product, match }) => ({
      product, ranking: "lexical", matched_features: match.matched,
      reasons: [product.title, product.description].filter(Boolean),
    }));
}

export async function fixtureProducts(): Promise<Product[]> {
  const response = await fetch(new URL("demo-products.json", window.location.href));
  if (!response.ok) throw new Error("Demo products could not be loaded.");
  return response.json();
}

const saved = new Map<string, Product>();
const jobs = new Map<string, Job>();
let initialCatalog: Promise<void> | undefined;

export async function demoRequest(path: string, body?: unknown): Promise<unknown> {
  initialCatalog ??= fixtureProducts().then((products) => {
    for (const product of products) saved.set(productIdentity(product), product);
  });
  await initialCatalog;
  const url = new URL(path, "http://demo.invalid");
  const products = [...saved.values()];
  if (url.pathname === "/v1/status") {
    return { mode: "demo", products: products.length, recent: [...jobs.values()].reverse().slice(0, 5) };
  }
  if (url.pathname === "/v1/batches") {
    const submitted = (body as { products: Product[] }).products;
    const id = `demo-${jobs.size + 1}`;
    const job: Job = {
      id, status: "queued", submitted_at: new Date().toISOString(), upserted: null, error: null,
    };
    jobs.set(id, job);
    setTimeout(() => {
      job.status = "processing";
      setTimeout(() => {
        const unique = new Map(submitted.map((product) => [productIdentity(product), product]));
        for (const [key, product] of unique) saved.set(key, product);
        job.status = "completed";
        job.upserted = unique.size;
      }, 300);
    }, 150);
    return { ...job };
  }
  const job = /^\/v1\/batches\/([\w-]+)$/.exec(url.pathname);
  if (job) return jobs.get(job[1]);
  if (url.pathname === "/v1/recommendations") {
    const { query, marketplace } = body as { query: string; marketplace: string | null };
    return fixtureRank(products, query, marketplace);
  }
  const similar = /^\/v1\/products\/([A-Z]+)\/([A-Z0-9]{10})\/similar$/.exec(url.pathname);
  if (similar) {
    const source = saved.get(`${similar[1]}:${similar[2]}`);
    if (!source) throw new Error("Product was not found.");
    const market = url.searchParams.get("market");
    return fixtureRank(products, source.category || source.title, market === "all" ? null : market ?? "US", source);
  }
  if (url.pathname === "/v1/products") {
    const selection = url.searchParams.get("marketplace") ?? "US";
    const marketplace = selection === "all" ? null : selection;
    if (marketplace && !marketplaces[marketplace]) return [];
    const query = url.searchParams.get("q");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return products.filter((product) =>
      (!marketplace || product.marketplace === marketplace) && (!query || evidence(terms(query), product).relevant)
    ).slice(offset, offset + limit);
  }
  throw new Error("This operation is unavailable in the browser demo.");
}
