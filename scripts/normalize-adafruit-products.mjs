#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const researchDir = path.join(root, '.research', 'adafruit');
const feedPath = path.join(researchDir, 'products.json');
const imagesPath = path.join(researchDir, 'products-with-images.json');
const outputPath = path.join(researchDir, 'canvas-import-review.json');
const productFeedUrl = 'https://www.adafruit.com/api/products';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const clean = value => typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
const isUrl = value => /^https?:\/\//i.test(clean(value));

function categoryFor(name) {
  const n = name.toLowerCase();
  if (/\b(microcontroller|arduino|feather|metro|circuitplayground|raspberry pi|esp32|esp8266|development board|dev board|micro:bit|itsybitsy|trinkey|qt py)\b/.test(n)) return 'MICROCONTROLLERS';
  if (/\b(battery|charger|power supply|powerboost|voltage regulator|boost converter|buck converter|solar panel|lipo|li-?ion)\b/.test(n)) return 'POWER SUPPLY';
  if (/\b(motor|servo|solenoid|actuator|relay|speaker|buzzer|led|neopixel|display|lcd|oled|tft|e-?ink|button|switch|joystick|sensor|gps|accelerometer|gyroscope|thermistor|thermocouple|humidity|pressure|distance|rangefinder|ultrasonic|light sensor|touch sensor|driver|transistor|mosfet)\b/.test(n)) return 'MOTOR CONTROL & SENSORS';
  if (/\b(resistor|capacitor|inductor|diode|ic |chip|breakout|cable|connector|breadboard|wire|jumper|header|terminal block|fuse|potentiometer|trimpot|crystal|rtc|memory|flash)\b/.test(n)) return 'MOTOR CONTROL & SENSORS';
  return 'OTHER ELECTRONICS';
}

// This labels likely standalone electronic parts/boards for human review. It
// intentionally does not claim that feed metadata establishes pinout or specs.
function isElectronicComponentCandidate(name) {
  const n = name.toLowerCase();
  if (/\b(kit|book|guide|course|class|workshop|sticker|shirt|hat|mug|plush|toy|case|enclosure|mount|holder|screw|bolt|nut|standoff|tool|plier|cutter|solder|flux|tweezer|storage|organizer|gift card|subscription|download|software|license|replacement parts? pack)\b/.test(n)) return false;
  return /\b(arduino|feather|metro|circuitplayground|raspberry pi|esp32|esp8266|micro:bit|itsybitsy|trinkey|qt py|microcontroller|development board|dev board|breakout|sensor|switch|button|relay|motor|servo|solenoid|speaker|buzzer|led|neopixel|display|lcd|oled|tft|e-?ink|battery|charger|power supply|powerboost|regulator|converter|solar panel|lipo|resistor|capacitor|inductor|diode|transistor|mosfet|integrated circuit|\bic\b|chip|breadboard|jumper|wire|cable|connector|header|terminal block|fuse|potentiometer|trimpot|rtc|gps|accelerometer|gyroscope|thermistor|thermocouple|humidity|pressure|ultrasonic|rangefinder|motor driver|amplifier|audio|rf |antenna|wireless|bluetooth|wifi|wi-?fi|zigbee|nfc|usb.?uart|logic level|level shifter|interface|adapter|expander|multiplexer|current sensor|voltage sensor|touch sensor|light sensor|load cell|encoder|camera|microphone)\b/.test(n);
}

function availability(product) {
  const discontinued = clean(product.discontinue_status);
  if (discontinued && !/^none$/i.test(discontinued)) return { status: 'discontinued', stock: clean(product.product_stock), sourceValue: discontinued };
  if (/^(1|true|yes)$/i.test(clean(product.products_coming_soon))) return { status: 'coming_soon', stock: clean(product.product_stock), sourceValue: 'products_coming_soon' };
  const stock = Number(product.product_stock);
  if (Number.isFinite(stock) && stock > 0) return { status: 'in_stock', stock };
  if (Number.isFinite(stock)) return { status: 'out_of_stock', stock };
  return { status: 'unknown', stock: clean(product.product_stock) };
}

