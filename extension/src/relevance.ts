import type { Product } from "./catalog.js";

const filler = new Set("a an and best by find for from good great high long me of please show the to top under with".split(" "));
const types = new Set("pc desktop laptop keyboard mouse monitor headphone headset earbud speaker webcam microphone charger hub lamp ssd controller".split(" "));
const aliases: Record<string, string> = {
  pcs: "pc", desktops: "desktop", laptops: "laptop", keyboards: "keyboard", mice: "mouse", mouses: "mouse",
  monitors: "monitor", headphones: "headphone", headsets: "headset", earbuds: "earbud", speakers: "speaker",
  webcams: "webcam", microphones: "microphone", chargers: "charger", hubs: "hub", lamps: "lamp",
  ssds: "ssd", controllers: "controller",
};
const compatible: Record<string, string> = { pc: "desktop", desktop: "pc", headphone: "headset", headset: "headphone", wireless: "bluetooth" };
export const demoRecord = (product: Product) => /^DEMO\d{6}$/.test(product.asin);

export function terms(text: string): string[] {
  const words = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => !filler.has(word)).map((word) => aliases[word] ?? word))];
}

export function evidence(query: string[], product: Product) {
  const identity = new Set(terms([product.title, product.category, product.brand].filter(Boolean).join(" ")));
  const description = new Set(terms(product.description));
  let identityMatches = 0;
  const matched = query.flatMap((term) => {
    const alias = compatible[term] ?? term;
    if (identity.has(term) || identity.has(alias)) {
      identityMatches++;
      return [identity.has(term) ? term : alias];
    }
    return !types.has(term) && (description.has(term) || description.has(alias))
      ? [description.has(term) ? term : alias]
      : [];
  });
  return { matched, identityMatches, relevant: query.length > 0 && matched.length === query.length && identityMatches > 0 };
}

export function productTypeTerms(product: Product): string[] {
  const category = terms(product.category || "").filter((term) => types.has(term));
  return category.length ? category : terms(product.title).filter((term) => types.has(term));
}
