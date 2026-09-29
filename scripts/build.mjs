#!/usr/bin/env node
// Packages the extension into dist/ as:
//   - <name>-v<version>.zip  (for the Chrome Web Store, or unzip + "Load unpacked")
//   - <name>-v<version>.crx  (CRX3, signed with an RSA key)
//
// Zero dependencies (Node >= 22.2 for zlib.crc32). The signing key is taken
// from, in order: the CRX_PRIVATE_KEY env var (PEM contents), the file named
// by CRX_KEY_PATH, or ./key.pem. If none exist, a new key is generated and
// saved to ./key.pem (gitignored). The key determines the extension ID, so
// keep it stable and never commit it.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

// Anything matching these never ships in the package.
const EXCLUDE_DIRS = new Set(["dist", "scripts", "node_modules"]);
const EXCLUDE_FILE = (name) =>
  name.startsWith(".") || name.endsWith(".pem") || name.endsWith(".md") || /^package(-lock)?\.json$/.test(name);

function collectFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name.startsWith(".") || (dir === ROOT && EXCLUDE_DIRS.has(name))) continue;
      out.push(...collectFiles(full));
    } else if (!EXCLUDE_FILE(name)) {
      out.push(full);
    }
  }
  return out;
}

// --- ZIP (deflate, fixed timestamps so identical sources give identical bytes) ---

function buildZip(files) {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(relative(ROOT, file).split(sep).join("/"));
    const data = readFileSync(file);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// --- CRX3 (see chromium/src/components/crx_file/crx3.proto) ---

function varint(n) {
  const bytes = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function field(num, payload) {
  return Buffer.concat([varint((num << 3) | 2), varint(payload.length), payload]);
}

function loadPrivateKey() {
  if (process.env.CRX_PRIVATE_KEY?.trim()) return createPrivateKey(process.env.CRX_PRIVATE_KEY);
  const keyPath = resolve(ROOT, process.env.CRX_KEY_PATH || "key.pem");
  if (existsSync(keyPath)) return createPrivateKey(readFileSync(keyPath));

  console.warn(`! No signing key found; generating a new one at ${relative(ROOT, keyPath)}.`);
  console.warn("  The extension ID is derived from this key - keep it safe and reuse it.");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return privateKey;
}

function buildCrx(zip, privateKey) {
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const crxId = createHash("sha256").update(publicKey).digest().subarray(0, 16);
  const signedData = field(1, crxId);

  const lengthLE = Buffer.alloc(4);
  lengthLE.writeUInt32LE(signedData.length);
  const signature = sign(
    "sha256",
    Buffer.concat([Buffer.from("CRX3 SignedData\x00"), lengthLE, signedData, zip]),
    privateKey,
  );

  const header = Buffer.concat([
    field(2, Buffer.concat([field(1, publicKey), field(2, signature)])), // sha256_with_rsa
    field(10000, signedData), // signed_header_data
  ]);

  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "ascii");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);

  // Extension IDs are the first 16 hash bytes written as hex digits mapped 0-f -> a-p.
  const id = [...crxId.toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  return { crx: Buffer.concat([prefix, header, zip]), id };
}

// --- main ---

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const slug = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const base = `${slug}-v${manifest.version}`;

const files = collectFiles(ROOT);
const zip = buildZip(files);
const { crx, id } = buildCrx(zip, loadPrivateKey());

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST);
writeFileSync(join(DIST, `${base}.zip`), zip);
writeFileSync(join(DIST, `${base}.crx`), crx);

console.log(`Packaged ${files.length} files from ${manifest.name} v${manifest.version}`);
console.log(`  dist/${base}.zip`);
console.log(`  dist/${base}.crx  (extension ID: ${id})`);

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `version=${manifest.version}\nbase=${base}\nextension_id=${id}\n`, { flag: "a" });
}
