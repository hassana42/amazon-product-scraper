import marketplaces from "./markets.js";

export const BATCH_SIZE = 40;

export interface Target {
  marketplace: string;
  asin: string;
  url: string;
}

export interface Product {
  marketplace: string;
  asin: string;
  title: string;
  brand: string | null;
  price: string | null;
  rating: string | null;
  review_count: string | null;
  availability: string | null;
  category: string | null;
  images: string[];
  description: string;
}

export function parseTarget(value: string): Target {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^www\./, "");
  const market = Object.entries(marketplaces).find(([, domain]) => domain === hostname);
  const match = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:\/|$)/i);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !market || !match) {
    throw new Error("Use a supported Amazon product URL.");
  }
  const asin = match[1].toUpperCase();
  return { marketplace: market[0], asin, url: `https://www.${market[1]}/dp/${asin}` };
}

export function planBatch(input: string): Target[] {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > BATCH_SIZE) {
    throw new Error("Enter 1 to 40 product URLs, one per line.");
  }
  const targets = new Map<string, Target>();
  lines.forEach((line, index) => {
    try {
      const target = parseTarget(line);
      targets.set(target.url, target);
    } catch {
      throw new Error(`URL ${index + 1} is invalid. Use a supported Amazon product link.`);
    }
  });
  return [...targets.values()];
}

function structuredProduct(root: ParentNode, asin: string): Record<string, unknown> | undefined {
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    const source = script.textContent?.trim();
    if (!source || source.length > 200_000) continue;
    try {
      const value: unknown = JSON.parse(source);
      const records = Array.isArray(value) ? value : [value];
      for (const record of records.flatMap((entry) => [entry, ...(Array.isArray(entry?.["@graph"]) ? entry["@graph"] : [])])) {
        const kinds = Array.isArray(record?.["@type"]) ? record["@type"] : [record?.["@type"]];
        if (!kinds.some((kind) => ["Product", "https://schema.org/Product"].includes(kind))) continue;
        const sku = record.sku;
        if (typeof sku === "string" && /^[a-z0-9]{10}$/i.test(sku) && sku.toUpperCase() !== asin) continue;
        return record;
      }
    } catch { /* Visible product fields remain available if structured metadata is malformed. */ }
  }
  return undefined;
}

function listingText(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim().slice(0, max) || null;
}

function structuredPrice(value: unknown, marketplace: string): string | null {
  const offer = Array.isArray(value) ? value.find((entry) => entry?.price != null) : value;
  if (!offer || typeof offer !== "object" || !("price" in offer) || !("priceCurrency" in offer)) return null;
  const { price, priceCurrency } = offer;
  if (
    (typeof price !== "string" && typeof price !== "number") ||
    !/^\d+(?:\.\d+)?$/.test(String(price)) ||
    typeof priceCurrency !== "string" || !/^[A-Z]{3}$/.test(priceCurrency)
  ) return null;
  if (marketplace === "US" && priceCurrency === "USD") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(price));
  }
  return `${priceCurrency} ${price}`;
}

export function extractProduct(root: ParentNode, target: Target): Product {
  if (root.querySelector("#captchacharacters, form[action*='validateCaptcha']")) {
    throw new Error("Amazon requested verification.");
  }
  const read = (selectors: string, max = 500) => {
    for (const selector of selectors.split(",")) {
      const value = root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim();
      if (value) return value.slice(0, max);
    }
    return null;
  };
  const structured = structuredProduct(root, target.asin);
  const title = read("#productTitle, #title_feature_div h1") ?? listingText(structured?.name);
  if (!title) throw new Error("Product title was unavailable.");

  const features = [...root.querySelectorAll("#feature-bullets li .a-list-item")]
    .map((element) => element.textContent?.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const imageUrls = new Set<string>();
  for (const image of root.querySelectorAll("#landingImage, #imgBlkFront, #altImages img")) {
    let dynamic: string[] = [];
    try {
      const entries = Object.entries(JSON.parse(image.getAttribute("data-a-dynamic-image") || "{}"));
      const area = (value: unknown) => Array.isArray(value) && value.every((part) => typeof part === "number")
        ? (value[0] ?? 0) * (value[1] ?? 0)
        : 0;
      dynamic = entries.sort((a, b) => area(b[1]) - area(a[1])).map(([url]) => url);
    } catch { /* Static image attributes are still available. */ }
    for (const value of [image.getAttribute("data-old-hires"), ...dynamic, image.getAttribute("data-src"), image.getAttribute("src")]) {
      if (!value) continue;
      try {
        const url = new URL(value, target.url);
        if (url.protocol === "https:" && !url.username && !url.password) imageUrls.add(url.href);
      } catch { /* Ignore malformed image URLs. */ }
    }
  }
  const structuredImages = Array.isArray(structured?.image) ? structured.image : [structured?.image];
  for (const entry of structuredImages) {
    const image = typeof entry === "string" ? entry : entry?.url ?? entry?.contentUrl;
    if (typeof image === "string" && productImageUrls([image]).length) imageUrls.add(image);
  }
  return {
    marketplace: target.marketplace,
    asin: target.asin,
    title,
    brand: read("#bylineInfo, #brand"),
    price: read("#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #apex_desktop .a-price .a-offscreen") ?? structuredPrice(structured?.offers, target.marketplace),
    rating: read("#acrPopover .a-icon-alt, #averageCustomerReviews .a-icon-alt"),
    review_count: read("#acrCustomerReviewText, #averageCustomerReviews .totalReviewCount"),
    availability: read("#availability span, #outOfStock"),
    category: read("#wayfinding-breadcrumbs_feature_div li:last-child a"),
    images: productImageUrls([...imageUrls]).slice(0, 12),
    description: [read("#productDescription", 4000) ?? listingText(structured?.description, 4000), ...features].filter(Boolean).join("\n").slice(0, 4000),
  };
}

export function backendUrl(value: string): URL {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("Enter an HTTPS backend origin or an HTTP localhost origin.");
  }
  return url;
}

