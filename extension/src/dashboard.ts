import { backendUrl, DEFAULT_MARKETPLACE, extractProduct, importProductBatch, parseTarget, productCsv, preferredProductImages, type Product, type Target } from "./catalog.js";
import { AccessRestricted, collectBatch, prepareCollection, type BatchItem } from "./batch.js";
import { demoRequest, fixtureProducts, productIdentity, type Job, type SearchResult } from "./demo.js";
import { demoRecord, productTypeTerms } from "./relevance.js";
import marketplaces from "./markets.js";

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const isExtension = Boolean(globalThis.chrome?.runtime?.id) && !new URLSearchParams(location.search).has("demo");
const queryBox = element<HTMLInputElement>("query");
const searchSource = element<HTMLSelectElement>("search-source");
const themeSelect = element<HTMLSelectElement>("theme-select");
const defaultMarket = element<HTMLSelectElement>("default-market");
const defaultLayout = element<HTMLSelectElement>("default-layout");
const layoutToggle = element<HTMLButtonElement>("layout-toggle");
const searchWorkspace = element("search-workspace");
const sidebar = element("sidebar");
const navToggle = element<HTMLButtonElement>("nav-toggle");
const routes = {
  overview: "Overview", catalog: "Product Catalog", search: "AI Search", batch: "Batch Scraper",
  compare: "Compare Products", settings: "Settings",
} as const;
type Route = keyof typeof routes;
let currentRoute: Route = "overview";
let previousSearchRoute: Route = "catalog";
type SearchRoute = "catalog" | "search";
type PageCursor = { params: URLSearchParams; offset: number };
type WorkspaceState = {
  query: string; market: string; source: string; mode: string; results: SearchResult[]; cursor?: PageCursor;
  message: string; error: boolean;
};
let workspaceRoute: SearchRoute | undefined;
const workspaces = new Map<SearchRoute, WorkspaceState>();
let requestRevision = 0;
let returnAfterConnection: Route | undefined;
const connectionStatus = element("connection-status");
const connectionFeedback = element("connection-feedback");
const connectionButton = element<HTMLButtonElement>("test-connection");
const urls = element<HTMLTextAreaElement>("urls");
const urlCount = element("url-count");
const batchProgress = element<HTMLProgressElement>("batch-progress");
const searchMode = element<HTMLSelectElement>("search-mode");
const origin = element<HTMLInputElement>("origin");
const key = element<HTMLInputElement>("api-key");
const market = element<HTMLSelectElement>("market");
const start = element<HTMLButtonElement>("start");
const upload = element<HTMLButtonElement>("upload");
const demo = element<HTMLButtonElement>("demo");
const csv = element<HTMLButtonElement>("csv");
const json = element<HTMLButtonElement>("json");
const importButton = element<HTMLButtonElement>("import");
const importFile = element<HTMLInputElement>("import-file");
const browse = element<HTMLButtonElement>("browse");
const recommend = element<HTMLButtonElement>("recommend");
const batchStatus = element("batch-status");
const searchStatus = element("search-status");
const batchResults = element("batch-results");
const recommendations = element("recommendations");
const retry = element<HTMLButtonElement>("retry");
const queue = element("batch-queue");
const activityList = element("activity-list");
const loadMore = element<HTMLButtonElement>("load-more");
const sort = element<HTMLSelectElement>("sort-results");
const compareToolbar = element("compare-toolbar");
const compareButton = element<HTMLButtonElement>("open-compare");

const compared = new Map<string, Product>();
let displayed: SearchResult[] = [];
let nextPage: PageCursor | undefined;
let batchItems: BatchItem[] = [];
let successfulScrapes = 0;
let failedScrapes = 0;

let products: Product[] = [];

function feedback(target: HTMLElement, message: string, failed = false): void {
  target.textContent = message;
  target.dataset.error = String(failed);
}

element("stat-markets").textContent = String(Object.keys(marketplaces).length);
element("settings").addEventListener("click", () => goTo("settings"));
element("compare-back").addEventListener("click", () => goTo(previousSearchRoute));
element("open-browser-demo").addEventListener("click", () => {
  const demoUrl = new URL(location.href);
  demoUrl.searchParams.set("demo", "1");
  demoUrl.hash = "overview";
  window.open(demoUrl.href, "_blank", "noopener");
});

function preference(name: string, fallback: string): string {
  return localStorage.getItem(`scraper-${name}`) ?? fallback;
}

function savePreference(name: string, value: string): void {
  localStorage.setItem(`scraper-${name}`, value);
}

function applyTheme(value: string): void {
  const theme = value === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  themeSelect.value = theme;
  element<HTMLButtonElement>("theme").textContent = theme === "dark" ? "Light mode" : "Dark mode";
  element("theme").setAttribute("aria-pressed", String(theme === "light"));
  savePreference("theme", theme);
}

function applyLayout(value: string): void {
  const layout = value === "list" ? "list" : "grid";
  recommendations.dataset.layout = layout;
  defaultLayout.value = layout;
  layoutToggle.textContent = layout === "list" ? "Grid view" : "List view";
  layoutToggle.setAttribute("aria-pressed", String(layout === "list"));
  savePreference("layout", layout);
}

