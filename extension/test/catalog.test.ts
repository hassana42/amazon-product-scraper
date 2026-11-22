import assert from "node:assert/strict";
import { test } from "vitest";
import { parseHTML } from "linkedom";
import { backendUrl, extractProduct, parseTarget, planBatch, productCsv, productImageUrls, preferredProductImages, importProductBatch } from "../dist/catalog.js";
import markets from "../dist/markets.js";

const asin = "B000000001";
const target = parseTarget(`https://amazon.com/some-title/gp/product/${asin}?ref=listing`);

test("normalizes product variants across all 19 marketplaces", () => {
  assert.equal(Object.keys(markets).length, 19);
  for (const [marketplace, domain] of Object.entries(markets)) {
    assert.deepEqual(parseTarget(`https://${domain}/gp/aw/d/${asin.toLowerCase()}/ref=test`), {
      marketplace, asin, url: `https://www.${domain}/dp/${asin}`,
    });
  }
  for (const url of [
    `https://www.amazon.com.example.org/dp/${asin}`,
    `http://www.amazon.com/dp/${asin}`,
    `https://user@www.amazon.com/dp/${asin}`,
    `https://www.amazon.com/dp/${asin}X`,
  ]) assert.throws(() => parseTarget(url));
});

test("deduplicates canonical URLs and enforces exactly 40 as the upper limit", () => {
  const lines = Array.from({ length: 40 }, (_, index) =>
    `https://www.amazon.com/dp/B${String(index).padStart(9, "0")}`
  );
  assert.equal(planBatch(lines.join("\n")).length, 40);
  assert.throws(() => planBatch([...lines, lines[0]].join("\n")), /1 to 40/);
  assert.equal(planBatch(`${target.url}\r\n\r\n${target.url}?ref=duplicate`).length, 1);
  assert.throws(() => planBatch(`${target.url}\ninvalid`), /URL 2/);
});

test("extracts product details and keeps locale-formatted display values", () => {
  const { document } = parseHTML(`
    <h1 id="productTitle"> Compact  Keyboard </h1>
    <a id="bylineInfo"> Example Brand </a>
    <div id="corePriceDisplay_desktop_feature_div"><span class="a-offscreen">1.234,56 €</span></div>
    <div id="acrPopover"><span class="a-icon-alt">4,2 sur 5</span></div>
    <a id="acrCustomerReviewText">12 345 avis</a>
    <div id="availability"><span>En stock</span></div>
    <div id="wayfinding-breadcrumbs_feature_div"><ul><li><a>Electronics</a></li></ul></div>
    <img id="landingImage" src="https://m.media-amazon.com/images/example.jpg">
    <div id="productDescription">For traveling</div>
    <ul id="feature-bullets"><li><span class="a-list-item">Bluetooth</span></li></ul>
  `);
  assert.deepEqual(extractProduct(document, target), {
    marketplace: "US", asin, title: "Compact Keyboard", brand: "Example Brand",
    price: "1.234,56 €", rating: "4,2 sur 5", review_count: "12 345 avis",
    availability: "En stock", category: "Electronics", images: ["https://m.media-amazon.com/images/example.jpg"],
    description: "For traveling\nBluetooth",
  });
  const minimal = parseHTML('<h1 id="productTitle">A book</h1>').document;
  assert.equal(extractProduct(minimal, target).price, null);
  assert.throws(() => extractProduct(parseHTML('<input id="captchacharacters">').document, target), /verification/);
  assert.throws(() => extractProduct(parseHTML("<h1>Unavailable</h1>").document, target), /title/);
});

test("allows HTTPS backends and local HTTP only", () => {
  assert.equal(backendUrl("http://127.0.0.1:8000").origin, "http://127.0.0.1:8000");
  assert.equal(backendUrl("https://catalog.example").origin, "https://catalog.example");
  assert.throws(() => backendUrl("http://catalog.example"));
  assert.throws(() => backendUrl("https://catalog.example/prefix"));
});

test("quotes CSV values and neutralizes spreadsheet formulas", () => {
  const product = extractProduct(parseHTML('<h1 id="productTitle">=HYPERLINK("example")</h1>').document, target);
  assert.ok(productCsv([product]).includes(`"'=HYPERLINK(""example"")"`));
});

test("uses Amazon-hosted HTTPS thumbnails and rejects deceptive origins", () => {
  const main = "https://m.media-amazon.com/images/example.jpg";
  const backup = "https://images-na.ssl-images-amazon.com/images/backup.jpg";
  assert.deepEqual(productImageUrls([
    main,
    "https://media-amazon.com.example.org/fake.jpg",
    "https://example.org/private.jpg",
    "http://m.media-amazon.com/insecure.jpg",
    "https://user@m.media-amazon.com/with-user.jpg",
    "https://m.media-amazon.com:444/wrong-port.jpg",
    "not-a-url",
    backup,
  ]), [main, backup]);
});

test("imports authorized US records, validates fields, and deduplicates by market and ASIN", () => {
  const source = { asin: "b000000001", title: "First", price: "$18.99", images: ["http://localhost/photo"] };
  const items = importProductBatch({ products: [source, { ...source, title: "Updated" }, { ...source, marketplace: "DE" }] });
  assert.deepEqual(items.map((item) => [item.marketplace, item.asin, item.title]), [
    ["US", "B000000001", "Updated"], ["DE", "B000000001", "First"],
  ]);
  assert.equal(items[0].price, "$18.99");
  assert.deepEqual(items[0].images, []);
  assert.throws(() => importProductBatch([{ asin: "bad", title: "Bad" }]), /10-character ASIN/);
});

test("uses listing-provided JSON-LD when the visible layout omits product fields", () => {
  const { document } = parseHTML(`<script type="application/ld+json">{
    "@graph":[{"@type":"Product","name":"Fixture Headphones","sku":"${target.asin}",
    "image":"https://m.media-amazon.com/images/example.jpg",
    "offers":{"price":"29.99","priceCurrency":"USD"},"description":"Foldable studio headphones"}]
  }</script>`);
  const product = extractProduct(document, target);
  assert.equal(product.price, "$29.99");
  assert.equal(product.title, "Fixture Headphones");
  assert.deepEqual(product.images, ["https://m.media-amazon.com/images/example.jpg"]);
});

test("prefers larger listing variants and keeps valid fallbacks", () => {
  const images = [
    "https://m.media-amazon.com/images/a._AC_SX75_.jpg",
    "https://m.media-amazon.com/images/a._AC_SL1200_.jpg",
    "https://m.media-amazon.com/images/main.jpg",
  ];
  assert.deepEqual(preferredProductImages(images), [images[1], images[2], images[0]]);
});
