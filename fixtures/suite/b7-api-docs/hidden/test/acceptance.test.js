import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import './api.test.js';
const expected = {
  "package.json": "af430440a22f5c1367f7001d59af8e928d4d546a4fe6966c0726fa15b0c7b8b0",
  "src/response.js": "eeaa94f23868cf58fecc8107050dd604cd22d0674e7845ec6ab1a2ee00657e67",
  "src/store.js": "4d1b1f07a6759d29b2a35e79e1a8a63b09ae27af4ba8719b562202d5f1a5b1ec",
  "src/router.js": "e5f1be6e1d0ec58f1a33e2f63a4414517ea081ca99e808be88b1846a66b8affb",
  "src/middleware.js": "7cf624c179f863dea0a7ef683c29f245e1150297cea4461fd327c494554cb1a9",
  "src/items.js": "4cb7b2a4121405c81eb9991c1b3110f0f2434c8f333a8f90210da60e121914a0",
  "src/health.js": "7a2e1c9faddb2ba52b8b6a917833e7b8be8cab01ae95672c330aa018bf25236b",
  "src/static.js": "e50362dbffe3e3aa7d5b978a7d26d1ff2cb6a4dbb21a7aca55f0b4b94772ecd2",
  "src/app.js": "66a15c85e66a43387fe933138fc7251b739b22aaa73b86dddd4c2e90af9e4048",
  "src/server.js": "d33a9471cef766b924b97a30b163ab1e08552823499319c0e3d2b067de3ff7db",
  "public/index.html": "94eaf3aea9ddd07738f4886b9b06f96c6696aca9b023d53a1bbe0e3a217f5c15",
  "public/help/guide.txt": "d64bb74a7d2dd8f4fe8ec8dd21fc248d8bb1e76a224e482a6f2c1f3b4e265832",
  "test/helpers.js": "51aafc83ea62a3b3203f69802b7cacd7a5ac3e12a18a8c6be7c4c45fc6746d87",
  "test/api.test.js": "ba55bbbea6a61a29ff16fc798b6a9c26c481d17b84eb00c410b307320d5e68a5"
};
test('documentation leaves existing project files unchanged', async () => {
  for (const [path, hash] of Object.entries(expected)) {
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash, path);
  }
});