applyTheme(preference("theme", "dark"));
applyLayout(preference("layout", "grid"));
themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));
defaultLayout.addEventListener("change", () => applyLayout(defaultLayout.value));
element("theme").addEventListener("click", () => applyTheme(themeSelect.value === "dark" ? "light" : "dark"));
layoutToggle.addEventListener("click", () => applyLayout(defaultLayout.value === "grid" ? "list" : "grid"));

function goTo(route: Route): void {
  if (location.hash === `#${route}`) applyRoute(true);
  else location.hash = route;
}

function applyRoute(focus: boolean): void {
  const fragment = location.hash.slice(1);
  if (fragment === "workspace") return;
  const route = Object.hasOwn(routes, fragment) ? fragment as Route : "overview";
  currentRoute = route;
  for (const page of document.querySelectorAll<HTMLElement>("[data-page]")) page.hidden = page.dataset.page !== route;
  for (const link of sidebar.querySelectorAll<HTMLAnchorElement>("[data-route]")) {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  element("top-title").textContent = routes[route];
  document.title = `${routes[route]} · Product Scraper`;
  searchWorkspace.hidden = route !== "catalog" && route !== "search";
  if (route === "catalog" || route === "search") {
    element(`${route}-slot`).append(searchWorkspace);
    element("search-examples").hidden = route !== "search";
    if (workspaceRoute !== route) {
      if (workspaceRoute) workspaces.set(workspaceRoute, {
        query: queryBox.value, market: market.value, source: searchSource.value, mode: searchMode.value, results: displayed, cursor: nextPage,
        message: searching ? "" : searchStatus.textContent ?? "",
        error: searchStatus.dataset.error === "true",
      });
      requestRevision++;
      resetSearchControls();
      workspaceRoute = route;
      const state = workspaces.get(route);
      queryBox.value = state?.query ?? "";
      market.value = state?.market ?? defaultMarket.value;
      searchSource.value = state?.source ?? (isExtension ? "catalog" : "demo");
      refreshSuggestions();
      searchMode.value = state?.mode ?? (route === "search" ? "semantic" : "browse");
      nextPage = state?.cursor;
      loadMore.hidden = !nextPage;
      renderMatches(state?.results ?? []);
      feedback(searchStatus, state?.message || (route === "catalog"
        ? "Browse saved products or look up a keyword."
        : "Enter a description to search your saved products."), state?.error);
      if (!state && route === "catalog" && (!isExtension || watchedConnection)) void browseCatalog();
    }
    previousSearchRoute = route;
  }
  if (route === "compare") renderComparison();
  if (matchMedia("(max-width: 800px)").matches) {
    document.body.classList.remove("nav-open");
    navToggle.setAttribute("aria-expanded", "false");
  }
  if (focus) {
    const heading = element(`page-${route}`).querySelector("h1");
    heading?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}

navToggle.addEventListener("click", () => {
  const narrow = matchMedia("(max-width: 800px)").matches;
  const toggled = document.body.classList.toggle(narrow ? "nav-open" : "nav-collapsed");
  navToggle.setAttribute("aria-expanded", String(narrow ? toggled : !toggled));
});
window.addEventListener("hashchange", () => applyRoute(true));
let suggestionRevision = 0;
async function refreshSuggestions(): Promise<void> {
  const revision = ++suggestionRevision;
  const examples = element("search-examples");
  examples.replaceChildren();
  const connection = watchedConnection;
  if (isExtension && !connection) return;
  try {
    const params = new URLSearchParams({
      limit: "20", marketplace: market.value || "all", source: searchSource.value,
    });
    const sample = await api<Product[]>(connection ?? await connect(), `/v1/products?${params}`);
    if (revision !== suggestionRevision) return;
    const suggestions = new Set<string>();
    for (const product of sample) {
      const category = product.category;
      const phrase = category && productTypeTerms({ ...product, title: "" }).length ? category : product.title;
      if (phrase.length <= 90) suggestions.add(phrase);
    }
    for (const phrase of [...suggestions].slice(0, 4)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button small";
      button.textContent = phrase;
      button.addEventListener("click", () => {
        clearSearch();
        queryBox.value = phrase;
        searchMode.value = "semantic";
        queryBox.focus();
      });
      examples.append(button);
    }
  } catch {
    // Search remains usable when catalog suggestions are unavailable.
  }
}

urls.addEventListener("input", () => {
  const count = urls.value.split(/\r?\n/).filter((line) => line.trim()).length;
  urlCount.textContent = `${count} / 40`;
  urlCount.dataset.over = String(count > 40);
});
for (const field of [origin, key]) {
  field.addEventListener("input", () => {
    connectionStatus.textContent = "Not connected";
    connectionStatus.dataset.connected = "false";
    feedback(connectionFeedback, "");
  });
}

function setBatchBusy(busy: boolean): void {
  start.disabled = busy || !isExtension;
  demo.disabled = retry.disabled = importButton.disabled = busy;
  upload.disabled = csv.disabled = json.disabled = busy || products.length === 0;
}

function download(content: string, format: "csv" | "json"): void {
  const type = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `amazon-products.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

csv.addEventListener("click", () => download(productCsv(products), "csv"));
json.addEventListener("click", () => download(JSON.stringify(products, null, 2), "json"));

demo.addEventListener("click", async () => {
  setBatchBusy(true);
  batchProgress.hidden = true;
  try {
    products = await fixtureProducts();
    batchItems = [];
    queue.replaceChildren();
    retry.hidden = true;
    batchResults.replaceChildren();
    for (const product of products) addProduct(product);
    feedback(batchStatus, `${products.length} fictional products loaded.`);
  } catch (error) {
    feedback(batchStatus, errorMessage(error), true);
  } finally {
    setBatchBusy(false);
  }
});

market.add(new Option("US · Amazon.com", DEFAULT_MARKETPLACE, true, true));
for (const [code, domain] of Object.entries(marketplaces)) {
  if (code !== DEFAULT_MARKETPLACE) market.add(new Option(`${code} · ${domain}`, code));
}
market.add(new Option("All marketplaces", ""));
for (const option of market.options) defaultMarket.add(option.cloneNode(true) as HTMLOptionElement);
const savedMarket = preference("marketplace", DEFAULT_MARKETPLACE);
market.value = defaultMarket.value = !savedMarket || Object.hasOwn(marketplaces, savedMarket)
  ? savedMarket
  : DEFAULT_MARKETPLACE;
defaultMarket.addEventListener("change", () => {
  market.value = defaultMarket.value;
  savePreference("marketplace", defaultMarket.value);
});

importButton.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  importFile.value = "";
  if (!file) return;
  setBatchBusy(true);
  try {
    if (file.size > 512 * 1024) throw new Error("Choose a JSON file smaller than 512 KB.");
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error("The selected file is not valid JSON.");
    }
    const imported = importProductBatch(data);
    products = imported;
    batchItems = [];
    queue.replaceChildren();
    retry.hidden = batchProgress.hidden = true;
    batchResults.replaceChildren();
    for (const product of imported) addProduct(product, productLink(product)?.href);
    feedback(batchStatus, `${imported.length} unique products imported. Save the batch to index it.`);
  } catch (error) {
    feedback(batchStatus, errorMessage(error), true);
  } finally {
    setBatchBusy(false);
  }
});
if (isExtension) void chrome.storage.local.get("backendOrigin").then(({ backendOrigin }) => {
  if (typeof backendOrigin === "string" && origin.value === origin.defaultValue) origin.value = backendOrigin;
}).catch(() => { /* Connection settings still work without persistence. */ });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}

function productThumbnail(product: Product): HTMLDivElement {
  const frame = document.createElement("div");
  frame.className = "product-thumbnail";
  const placeholder = document.createElement("span");
  placeholder.textContent = "No photo";
  frame.append(placeholder);

  if (/^DEMO0000(?:0[1-9]|10)$/.test(product.asin)) {
    const demoPhoto = document.createElement("span");
    demoPhoto.className = "demo-photo";
    demoPhoto.dataset.product = product.asin;
    if (Number(product.asin.slice(4)) >= 5) demoPhoto.classList.add("demo-hardware");
    demoPhoto.setAttribute("role", "img");
    demoPhoto.setAttribute("aria-label", `Demo image of ${product.title}`);
    frame.replaceChildren(demoPhoto);
    return frame;
  }

  const candidates = preferredProductImages(product.images);
  function showNext(): void {
    const source = candidates.shift();
    if (!source) return;
    const photo = document.createElement("img");
    photo.alt = product.title;
    photo.loading = "lazy";
    photo.decoding = "async";
    photo.referrerPolicy = "no-referrer";
    photo.addEventListener("load", () => {
      if (photo.naturalWidth <= 1 || photo.naturalHeight <= 1) {
        photo.remove();
        showNext();
        return;
      }
      placeholder.remove();
      photo.classList.add("loaded");
    }, { once: true });
    photo.addEventListener("error", () => {
      photo.remove();
      showNext();
    }, { once: true });
    photo.src = source;
    frame.append(photo);
  }
  showNext();
  return frame;
}

function addResult(
  list: HTMLElement, text: string, url?: string, details?: string, product?: Product,
): HTMLLIElement {
  const row = document.createElement("li");
  const title = document.createElement("div");
  title.className = "result-title";
  if (product) {
    row.className = "product-card";
    row.append(productThumbnail(product));
  }
  row.append(title);
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = text;
    title.append(link);
  } else {
    title.textContent = text;
  }
  if (product) {
    const meta = document.createElement("div");
    meta.className = "result-meta";
    const price = document.createElement("strong");
    price.className = "product-price";
    price.textContent = product.price ?? "Price unavailable";
    const marketBadge = document.createElement("span");
    marketBadge.className = "product-market";
    marketBadge.textContent = product.marketplace;
    const signals = document.createElement("small");
    signals.textContent = [product.rating, product.review_count, product.availability].filter(Boolean).join(" · ");
    meta.append(price, marketBadge, signals);
    if (demoRecord(product)) {
      const badge = document.createElement("span");
      badge.className = "product-market demo-badge";
      badge.textContent = "Fictional demo";
      meta.append(badge);
    }
    title.append(meta);
  } else if (details) {
    const metadata = document.createElement("span");
    metadata.className = "result-metadata";
    metadata.textContent = details;
    title.append(metadata);
  }
  list.append(row);
  return row;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function addProduct(product: Product, url?: string): void {
  const row = addResult(batchResults, product.title, url, undefined, product);
  const attributes = [product.asin, product.brand, product.category].filter(Boolean).join(" · ");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Product details";
  const description = document.createElement("p");
  description.textContent = [attributes, product.description].filter(Boolean).join("\n");
  details.append(summary, description);
  for (const [index, imageUrl] of product.images.entries()) {
    const link = document.createElement("a");
    link.href = imageUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `Image ${index + 1}`;
    details.append(link);
  }
  row.append(details);
}

async function readProductHtml(response: Response): Promise<string> {
  if (!response.body) return "";
  const maxBytes = 10 * 1024 * 1024;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Amazon returned a page larger than the 10 MB collection limit.");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

async function scrape(target: Target): Promise<Product> {
  const options = {
    credentials: "omit",
    redirect: "manual",
  } as const;
  const fetchProduct = () => fetch(target.url, { ...options, signal: AbortSignal.timeout(15_000) });
  let response = await fetchProduct();
  if ([500, 502, 504].includes(response.status) && !response.headers.has("Retry-After")) {
    await response.body?.cancel();
    await delay(1500);
    response = await fetchProduct();
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new AccessRestricted("Amazon redirected the request. Open the product link to check access.");
  }
  if ([403, 429, 503].includes(response.status)) {
    throw new AccessRestricted(`Amazon returned HTTP ${response.status}.`);
  }
  if (!response.ok) throw new Error(`Amazon returned HTTP ${response.status}.`);
  const template = document.createElement("template");
  template.innerHTML = await readProductHtml(response);
  try {
    return extractProduct(template.content, target);
  } catch (error) {
    if (errorMessage(error) === "Amazon requested verification.") throw new AccessRestricted(errorMessage(error));
    throw error;
  }
}

type Connection = { url: URL; apiKey: string };

async function connect(): Promise<Connection> {
  if (!isExtension) return { url: new URL(location.href), apiKey: "" };
  const url = backendUrl(origin.value.trim());
  const apiKey = key.value.trim();
  if (!apiKey) {
    returnAfterConnection = currentRoute === "settings" ? undefined : currentRoute;
    goTo("settings");
    throw new Error("Enter the backend API key under Connection.");
  }
  const allowed = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
  if (!allowed) throw new Error("Backend host access was declined.");
  await chrome.storage.local.set({ backendOrigin: url.origin }).catch(() => undefined);
  return { url, apiKey };
}

async function api<T>({ url, apiKey }: Connection, path: string, body?: unknown): Promise<T> {
  if (!isExtension) return await demoRequest(path, body) as T;
  let response: Response;
  try {
    response = await fetch(new URL(path, url), {
    method: body === undefined ? "GET" : "POST",
    credentials: "omit",
    redirect: "error",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(body),
      signal: AbortSignal.timeout(path === "/v1/status" ? 5000 : 60_000),
    });
  } catch {
    throw new Error("Backend did not respond. Check the address and make sure the API is running.");
  }
  if (!response.ok) {
    if (response.status === 401) {
      connectionStatus.textContent = "Not connected";
      connectionStatus.dataset.connected = "false";
    }
    const payload = await response.json().catch(() => null);
    throw new Error(typeof payload?.detail === "string" ? payload.detail : `API returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function pollStatus(connection: Connection): Promise<void> {
  const status = await api<{ mode: string; products: number; recent: Job[] }>(connection, "/v1/status");
  connectionStatus.dataset.connected = "true";
  connectionStatus.textContent = !isExtension ? "Browser demo" :
    status.mode === "gemini" ? "Backend connected" : "Demo connected";
  element("stat-products").textContent = String(status.products);
  element("stat-activity").textContent = status.recent[0]?.status ?? "No batches";
  element("activity-empty").hidden = status.recent.length > 0;
  element("activity-empty").textContent = "No indexing batches yet.";
  activityList.replaceChildren();
  for (const job of status.recent) {
    const item = document.createElement("li");
    const state = document.createElement("strong");
    state.textContent = job.status;
    const summary = document.createElement("small");
    summary.textContent = [job.submitted_at, job.upserted === null ? null : `${job.upserted} indexed`, job.error]
      .filter(Boolean).join(" · ");
    item.append(state, summary);
    activityList.append(item);
  }
  const banner = element("demo-banner");
  const mode = element("mode-status");
  mode.hidden = false;
  mode.textContent = status.mode === "gemini" ? "Gemini" : isExtension ? "Local ranking" : "Browser demo";
  const method = searchMode.querySelector<HTMLOptionElement>('option[value="semantic"]');
  if (method) method.textContent = status.mode === "gemini" ? "Gemini recommendations" : "Local word matches";
  const description = status.mode === "gemini"
    ? "Gemini + ChromaDB semantic search over this saved catalog."
    : isExtension ? "Gemini semantic search is unavailable. Local search matches words in saved listings."
      : "Browser demo with fictional products, simulated indexing, and local word matching.";
  banner.textContent = description;
  element("search-provider").textContent = description;
}

function disconnected(): void {
  connectionStatus.textContent = "Disconnected";
  connectionStatus.dataset.connected = "false";
  element("mode-status").hidden = true;
}

let watchedConnection: Connection | undefined;
let statusRevision = 0;
for (const field of [origin, key]) field.addEventListener("input", () => {
  watchedConnection = undefined;
  statusRevision++;
});

element<HTMLFormElement>("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  connectionButton.disabled = true;
  connectionStatus.textContent = "Connecting…";
  feedback(connectionFeedback, "Checking connection…");
  const revision = statusRevision;
  try {
    connectionStatus.dataset.connected = "false";
    const connection = await connect();
    await pollStatus(connection);
    if (revision !== statusRevision) {
      disconnected();
      return;
    }
    watchedConnection = connection;
    feedback(connectionFeedback, "Connection verified.");
    if (returnAfterConnection) {
      goTo(returnAfterConnection);
      returnAfterConnection = undefined;
    }
    void loadPreview(connection);
    void refreshSuggestions();
    if (returnAfterConnection === undefined && currentRoute === "catalog" && !displayed.length) void browseCatalog();
    if (isExtension) {
      const { pendingBatch } = await chrome.storage.local.get("pendingBatch").catch(() => ({ pendingBatch: undefined }));
      if (pendingBatch?.origin === connection.url.origin && typeof pendingBatch.id === "string") {
        setBatchBusy(true);
        void api<Job>(connection, `/v1/batches/${encodeURIComponent(pendingBatch.id)}`)
          .then((job) => monitorJob(connection, job))
          .catch((error) => feedback(batchStatus, errorMessage(error), true))
          .finally(() => setBatchBusy(false));
      }
    }
  } catch (error) {
    disconnected();
    feedback(connectionFeedback, errorMessage(error), true);
  } finally {
    connectionButton.disabled = false;
  }
});

if (isExtension) {
  let heartbeatRunning = false;
  setInterval(async () => {
    const connection = watchedConnection;
    if (!connection || heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      await pollStatus(connection);
    } catch {
      if (watchedConnection === connection) disconnected();
    } finally {
      if (watchedConnection !== connection && !watchedConnection) disconnected();
      heartbeatRunning = false;
    }
  }, 15_000);
}

function renderBatch(items: BatchItem[]): void {
  queue.replaceChildren();
  for (const item of items) {
    const row = document.createElement("li");
    const badge = document.createElement("span");
    badge.dataset.state = item.state;
    badge.textContent = item.state;
    const label = document.createElement(item.target ? "a" : "span");
    label.textContent = item.target ? `${item.target.marketplace} · ${item.target.asin}` : item.input.slice(0, 120);
    if (label instanceof HTMLAnchorElement && item.target) {
      label.href = item.target.url;
      label.target = "_blank";
      label.rel = "noopener noreferrer";
    }
    row.append(badge, label);
    if (item.message) {
      const message = document.createElement("small");
      message.textContent = item.message;
      row.append(message);
    }
    queue.append(row);
  }
  const completed = items.filter(({ state }) => state !== "queued" && state !== "processing").length;
  batchProgress.max = items.length;
  batchProgress.value = completed;
  batchProgress.hidden = false;
  feedback(batchStatus, `${completed} / ${items.length} processed`);
}

async function runCollection(items: BatchItem[]): Promise<void> {
  setBatchBusy(true);
  const started = performance.now();
  try {
    const origins = [...new Set(items.filter(({ state }) => state === "queued")
      .flatMap(({ target }) => target ? [`${new URL(target.url).origin}/*`] : []))];
    if (origins.length && !await chrome.permissions.request({ origins })) {
      throw new Error("Amazon host access was declined.");
    }
    batchItems = items;
    renderBatch(items);
    await collectBatch(items, async (target) => {
      try {
        const product = await scrape(target);
        element("stat-scrapes").textContent = String(++successfulScrapes);
        return product;
      } catch (error) {
        element("stat-failures").textContent = String(++failedScrapes);
        throw error;
      }
    }, () => renderBatch(items), () => delay(650));
    products = items.flatMap((item) => item.product ? [item.product] : []);
    batchResults.replaceChildren();
    for (const item of items) if (item.product) addProduct(item.product, item.target?.url);
    const failed = items.filter(({ state }) => state === "failed").length;
    const skipped = items.filter(({ state }) => state === "skipped").length;
    retry.hidden = !items.some(({ state, target }) => state === "failed" && target);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    feedback(batchStatus, `${products.length} collected · ${failed} failed · ${skipped} skipped · ${seconds}s`, !products.length);
  } catch (error) {
    feedback(batchStatus, errorMessage(error), true);
  } finally {
    setBatchBusy(false);
  }
}

element<HTMLFormElement>("collect").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    void runCollection(prepareCollection(urls.value));
  } catch (error) {
    feedback(batchStatus, errorMessage(error), true);
  }
});

