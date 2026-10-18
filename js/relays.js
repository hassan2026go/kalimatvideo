import { DEFAULT_RELAYS } from "./config.js";

const STORE_KEY = "kalimat.relays";
const LEGACY_STORE_KEY = "relays";
const OPEN = 1;

export const isWss = url => typeof url === "string" && /^wss:\/\/\S+$/.test(url);

export function loadRelayList() {
  try {
    const raw = localStorage.getItem(STORE_KEY) ?? localStorage.getItem(LEGACY_STORE_KEY);
    const saved = JSON.parse(raw || "null");
    const list = Array.isArray(saved) ? saved.filter(isWss) : [];
    if (list.length) return list;
  } catch {}
  return [...DEFAULT_RELAYS];
}

function saveRelayList(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {}
}

export function createRelayPool(initialUrls = loadRelayList()) {
  const sockets = new Map();
  const pending = new Set();
  const retries = new Map();
  const subs = new Map();
  let urls = [...initialUrls];
  let counter = 0;

  const sendTo = (ws, msg) => {
    if (ws.readyState === OPEN) ws.send(msg);
  };

  function route(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const sub = subs.get(msg[1]);
    if (!sub) return;
    if (msg[0] === "EVENT") sub.onEvent?.(msg[2]);
    else if (msg[0] === "EOSE") sub.onEose?.();
  }

  function scheduleRetry(url) {
    if (!urls.includes(url)) return;
    const attempt = (retries.get(url) || 0) + 1;
    retries.set(url, attempt);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    setTimeout(() => connect(url), delay);
  }

  function connect(url) {
    if (!urls.includes(url) || pending.has(url) || sockets.has(url)) return;
    let ws;
    pending.add(url);
    try {
      ws = new WebSocket(url);
    } catch {
      pending.delete(url);
      return scheduleRetry(url);
    }
    ws.onopen = () => {
      pending.delete(url);
      retries.delete(url);
      sockets.set(url, ws);
      for (const [id, sub] of subs) sendTo(ws, JSON.stringify(["REQ", id, ...sub.filters]));
    };
    ws.onmessage = e => route(e.data);
    ws.onclose = () => {
      pending.delete(url);
      sockets.delete(url);
      scheduleRetry(url);
    };
  }

  function subscribe(filters, { onEvent, onEose } = {}) {
    const id = `k${Date.now().toString(36)}${(++counter).toString(36)}`;
    let eosed = false;
    subs.set(id, {
      filters,
      onEvent,
      onEose: () => {
        if (eosed) return;
        eosed = true;
        onEose?.();
      },
    });
    for (const ws of sockets.values()) sendTo(ws, JSON.stringify(["REQ", id, ...filters]));
    return {
      id,
      close() {
        if (!subs.delete(id)) return;
        for (const ws of sockets.values()) sendTo(ws, JSON.stringify(["CLOSE", id]));
      },
    };
  }

  function publish(event) {
    const msg = JSON.stringify(["EVENT", event]);
    let sent = 0;
    for (const ws of sockets.values()) {
      if (ws.readyState === OPEN) {
        ws.send(msg);
        sent++;
      }
    }
    return sent;
  }

  function setRelays(list) {
    const next = [...new Set(list.filter(isWss))];
    for (const [url, ws] of sockets) {
      if (!next.includes(url)) {
        sockets.delete(url);
        ws.close();
      }
    }
    urls = next;
    saveRelayList(next);
    for (const url of next) connect(url);
  }

  for (const url of urls) connect(url);

  return {
    subscribe,
    publish,
    setRelays,
    get urls() { return [...urls]; },
    get connectedCount() { return sockets.size; },
  };
}
