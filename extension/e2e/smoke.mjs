import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const apiKey = process.env.SCRAPER_API_KEY;
const apiOrigin = process.env.SCRAPER_ORIGIN || "http://127.0.0.1:8000";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiOrigin)) throw new Error("Use a loopback Docker backend for browser tests.");
if (!apiKey) throw new Error("Export the API key for the running demo backend before running the browser test.");
const temp = await mkdtemp(join(tmpdir(), "scraper-e2e-"));
const extension = join(temp, "extension");
await cp(new URL("../dist/", import.meta.url), extension, { recursive: true });
const manifestFile = join(extension, "manifest.json");
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*", "https://www.amazon.com/*"];
await writeFile(manifestFile, JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(join(temp, "profile"), {
  channel: "chromium", headless: true, viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/dashboard.html`);
  assert.equal(await page.locator("#market").inputValue(), "US");
  await page.locator("#settings").click();
  await page.locator("#origin").fill(apiOrigin);
  await page.locator("#api-key").fill("invalid");
  await page.locator("#test-connection").click();
  await page.getByText("Missing or invalid API key").waitFor();
  await page.locator("#api-key").fill(apiKey);
  await page.locator("#test-connection").click();
  await page.locator('#connection-status[data-connected="true"]').waitFor();
  const navigate = async (route) => {
    await page.locator(`[data-route="${route}"]`).click();
    await page.locator(`[data-page="${route}"]:visible`).waitFor();
  };
  await page.locator("#theme-select").selectOption("light");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.locator("#theme").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await navigate("overview");
  await page.getByText("No products in the selected marketplace.").waitFor();
  if (process.env.SCRAPER_OVERVIEW_SCREENSHOT) await page.screenshot({ path: process.env.SCRAPER_OVERVIEW_SCREENSHOT, fullPage: true });
  await navigate("batch");

  const attempted = [];
  await page.route("https://m.media-amazon.com/images/*", (route) => {
    const last = new URL(route.request().url()).pathname.split("/").at(-1);
    attempted.push(last);
    if (last === "missing.jpg") return route.fulfill({status: 404});
    return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><rect width="90" height="90" fill="green"/></svg>',
    });
  });
  let fetchCount = 0;
  let allowRetry = false;
  await page.route("https://www.amazon.com/dp/*", (route) => {
    fetchCount++;
    const first = route.request().url().endsWith("B000000001");
    return route.fulfill({
      status: first || allowRetry ? 200 : 429,
      contentType: "text/html",
      body: allowRetry
        ? '<h1 id="productTitle">Fixture without a photo</h1>'
        : '<h1 id="productTitle">Fixture Bluetooth Keyboard</h1><div id="availability"><span>In stock</span></div><img id="landingImage" data-old-hires="https://m.media-amazon.com/images/missing.jpg" src="https://m.media-amazon.com/images/success.svg">',
    });
  });
  await page.locator("#urls").fill("https://amazon.com/dp/B000000001\nhttps://amazon.com/dp/B000000002\nhttps://amazon.com/dp/B000000003");
  await page.locator("#start").click();
  await page.getByText(/1 collected · 1 failed · 1 skipped/).waitFor();
  await page.getByText("Skipped after Amazon restricted access.").waitFor();
  assert.equal(fetchCount, 2);
  await page.locator("#batch-results img.loaded").waitFor();
  assert.deepEqual(attempted, ["missing.jpg", "success.svg"]);
  assert.equal(await page.locator("#batch-progress").getAttribute("value"), "3");
  allowRetry = true;
  await page.locator("#retry").click();
  await page.getByText(/2 collected · 0 failed · 1 skipped/).waitFor();
  await page.locator("#batch-results li").filter({ hasText: "Fixture without a photo" }).getByText("No photo", { exact: true }).waitFor();
  assert.equal(fetchCount, 3);
  for (const format of ["csv", "json"]) {
    const event = page.waitForEvent("download");
    await page.locator(`#${format}`).click();
    assert.equal((await event).suggestedFilename(), `amazon-products.${format}`);
  }
  const badImport = page.waitForEvent("filechooser");
  await page.locator("#import").click();
  await (await badImport).setFiles({
    name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("invalid JSON"),
  });
  await page.getByText("The selected file is not valid JSON.").waitFor();
  const selectedFile = page.waitForEvent("filechooser");
  await page.locator("#import").click();
  await (await selectedFile).setFiles({
    name: "authorized.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify([
      { asin: "B000000001", title: "Import fixture", price: "$19.00" },
      { asin: "B000000001", title: "Updated import fixture", price: "$18.00" },
    ])),
  });
  await page.getByText(/1 unique products imported/).waitFor();
  assert.match(await page.locator("#batch-results").innerText(), /Updated import fixture.*\$18\.00/s);
  await page.locator("#demo").click();
  await page.getByText("10 fictional products loaded.").waitFor();
  assert.equal(await page.locator("#batch-results .demo-photo").count(), 10);
  const asset = await page.evaluate(async () => {
    const photo = document.querySelector(".demo-photo");
    const parsed = getComputedStyle(photo).backgroundImage.match(/url\("(.*)"\)/);
    const response = await fetch(parsed[1]);
    return response.ok && (await createImageBitmap(await response.blob())).width > 200;
  });
  assert.equal(asset, true);
  await page.locator("#upload").click();
  await page.getByText("10 products saved to the catalog.").waitFor();
  await navigate("catalog");
  await page.getByText("No matching products found in this catalog.").waitFor();
  assert.equal(await page.locator("#search-source").inputValue(), "catalog");
  await page.locator("#search-source").selectOption("demo");
  await page.getByText("8 matches · US", { exact: true }).waitFor();
  await page.locator("#search-mode").selectOption("keyword");
  await page.locator("#query").fill("Reading Lamp");
  await page.locator("#market").selectOption("DE");
  await page.locator("#recommend").click();
  await page.getByText("1 match · DE", { exact: true }).waitFor();
  assert.match(await page.locator("#recommendations li").first().innerText(), /Nordlicht USB Reading Lamp/);
  await navigate("search");
  await page.getByText(/Amazon-wide discovery is unavailable/).waitFor();
  await page.locator("#search-source").selectOption("demo");
  await page.getByRole("button", { name: "Gaming PCs", exact: true }).click();
  assert.equal(await page.locator("#query").inputValue(), "Gaming PCs");
  const cases = [
    ["gaming pc", [/Atlas Gaming PC/]],
    ["mechanical keyboard", [/Forge 75 Mechanical Keyboard/]],
    ["astrophotography", []],
    ["wireless headphones", [/Auralite Go/, /Auralite Studio/]],
  ];
  for (const [query, products] of cases) {
    await page.locator("#query").fill(query);
    assert.equal(await page.locator("#recommendations li").count(), 0);
    await page.locator("#recommend").click();
    const count = products.length;
    await page.getByText(count ? `${count} ${count === 1 ? "match" : "matches"} · US` :
      "No matching products found in this catalog.", { exact: true }).waitFor();
    const listings = await page.locator("#recommendations li").allTextContents();
    assert.equal(listings.length, count);
    for (const [index, name] of products.entries()) assert.match(listings[index], name);
  }
  const recommendationsApi = `${apiOrigin}/v1/recommendations`;
  let releaseOlder;
  const olderCanContinue = new Promise((resolve) => { releaseOlder = resolve; });
  await page.route(recommendationsApi, async (route) => {
    if (route.request().postDataJSON().query === "gaming pc") await olderCanContinue;
    await route.continue();
  });
  const isOlder = (request) => request.url() === recommendationsApi && request.postDataJSON()?.query === "gaming pc";
  const olderStarted = page.waitForRequest(isOlder);
  await page.locator("#query").fill("gaming pc");
  await page.locator("#recommend").click();
  await olderStarted;
  await page.locator("#query").fill("mechanical keyboard");
  await page.locator("#recommend").click();
  await page.locator("#recommendations li").filter({ hasText: "Forge 75 Mechanical Keyboard" }).waitFor();
  const olderFinished = page.waitForResponse((response) => isOlder(response.request()));
  releaseOlder();
  await (await olderFinished).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.match(await page.locator("#recommendations").innerText(), /Forge 75 Mechanical Keyboard/);
  assert.equal(await page.locator("#recommendations li").filter({ hasText: "Atlas Gaming PC" }).count(), 0);
  await page.unroute(recommendationsApi);
  await page.locator("#query").fill("");
  await page.locator("#recommend").click();
  await page.getByText("Enter a product name or description.").waitFor();
  assert.equal(await page.locator("#recommendations li").count(), 0);
  await page.locator("#query").fill("wireless headphones");
  await page.locator("#recommend").click();
  await page.getByText("2 matches · US", { exact: true }).waitFor();
  assert.equal(await page.getByText("Local word match", { exact: true }).count(), 2);
  assert.equal(await page.getByText(/cosine similarity/i).count(), 0);
  await page.locator("#recommendations li").first().getByText("Why it matches").click();
  assert.match(await page.locator("#recommendations li").first().innerText(), /Auralite Go.*30-hour battery life/s);
  await page.locator("#layout-toggle").click();
  assert.equal(await page.locator("#recommendations").getAttribute("data-layout"), "list");
  await page.locator("#layout-toggle").click();
  assert.equal(await page.locator("#recommendations .demo-photo").count(), 2);
  await page.locator("#sort-results").selectOption("rating");
  assert.match(await page.locator("#recommendations li").first().innerText(), /Auralite Studio/);
  await page.locator("#sort-results").selectOption("default");
  await navigate("catalog");
  assert.equal(await page.locator("#query").inputValue(), "Reading Lamp");
  await page.getByText("1 match · DE", { exact: true }).waitFor();
  await navigate("search");
  assert.equal(await page.locator("#query").inputValue(), "wireless headphones");
  await page.getByText("2 matches · US", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Compare Auralite Go Wireless Headphones" }).check();
  await page.getByRole("checkbox", { name: "Compare Auralite Studio Wireless Headphones" }).check();
  await page.locator("#open-compare").click();
  await page.locator("#comparison-content .comparison-row[data-different]").first().waitFor();
  assert.match(await page.locator("#comparison-content").innerText(), /\$39\.99.*\$89\.00/s);
  if (process.env.SCRAPER_COMPARE_SCREENSHOT) await page.screenshot({ path: process.env.SCRAPER_COMPARE_SCREENSHOT, fullPage: true });
  await page.locator("#compare-back").click();
  await page.getByRole("button", { name: "Details for Auralite Go Wireless Headphones" }).click();
  await page.locator("#product-detail[open]").waitFor();
  assert.match(await page.locator("#product-detail").innerText(), /30-hour battery life/);
  await page.getByRole("button", { name: "Close product details" }).click();
  if (process.env.SCRAPER_SCREENSHOT) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: process.env.SCRAPER_SCREENSHOT, fullPage: true });
  }
  await page.getByRole("button", { name: "Find products similar to Auralite Go Wireless Headphones" }).click();
  await page.getByText("1 match · US", { exact: true }).waitFor();
  assert.match(await page.locator("#recommendations li").first().innerText(), /Auralite Studio/);
  await page.setViewportSize({ width: 375, height: 780 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  assert.equal(await page.locator("#sidebar").isVisible(), false);
  await page.locator("#nav-toggle").click();
  assert.equal(await page.locator("#sidebar").isVisible(), true);
  await navigate("batch");
  assert.equal(await page.locator(".batch-grid").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length), 1);
  assert.match(await page.locator("#batch-status").innerText(), /products saved/);
  const statusPath = `${apiOrigin}/v1/status`;
  await page.route(statusPath, (route) => route.abort("failed"));
  await page.clock.fastForward(16_000);
  await page.locator("#connection-status").getByText("Disconnected").waitFor();
  await page.unroute(statusPath);
  await page.clock.fastForward(16_000);
  await page.locator('#connection-status[data-connected="true"]').waitFor();
  assert.deepEqual(errors, []);
  console.log("Browser passed authentication, batch progress, restriction handling, CSV/JSON exports, authorized import, sorting, durable upload, filtering, relevance gates, empty states, similar products, connection loss and recovery, and mobile layout.");
  await testBrowserDemo(context);
} finally {
  await context.close();
  await rm(temp, { recursive: true, force: true });
}