const products = await readJson(feedPath);
if (!Array.isArray(products)) throw new Error('Adafruit products feed must contain a JSON array.');
let imageProducts = [];
try {
  imageProducts = await readJson(imagesPath);
  if (!Array.isArray(imageProducts)) imageProducts = [];
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const imageById = new Map(imageProducts.map(p => [clean(p.product_id), p]));

const records = products.map(product => {
  const productId = clean(product.product_id);
  if (!productId) throw new Error('Product row has no product_id; stable ID cannot be created.');
  const enriched = imageById.get(productId) || {};
  const name = clean(product.product_name) || `Adafruit product ${productId}`;
  const productPage = clean(product.product_url) || `https://www.adafruit.com/product/${encodeURIComponent(productId)}`;
  const remoteImage = isUrl(enriched.product_image) ? clean(enriched.product_image) : isUrl(product.product_image) ? clean(product.product_image) : '';
  const localImagePath = clean(enriched.local_image) || clean(product.local_image);
  const localImage = localImagePath ? path.posix.join('.research/adafruit', localImagePath.replaceAll('\\', '/')) : null;
  const candidateCategory = categoryFor(name);
  const componentCandidate = isElectronicComponentCandidate(name);
  const definitionDraft = componentCandidate ? {
    id: `adafruit-${productId}`,
    name,
    label: name,
    category: candidateCategory,
    icon: '▧',
    iconClass: 'chip',
    subtitle: clean(product.product_mpn) || clean(product.product_model) || 'Adafruit product · pinout research required',
    renderer: 'generic',
    behavior: 'none',
    enabled: false,
    help: 'Draft record from Adafruit product metadata. Pinout has not been verified; research the exact product and manufacturer documentation before wiring or importing.',
    pins: [],
    sources: [{ label: 'Adafruit product page', url: productPage }],
    visual: {
      assetUrl: localImage || '',
      alt: clean(enriched.product_image_alt) || clean(product.product_image_alt) || name,
      imageSource: remoteImage || productPage
    }
  } : null;

  return {
    id: `adafruit-${productId}`,
    productId,
    name,
    model: clean(product.product_model) || null,
    mpn: clean(product.product_mpn) || null,
    manufacturer: clean(product.product_manufacturer) || 'Adafruit',
    productPage,
    availability: availability(product),
    candidateCategory,
    appearsToBeElectronicComponentCandidate: componentCandidate,
    images: { local: localImage, remote: remoteImage || null, alt: clean(enriched.product_image_alt) || clean(product.product_image_alt) || null },
    researchSources: [
      { label: 'Adafruit product page', url: productPage },
      { label: 'Adafruit product feed', url: productFeedUrl }
    ],
    needsPinoutResearch: componentCandidate,
    importable: false,
    publishable: false,
    importExclusionReason: componentCandidate ? 'Pinout is absent from the product feed; verify exact part and terminal map before import.' : 'Not identified as a standalone electronic component candidate.',
    ...(definitionDraft ? { definitionDraft } : {})
  };
});

const candidates = records.filter(record => record.appearsToBeElectronicComponentCandidate);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: { name: 'Adafruit products feed', url: productFeedUrl, file: '.research/adafruit/products.json' },
  imageEnrichment: { file: imageProducts.length ? '.research/adafruit/products-with-images.json' : null, matchedProducts: records.filter(record => record.images.local).length },
  counts: { products: records.length, electronicComponentCandidates: candidates.length, candidatesNeedingPinoutResearch: candidates.filter(record => record.needsPinoutResearch).length, importableDefinitions: records.filter(record => record.importable).length },
  products: records
};
await mkdir(researchDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Products: ${records.length}; component candidates: ${candidates.length}; candidates needing pinout research: ${result.counts.candidatesNeedingPinoutResearch}; importable: ${result.counts.importableDefinitions}`);
