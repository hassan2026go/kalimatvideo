import { NT } from "./nostr.js";
import { bytesToHex, hexToBytes, now } from "./util.js";
import * as vault from "./vault.js";

const LEGACY_NSEC_KEY = "nsec";
const MODE_KEY = "kalimat.auth.mode";

const state = { pubkey: null, secret: null, mode: null, ready: false, error: "" };
const listeners = new Set();

function snapshot() {
  return {
    pubkey: state.pubkey,
    mode: state.mode,
    ready: state.ready,
    error: state.error,
    canSign: state.mode !== null,
    canExportKey: state.mode === "key",
  };
}

function emit() {
  const snap = snapshot();
  listeners.forEach(fn => fn(snap));
}

export const onAuthChange = fn => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getAuth = snapshot;
export const isLoggedIn = () => state.pubkey !== null;

function applyKey(secret) {
  state.secret = secret;
  state.pubkey = NT.getPublicKey(secret);
  state.mode = "key";
  state.error = "";
}

async function migrateLegacyKey() {
  const nsec = localStorage.getItem(LEGACY_NSEC_KEY);
  if (!nsec) return;
  const decoded = NT.nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new Error("مفتاح قديم غير صالح");
  await vault.saveSecret(bytesToHex(decoded.data));
  localStorage.removeItem(LEGACY_NSEC_KEY);
}

export async function init() {
  try {
    await migrateLegacyKey();
    const hex = await vault.loadSecret();
    if (hex) {
      applyKey(hexToBytes(hex));
    } else if (localStorage.getItem(MODE_KEY) === "nip07") {
      await loginWithExtension();
    }
  } catch (err) {
    state.error = err?.message || "تعذّرت استعادة الجلسة";
  } finally {
    state.ready = true;
    emit();
  }
}

export async function createKey() {
  const secret = NT.generateSecretKey();
  await vault.saveSecret(bytesToHex(secret));
  localStorage.removeItem(MODE_KEY);
  applyKey(secret);
  emit();
  return NT.nip19.nsecEncode(secret);
}

export async function importKey(nsec) {
  const decoded = NT.nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") throw new Error("هذا ليس مفتاحاً خاصاً (nsec)");
  await vault.saveSecret(bytesToHex(decoded.data));
  localStorage.removeItem(MODE_KEY);
  applyKey(decoded.data);
  emit();
}

export async function loginWithExtension() {
  if (!window.nostr) throw new Error("لا توجد محفظة NIP-07 في هذا المتصفح");
  const pubkey = await window.nostr.getPublicKey();
  await vault.clearSecret();
  state.pubkey = pubkey;
  state.secret = null;
  state.mode = "nip07";
  state.error = "";
  localStorage.setItem(MODE_KEY, "nip07");
  emit();
}

export async function logout() {
  await vault.clearSecret();
  localStorage.removeItem(MODE_KEY);
  if (state.secret) state.secret.fill(0);
  state.pubkey = null;
  state.secret = null;
  state.mode = null;
  emit();
}

export function exportNsec() {
  if (state.mode !== "key") throw new Error("المفتاح غير متاح في وضع المحفظة الخارجية");
  return NT.nip19.nsecEncode(state.secret);
}

export async function signEvent(template) {
  const draft = { ...template, created_at: template.created_at ?? now() };
  if (state.mode === "key") return NT.finalizeEvent(draft, state.secret);
  if (state.mode === "nip07") return window.nostr.signEvent(draft);
  throw new Error("سجّل الدخول أولاً");
    }