export function productCsv(products: Product[]): string {
  const headers = [
    "marketplace", "asin", "title", "brand", "price", "rating", "review_count",
    "availability", "category", "images", "description",
  ] as const;
  const quote = (value: string) => {
    const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = products.map((product) => headers.map((field) => {
    const value = product[field];
    return quote(Array.isArray(value) ? JSON.stringify(value) : value ?? "");
  }).join(","));
  return [headers.join(","), ...rows].join("\r\n");
}

export function productImageUrls(images: readonly string[]): string[] {
  const allowedDomains = ["media-amazon.com", "ssl-images-amazon.com", "images-amazon.com"];
  return images.filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.port &&
        allowedDomains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    } catch {
      return false;
    }
  });
}

export const DEFAULT_MARKETPLACE = "US";

export function importProductBatch(value: unknown): Product[] {
  const records = Array.isArray(value) ? value :
    value && typeof value === "object" && "products" in value ? value.products : undefined;
  if (!Array.isArray(records) || records.length === 0 || records.length > BATCH_SIZE) {
    throw new Error("Use a JSON array with 1 to 40 products, or an object with a products array.");
  }
  const unique = new Map<string, Product>();
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Product ${index + 1} must be an object.`);
    }
    const field = (name: string, limit = 500): string | null => {
      const input: unknown = record[name];
      if (input === undefined || input === null) return null;
      if (typeof input !== "string" || input.trim().length > limit) {
        throw new Error(`Product ${index + 1} has an invalid ${name} field.`);
      }
      return input.trim() || null;
    };
    const marketplace = field("marketplace")?.toUpperCase() ?? DEFAULT_MARKETPLACE;
    const asin = field("asin")?.toUpperCase();
    const title = field("title");
    if (!Object.hasOwn(marketplaces, marketplace) || !asin || !/^[A-Z0-9]{10}$/.test(asin) || !title) {
      throw new Error(`Product ${index + 1} needs a supported marketplace, a 10-character ASIN, and a title.`);
    }
    const imageInput: unknown = record.images ?? [];
    if (!Array.isArray(imageInput) || imageInput.length > 12 || imageInput.some((value) => typeof value !== "string")) {
      throw new Error(`Product ${index + 1} can have up to 12 image URLs.`);
    }
    unique.set(`${marketplace}:${asin}`, {
      marketplace, asin, title, images: [...new Set(productImageUrls(imageInput))],
      brand: field("brand"), price: field("price"), rating: field("rating"),
      review_count: field("review_count"), availability: field("availability"), category: field("category"),
      description: field("description", 4000) ?? "",
    });
  }
  return [...unique.values()];
}

export function preferredProductImages(images: readonly string[]): string[] {
  const size = (url: string) => {
    const marker = new URL(url).pathname.match(/(?:^|[._])(?:SL|SX|SY|UL|UX|UY)(\d{2,5})(?=[_.])/i);
    return marker ? Number(marker[1]) : 0;
  };
  return [...new Set(productImageUrls(images))].sort((first, second) => {
    const bucket = (url: string) => {
      const pixels = size(url);
      return pixels >= 300 ? 2 : pixels === 0 ? 1 : 0;
    };
    return bucket(second) - bucket(first) || size(second) - size(first);
  });
}
