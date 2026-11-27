import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const endpoint = 'https://www.adafruit.com/api/products';
const outputDir = resolve(process.argv[2] || '.research/adafruit');
const imagesDir = join(outputDir, 'images');
const concurrency = Math.max(1, Math.min(8, Number(process.env.ADAFRUIT_IMAGE_CONCURRENCY) || 4));

await mkdir(imagesDir, { recursive: true });
const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
if (!response.ok) throw new Error(`Adafruit product feed returned HTTP ${response.status}`);
const products = await response.json();
if (!Array.isArray(products)) throw new Error('Adafruit product feed was not a JSON array.');
await writeFile(join(outputDir, 'products.json'), `${JSON.stringify(products, null, 2)}\n`);

let cursor = 0;
let completed = 0;
let downloaded = 0;
let skipped = 0;
const failures = [];
const localPaths = new Map();

async function download(product) {
  const url = product.product_image;
  if (!url) {
    skipped++;
    return;
  }
  let parsed;
  try { parsed = new URL(url); } catch {
    failures.push({ id: product.product_id, url, error: 'Invalid image URL' });
    return;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('adafruit.com')) {
    failures.push({ id: product.product_id, url, error: 'Image URL is outside Adafruit HTTPS hosts' });
    return;
  }
  const suffix = extname(basename(parsed.pathname)).toLowerCase() || '.jpg';
  const filename = `${String(product.product_id).replace(/[^\w-]/g, '_')}${suffix}`;
  const path = join(imagesDir, filename);
  try {
    await stat(path);
    localPaths.set(String(product.product_id), `images/${filename}`);
    skipped++;
    return;
  } catch {}
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const image = await fetch(parsed, { signal: AbortSignal.timeout(20000) });
      if (!image.ok) throw new Error(`HTTP ${image.status}`);
      const type = image.headers.get('content-type') || '';
      const bytes = Buffer.from(await image.arrayBuffer());
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error(`Unexpected image size: ${bytes.length}`);
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const gif = bytes.subarray(0, 3).toString() === 'GIF';
      const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
      if (!type.startsWith('image/') && !jpeg && !png && !gif && !webp) throw new Error(`Unexpected content type and image signature: ${type || 'missing'}`);
      await writeFile(path, bytes);
      localPaths.set(String(product.product_id), `images/${filename}`);
      downloaded++;
      return;
    } catch (error) {
      if (attempt === 3) failures.push({ id: product.product_id, url, error: String(error.message || error) });
      else await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
}

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= products.length) return;
    await download(products[index]);
    completed++;
    if (completed % 100 === 0 || completed === products.length) {
      const enriched = products.map(product => ({
        ...product,
        local_image: localPaths.get(String(product.product_id)) || null
      }));
      await writeFile(join(outputDir, 'products-with-images.json'), `${JSON.stringify(enriched, null, 2)}\n`);
      await writeFile(join(outputDir, 'image-download-report.json'), `${JSON.stringify({
        endpoint, totalProducts: products.length, completed, downloaded, skipped, failed: failures.length, failures
      }, null, 2)}\n`);
      console.log(`Processed ${completed}/${products.length} products; images downloaded ${downloaded}, skipped ${skipped}, failed ${failures.length}.`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