retry.addEventListener("click", () => {
  void runCollection(batchItems.map((item) => item.state === "failed" && item.target
    ? { ...item, state: "queued", message: undefined }
    : item));
});

upload.addEventListener("click", async () => {
  setBatchBusy(true);
  feedback(batchStatus, "Saving products…");
  try {
    const connection = await connect();
    let job = await api<Job>(connection, "/v1/batches", { products });
    if (isExtension) await chrome.storage.local.set({ pendingBatch: { id: job.id, origin: connection.url.origin } })
      .catch(() => undefined);
    job = await monitorJob(connection, job);
    await pollStatus(connection);
    if (job.status === "completed") {
      void loadPreview(connection);
      void refreshSuggestions();
    }
  } catch (error) {
    feedback(batchStatus, errorMessage(error), true);
  } finally {
    setBatchBusy(false);
  }
});

async function monitorJob(connection: Connection, initial: Job): Promise<Job> {
  let job = initial;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (job.status === "completed" || job.status === "failed") break;
    feedback(batchStatus, `Indexing batch · ${job.status}`);
    await delay(1000);
    job = await api<Job>(connection, `/v1/batches/${job.id}`);
  }
  if (isExtension && (job.status === "completed" || job.status === "failed")) {
    await chrome.storage.local.remove("pendingBatch").catch(() => undefined);
  }
  if (job.status === "failed") throw new Error(job.error || "Catalog batch failed.");
  feedback(batchStatus, job.status === "completed"
    ? `${job.upserted} products saved to the catalog.`
    : `Batch ${job.id} is still running. Its status appears in recent activity.`);
  return job;
}

