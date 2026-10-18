const DB_NAME = "kalimat";
const STORE = "vault";
const DEVICE_KEY = "device-key";
const SECRET = "secret";

const enc = new TextEncoder();
const dec = new TextDecoder();

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function getDeviceKey() {
  const existing = await run("readonly", s => s.get(DEVICE_KEY));
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  await run("readwrite", s => s.put(key, DEVICE_KEY));
  return key;
}

export async function saveSecret(secretHex) {
  const key = await getDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(secretHex));
  await run("readwrite", s => s.put({ iv, c: new Uint8Array(cipher) }, SECRET));
}

export async function loadSecret() {
  const record = await run("readonly", s => s.get(SECRET));
  if (!record) return null;
  const key = await run("readonly", s => s.get(DEVICE_KEY));
  if (!key) {
    await clearSecret();
    return null;
  }
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, key, record.c);
    return dec.decode(plain);
  } catch {
    await clearSecret();
    return null;
  }
}

export async function clearSecret() {
  await run("readwrite", s => s.delete(SECRET));
  await run("readwrite", s => s.delete(DEVICE_KEY));
                   }
