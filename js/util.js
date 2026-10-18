export const $ = (selector, root = document) => root.querySelector(selector);

export const now = () => Math.floor(Date.now() / 1000);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") Object.assign(node.style, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

export const hexToBytes = hex => Uint8Array.from(hex.match(/../g), b => parseInt(b, 16));
export const bytesToHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

export const isHttps = url => typeof url === "string" && /^https:\/\/\S+$/i.test(url);
export const isSafeImage = url => isHttps(url) || /^data:image\//.test(url || "");