function renderMatches(results: SearchResult[]): void {
  recommendations.replaceChildren();
  displayed = results;
  const sorted = [...results];
  if (sort.value === "title") sorted.sort((a, b) => a.product.title.localeCompare(b.product.title));
  if (sort.value === "rating") sorted.sort((a, b) => ratingNumber(b.product) - ratingNumber(a.product));
  for (const { product, url, reasons, distance, matched_features, ranking } of sorted) {
    const domain = marketplaces[product.marketplace];
    const productUrl = url ?? `https://www.${domain}/dp/${product.asin}`;
    const link = demoRecord(product) ? undefined : parseTarget(productUrl).url;
    const row = addResult(recommendations, product.title, link, undefined, product);
    const explanation = document.createElement("p");
    explanation.textContent = reasons?.slice(1).join(" · ") || product.description || "No description captured.";
    const similar = document.createElement("button");
    similar.type = "button";
    similar.className = "button small similar";
    similar.textContent = "Find similar";
    similar.setAttribute("aria-label", `Find products similar to ${product.title}`);
    similar.addEventListener("click", () => {
      if (searching) return;
      nextPage = undefined;
      loadMore.hidden = true;
      void searchCatalog((connection) =>
        api<SearchResult[]>(connection, `/v1/products/${product.marketplace}/${product.asin}/similar?market=${market.value || "all"}&source=${searchSource.value}`));
    });
    if (reasons || matched_features?.length) {
      const evidence = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Why it matches";
      evidence.append(summary, explanation);
      if (matched_features?.length) {
        const terms = document.createElement("p");
        terms.textContent = `Listing terms · ${matched_features.join(", ")}`;
        evidence.append(terms);
      }
      row.append(evidence);
    } else {
      explanation.className = "product-summary";
      row.append(explanation);
    }
    if (ranking === "gemini" && typeof distance === "number" && Number.isFinite(distance)) {
      const score = document.createElement("p");
      score.className = "score";
      const similarity = Math.max(0, Math.min(1, 1 - distance));
      score.textContent = `Embedding cosine similarity ${similarity < 0.01 ? "<0.01" : similarity.toFixed(2)}`;
      score.title = "1 minus cosine distance. Higher means more similar within this catalog.";
      row.append(score);

    }
    if (ranking === "lexical") {
      const indicator = document.createElement("p");
      indicator.className = "score";
      indicator.textContent = "Local word match";
      row.append(indicator);
    }
    const detail = document.createElement("button");
    detail.type = "button";
    detail.className = "button small";
    detail.textContent = "Details";
    detail.setAttribute("aria-label", `Details for ${product.title}`);
    detail.addEventListener("click", () => openDetails(product));

    const actions = document.createElement("div");
    actions.className = "actions product-actions";
    const selection = document.createElement("label");
    selection.className = "compare-select";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = compared.has(productIdentity(product));
    check.setAttribute("aria-label", `Compare ${product.title}`);
    check.addEventListener("change", () => {
      const id = productIdentity(product);
      if (check.checked && compared.size < 3) {
        compared.set(id, product);
      } else if (!check.checked) {
        compared.delete(id);
      } else {
        check.checked = false;
        updateCompare("Select up to 3 products.");
        return;
      }
      updateCompare();
    });
    selection.append(check, "Compare");
    actions.append(detail, similar, selection);
    row.append(actions);
  }
}