async function testBrowserDemo(browserContext) {
  const mime = new Map([
    [".html", "text/html"], [".js", "text/javascript"], [".css", "text/css"],
    [".json", "application/json"], [".jpg", "image/jpeg"], [".woff2", "font/woff2"],
  ]);
  const server = createServer(async (request, response) => {
    const filename = request.url === "/" ? "index.html" : request.url.slice(1);
    if (!/^(?:fonts\/InterVariable\.woff2|[a-z0-9.-]+)$/.test(filename)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(join(extension, filename));
      response.writeHead(200, { "Content-Type": mime.get(filename.slice(filename.lastIndexOf("."))) });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const demoPage = await browserContext.newPage();
  try {
    await demoPage.goto(`http://127.0.0.1:${server.address().port}`);
    await demoPage.locator('#mode-status').getByText("Browser demo").waitFor();
    await demoPage.locator('[data-route="catalog"]').click();
    await demoPage.getByText("8 matches · US", { exact: true }).waitFor();
    assert.equal(await demoPage.locator("#market").inputValue(), "US");
    await demoPage.locator("#market").selectOption("");
    await demoPage.getByText("10 matches · All marketplaces", { exact: true }).waitFor();
    await demoPage.locator('[data-route="batch"]').click();
    await demoPage.locator("#demo").click();
    await demoPage.getByText("10 fictional products loaded.").waitFor();
    await demoPage.locator("#upload").click();
    await demoPage.getByText("10 products saved to the catalog.").waitFor();
    await demoPage.locator('[data-route="catalog"]').click();
    await demoPage.getByText("10 matches · All marketplaces", { exact: true }).waitFor();
    assert.equal(await demoPage.locator("#recommendations .demo-photo").count(), 10);
    await demoPage.getByRole("checkbox", { name: "Compare Auralite Go Wireless Headphones" }).check();
    await demoPage.getByRole("checkbox", { name: "Compare Keyfield Mini Travel Keyboard" }).check();
    await demoPage.locator("#open-compare").click();
    await demoPage.locator("#page-compare:visible .comparison-head").waitFor();
    assert.match(await demoPage.locator("#comparison-content").innerText(), /\$39\.99.*£49\.50/s);
    console.log("Browser-only demo passed catalog, simulated indexing, photos, and cross-currency comparison without API credentials.");
  } finally {
    await demoPage.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
