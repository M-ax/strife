import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const assets = new URL('../src/Strife.Desktop/wwwroot/assets/', import.meta.url);
const svg = await readFile(new URL('favicon.svg', assets), 'utf8');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const browser = await chromium.launch({
  channel: process.env.STRIFE_TEST_BROWSER || 'chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent('<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>' + svg);
  const images = [];
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    images.push(await page.screenshot({ type: 'png', omitBackground: true }));
  }

  // Windows ICO directory followed by one PNG image per resolution.
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  await writeFile(new URL('strife.ico', assets), Buffer.concat([header, ...images]));
  await page.setViewportSize({ width: 1024, height: 1024 });
  await writeFile(new URL('strife.png', assets), await page.screenshot({ type: 'png', omitBackground: true }));
  console.log('Generated Windows icon at ' + sizes.join(', ') + ' pixels.');
} finally {
  await browser.close();
}