let searching = false;

function resetSearchControls(): void {
  searching = false;
  recommend.disabled = loadMore.disabled = browse.disabled = market.disabled = searchMode.disabled = searchSource.disabled = false;
  recommendations.removeAttribute("aria-busy");
  element("search-loading").hidden = true;
}

async function searchCatalog(
  load: (connection: Connection) => Promise<SearchResult[]>, append = false,
): Promise<void> {
  if (searching) return;
  if (!append) renderMatches([]);
  searching = true;
  const revision = ++requestRevision;
  recommend.disabled = loadMore.disabled = browse.disabled = market.disabled = searchMode.disabled = searchSource.disabled = true;
  feedback(searchStatus, "Searching the catalog…");
  recommendations.setAttribute("aria-busy", "true");
  element("search-loading").hidden = displayed.length > 0;
  try {
    const results = await load(await connect());
    if (revision !== requestRevision) return;
    const combined = append
      ? [...new Map([...displayed, ...results].map((match) => [productIdentity(match.product), match])).values()]
      : results;
    renderMatches(combined);
    loadMore.hidden = nextPage === undefined;
    feedback(searchStatus, combined.length
      ? `${combined.length} ${combined.length === 1 ? "match" : "matches"} · ${market.value || "All marketplaces"}`
      : "No matching products found in this catalog.");
  } catch (error) {
    if (revision !== requestRevision) return;
    const message = errorMessage(error);
    feedback(searchStatus, message.startsWith("Gemini") ? `${message} Keyword search is still available.` : message, true);
  } finally {
    if (revision === requestRevision) resetSearchControls();
  }
}

function ratingNumber(product: Product): number {
  const match = product.rating?.match(/\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(",", ".")) : -1;
}

sort.addEventListener("change", () => renderMatches(displayed));

const PAGE_SIZE = 20;

async function browseCatalog(query?: string): Promise<void> {
  if (searching) return;
  nextPage = undefined;
  loadMore.hidden = true;
  const params = new URLSearchParams();
  params.set("marketplace", market.value || "all");
  params.set("source", searchSource.value);
  if (query) params.set("q", query);
  await loadCatalogPage(params, 0);
}

async function loadCatalogPage(params: URLSearchParams, offset: number): Promise<void> {
  await searchCatalog(async (connection) => {
    const page = new URLSearchParams(params);
    page.set("limit", String(PAGE_SIZE + 1));
    page.set("offset", String(offset));
    const revision = requestRevision;
    const products = await api<Product[]>(connection, `/v1/products?${page}`);
    if (revision === requestRevision) nextPage = products.length > PAGE_SIZE ? { params, offset: offset + PAGE_SIZE } : undefined;
    return products.slice(0, PAGE_SIZE).map((product) => ({ product }));
  }, offset > 0);
}

loadMore.addEventListener("click", () => {
  if (nextPage) void loadCatalogPage(nextPage.params, nextPage.offset);
});
browse.addEventListener("click", () => {
  clearSearch();
  queryBox.value = "";
  searchMode.value = "browse";
  void browseCatalog();
});

element<HTMLFormElement>("search").addEventListener("submit", (event) => {
  event.preventDefault();
  if (searching) return;
  const query = queryBox.value.trim();
  if (searchMode.value === "browse" && !query) {
    void browseCatalog();
    return;
  }
  if (!query) {
    clearSearch();
    feedback(searchStatus, "Enter a product name or description.", true);
    return;
  }
  if (searchMode.value !== "semantic") {
    void browseCatalog(query);
    return;
  }
  nextPage = undefined;
  loadMore.hidden = true;
  void searchCatalog((connection) => api<SearchResult[]>(connection, "/v1/recommendations", {
    query, marketplace: market.value || null, source: searchSource.value,
  }));
});

function clearSearch(): void {
  requestRevision++;
  resetSearchControls();
  nextPage = undefined;
  loadMore.hidden = true;
  renderMatches([]);
  feedback(searchStatus, "");
}

queryBox.addEventListener("input", clearSearch);
searchMode.addEventListener("change", clearSearch);
for (const control of [market, searchSource]) {
  control.addEventListener("change", () => {
    clearSearch();
    void refreshSuggestions();
    if (searchMode.value === "browse" && !queryBox.value.trim()) void browseCatalog();
  });
}

const productAttributes: [string, (product: Product) => string | null][] = [
  ["ASIN", (product) => product.asin],
  ["Marketplace", (product) => product.marketplace],
  ["Price as listed", (product) => product.price],
  ["Rating", (product) => product.rating],
  ["Reviews", (product) => product.review_count],
  ["Availability", (product) => product.availability],
  ["Brand", (product) => product.brand],
  ["Category", (product) => product.category],
  ["Description", (product) => product.description],
];

function productLink(product: Product): HTMLAnchorElement | undefined {
  if (demoRecord(product)) return undefined;
  const domain = marketplaces[product.marketplace];
  if (!domain) return undefined;
  const link = document.createElement("a");
  link.href = parseTarget(`https://www.${domain}/dp/${product.asin}`).url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "View on Amazon";
  return link;
}

function openDetails(product: Product): void {
  const content = element("product-detail-content");
  const heading = document.createElement("h3");
  heading.textContent = product.title;
  const attributes = document.createElement("dl");
  for (const [label, read] of productAttributes) {
    const name = document.createElement("dt");
    const value = document.createElement("dd");
    name.textContent = label;
    value.textContent = read(product) || "Not available";
    attributes.append(name, value);
  }
  const photo = productThumbnail(product);
  photo.classList.add("detail-photo");
  content.replaceChildren(photo, heading, attributes);
  const link = productLink(product);
  if (link) content.append(link);
  element<HTMLDialogElement>("product-detail").showModal();
}

function updateCompare(message?: string): void {
  compareToolbar.hidden = compared.size === 0;
  compareButton.disabled = compared.size < 2;
  feedback(element("compare-status"), message ?? `${compared.size} of 3 selected`, Boolean(message));
}

element("clear-compare").addEventListener("click", () => {
  compared.clear();
  updateCompare();
  renderMatches(displayed);
});

compareButton.addEventListener("click", () => goTo("compare"));

function renderComparison(): void {
  const content = element("comparison-content");
  content.replaceChildren();
  const products = [...compared.values()];
  if (!products.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Select up to three products from the catalog or search results to compare.";
    content.append(empty);
    return;
  }
  const columns = document.createElement("div");
  columns.className = "comparison-grid";
  columns.setAttribute("role", "table");
  columns.setAttribute("aria-label", "Selected listing attributes");
  columns.style.setProperty("--product-count", String(products.length));
  const headings = document.createElement("div");
  headings.className = "comparison-head";
  headings.setAttribute("role", "row");
  const corner = document.createElement("div");
  corner.className = "comparison-corner";
  corner.setAttribute("role", "columnheader");
  corner.textContent = "Product details";
  headings.append(corner);
  for (const product of products) {
    const card = document.createElement("div");
    card.setAttribute("role", "columnheader");
    const title = document.createElement("h2");
    title.textContent = product.title;
    const price = document.createElement("strong");
    price.className = "product-price";
    price.textContent = product.price ?? "Price unavailable";
    const remove = document.createElement("button");
    remove.className = "button small";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${product.title} from comparison`);
    remove.addEventListener("click", () => {
      compared.delete(productIdentity(product));
      updateCompare();
      renderMatches(displayed);
      renderComparison();
      element("compare-back").focus();
    });
    card.append(productThumbnail(product), title, price, remove);
    const link = productLink(product);
    if (link) card.append(link);
    headings.append(card);
  }
  columns.append(headings);
  const sections = new Map([
    ["Marketplace", "Listing"], ["Rating", "Customer feedback"], ["Brand", "Product information"],
  ]);
  const attributes = ["Marketplace", "Price as listed", "Availability", "Rating", "Reviews", "Brand", "Category", "ASIN", "Description"];
  const readers = new Map(productAttributes);
  for (const attribute of attributes) {
    const read = readers.get(attribute);
    if (!read) continue;
    const section = sections.get(attribute);
    if (section) {
      const header = document.createElement("div");
      header.className = "comparison-section";
      header.setAttribute("role", "row");
      const label = document.createElement("strong");
      label.setAttribute("role", "cell");
      label.setAttribute("aria-colspan", String(products.length + 1));
      label.textContent = section;
      header.append(label);
      columns.append(header);
    }
    const row = document.createElement("div");
    row.className = "comparison-row";
    row.setAttribute("role", "row");
    const label = document.createElement("strong");
    label.setAttribute("role", "rowheader");
    label.textContent = attribute;
    row.append(label);
    const values = products.map(read);
    if (new Set(values.filter(Boolean)).size > 1) row.dataset.different = "true";
    for (const value of values) {
      const cell = document.createElement("div");
      cell.setAttribute("role", "cell");
      if (attribute === "Description" && value) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Read description";
        const paragraph = document.createElement("p");
        paragraph.textContent = value;
        details.append(summary, paragraph);
        cell.append(details);
      } else {
        cell.textContent = value || "Not available";
      }
      row.append(cell);
    }
    columns.append(row);
  }
  content.append(columns);
}

async function loadPreview(connection: Connection): Promise<void> {
  const status = element("preview-status");
  try {
    const params = new URLSearchParams({ limit: "4", marketplace: defaultMarket.value || "all", source: isExtension ? "catalog" : "demo" });
    const items = await api<Product[]>(connection, `/v1/products?${params}`);
    const preview = element("catalog-preview");
    preview.replaceChildren();
    for (const product of items) addResult(preview, product.title, productLink(product)?.href, undefined, product);
    status.textContent = items.length ? "" : "No products in the selected marketplace.";
  } catch (error) {
    status.textContent = errorMessage(error);
  }
}

if (!isExtension) {
  element("settings").hidden = true;
  element("connection").hidden = true;
  element("open-browser-demo").hidden = true;
  element("source-field").hidden = true;
  searchSource.value = "demo";
  element("stat-scrapes").textContent = "—";
  element("stat-failures").textContent = "—";
  urls.disabled = true;
  importButton.hidden = true;
  element("url-hint").textContent = "Live Amazon collection is available in the Chrome extension.";
  setBatchBusy(false);
  void connect().then(async (connection) => {
    await pollStatus(connection);
    await loadPreview(connection);
  }).catch((error) => feedback(searchStatus, errorMessage(error), true));
}
navToggle.setAttribute("aria-expanded", String(!matchMedia("(max-width: 800px)").matches));
applyRoute(false);
