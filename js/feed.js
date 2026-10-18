import { APP_TAG, KIND, FEED_KINDS } from "./config.js";
import { el, isSafeImage } from "./util.js";
import { NT } from "./nostr.js";

const MAX_CARDS = 200;
const BLOCKED_KEY = "kalimat.blocked";
const SOUND_KEY = "kalimat.sound";
const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp)(?:[?#]|$)/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)(?:[?#]|$)/i;
const URL_RE = /https?:\/\/\S+/g;
const HASHTAG_SPLIT = /(#[\p{L}\p{N}_]+)/u;

const verified = ev => {
  try { return NT.verifyEvent(ev); } catch { return false; }
};

const hasTag = (ev, value) => ev.tags.some(t => t[0] === "t" && t[1] === value);

const formatCount = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

function formatTime(t) {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (d < 60) return "الآن";
  if (d < 3600) return `منذ ${Math.floor(d / 60)} د`;
  if (d < 86400) return `منذ ${Math.floor(d / 3600)} س`;
  return new Date(t * 1000).toLocaleDateString("ar", { day: "numeric", month: "short" });
}

function readSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); }
}

function findMedia(ev) {
  let url = null;
  let mime = "";

  for (const tag of ev.tags) {
    if (tag[0] !== "imeta") continue;
    for (const part of tag.slice(1)) {
      if (part.startsWith("url ") && !url) url = part.slice(4).trim();
      if (part.startsWith("m ") && !mime) mime = part.slice(2).trim();
    }
    if (url) break;
  }
  if (!url) url = ev.tags.find(t => t[0] === "url")?.[1] ?? null;
  if (!url) {
    url = ev.content.match(URL_RE)?.find(u => IMAGE_RE.test(u) || VIDEO_RE.test(u)) ?? null;
  }
  if (!url || !/^https:\/\//i.test(url)) return null;

  let type = null;
  if (mime.startsWith("image/")) type = "image";
  else if (mime.startsWith("video/")) type = "video";
  else if (IMAGE_RE.test(url)) type = "image";
  else if (VIDEO_RE.test(url)) type = "video";
  else if (ev.kind === KIND.IMAGE) type = "image";
  else if (ev.kind === KIND.VIDEO || ev.kind === KIND.SHORT_VIDEO) type = "video";

  return type ? { url, type } : null;
}

function captionOf(ev) {
  const text = ev.content.replace(URL_RE, "").trim();
  return text || ev.tags.find(t => t[0] === "title")?.[1] || "";
}

export function createFeed({
  pool,
  getAuth,
  signEvent,
  notify = () => {},
  feedEl,
  emptyEl,
  onComment = () => {},
  onOpenProfile = () => {},
}) {
  const me = () => getAuth().pubkey;

  const cards = new Map();
  const profiles = new Map();
  const requestedProfiles = new Set();
  const follows = new Set();
  const reactions = new Map();
  const commentCounts = new Map();
  const removed = new Set();
  const blocked = readSet(BLOCKED_KEY);

  let contactsEvent = null;
  let contactsLoaded = false;
  let contactSub = null;
  let mainSub = null;
  let olderSub = null;
  let currentTag = null;
  let tab = "all";
  let oldest = 0;
  let loadingOlder = false;
  let muted = localStorage.getItem(SOUND_KEY) !== "1";
  let activeVideo = null;

  const pendingProfiles = new Set();
  const pendingCounts = new Set();
  let profileTimer = null;
  let countTimer = null;

  const io = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const video = entry.target.querySelector("video");
      if (!video) continue;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.65) playVideo(video);
      else if (video === activeVideo) video.pause();
    }
  }, { root: feedEl, threshold: [0, 0.65] });

  function playVideo(video) {
    if (activeVideo && activeVideo !== video) activeVideo.pause();
    activeVideo = video;
    if (!video.src) video.src = video.dataset.src;
    video.muted = muted;
    video.play().catch(() => {});
  }

  function shortName(pk) {
    const p = profiles.get(pk);
    return p?.display_name || p?.name || NT.nip19.npubEncode(pk).slice(0, 12) + "…";
  }

  function requestProfile(pk) {
    if (profiles.has(pk) || requestedProfiles.has(pk)) return;
    requestedProfiles.add(pk);
    pendingProfiles.add(pk);
    clearTimeout(profileTimer);
    profileTimer = setTimeout(flushProfiles, 300);
  }

  function flushProfiles() {
    const authors = [...pendingProfiles].slice(0, 200);
    pendingProfiles.clear();
    if (!authors.length) return;
    const sub = pool.subscribe([{ kinds: [KIND.PROFILE], authors }], {
      onEvent: applyProfile,
      onEose: () => sub.close(),
    });
  }

  function applyProfile(ev) {
    if (ev.kind !== KIND.PROFILE || !verified(ev)) return;
    const prev = profiles.get(ev.pubkey);
    if (prev && prev._t >= ev.created_at) return;
    let data;
    try { data = JSON.parse(ev.content); } catch { return; }
    profiles.set(ev.pubkey, { ...data, _t: ev.created_at });
    for (const entry of cards.values()) {
      if (entry.pk === ev.pubkey || entry.repostPk === ev.pubkey) refreshAuthor(entry);
    }
  }

  function refreshAuthor(entry) {
    entry.author.textContent = shortName(entry.pk);
    const p = profiles.get(entry.pk);
    if (p?.picture && isSafeImage(p.picture)) entry.avatar.src = p.picture;
    if (entry.repost && entry.repostPk) {
      entry.repost.textContent = `↻ أعاد نشره ${shortName(entry.repostPk)}`;
    }
  }

  function requestCounts(id) {
    pendingCounts.add(id);
    clearTimeout(countTimer);
    countTimer = setTimeout(flushCounts, 400);
  }

  function flushCounts() {
    const ids = [...pendingCounts].slice(0, 200);
    pendingCounts.clear();
    if (!ids.length) return;
    const sub = pool.subscribe([
      { kinds: [KIND.REACTION, KIND.NOTE], "#e": ids, "#t": [APP_TAG], limit: 1000 },
    ], {
      onEvent: handleCountEvent,
      onEose: () => setTimeout(() => sub.close(), 3000),
    });
  }

  function handleCountEvent(e) {
    if (removed.has(e.id) || !verified(e)) return;
    const target = e.tags.filter(t => t[0] === "e").map(t => t[1]).find(id => cards.has(id));
    if (!target) return;

    if (e.kind === KIND.REACTION) {
      if (e.content !== "+" && e.content !== "") return;
      const map = reactions.get(target) ?? new Map();
      map.set(e.pubkey, { id: e.id });
      reactions.set(target, map);
    } else if (e.kind === KIND.NOTE) {
      const set = commentCounts.get(target) ?? new Set();
      set.add(e.id);
      commentCounts.set(target, set);
    }
    paintCard(target);
  }

  function renderText(text) {
    return text.split(HASHTAG_SPLIT).filter(Boolean).map(part =>
      part.startsWith("#") && part.length > 1
        ? el("button", {
            className: "hashtag",
            type: "button",
            textContent: part,
            onclick: e => { e.stopPropagation(); setTag(part.slice(1).toLowerCase()); },
          })
        : document.createTextNode(part),
    );
  }

  function buildImage(url) {
    const img = el("img", {
      className: "media",
      src: url,
      alt: "",
      loading: "lazy",
      referrerPolicy: "no-referrer",
    });
    img.addEventListener("error", () => {
      img.replaceWith(el("div", { className: "media-error", textContent: "تعذّر تحميل الصورة" }));
    }, { once: true });
    return img;
  }

  function buildVideo(url) {
    const video = el("video", {
      className: "media",
      loop: true,
      playsInline: true,
      muted: true,
      preload: "metadata",
    });
    video.dataset.src = url;
    video.addEventListener("error", () => {
      notify("تعذّر تشغيل الفيديو. تحقق من الرابط أو الصيغة");
    }, { once: true });
    return video;
  }

  function muteButton() {
    const btn = el("button", {
      className: "mute-btn",
      type: "button",
      textContent: muted ? "🔇" : "🔊",
      ariaLabel: "تشغيل الصوت أو كتمه",
    });
    btn.onclick = () => {
      muted = !muted;
      localStorage.setItem(SOUND_KEY, muted ? "0" : "1");
      feedEl.querySelectorAll("video").forEach(v => { v.muted = muted; });
      btn.textContent = muted ? "🔇" : "🔊";
    };
    return btn;
  }

  function buildCard(ev, reposter) {
    const media = findMedia(ev);
    const caption = captionOf(ev);
    const pk = ev.pubkey;

    const avatar = el("img", {
      className: "avatar",
      src: "icon-192.png",
      alt: "",
      referrerPolicy: "no-referrer",
      onclick: () => onOpenProfile(pk),
    });
    const author = el("button", {
      className: "author",
      type: "button",
      textContent: shortName(pk),
      onclick: () => onOpenProfile(pk),
    });
    const repost = reposter
      ? el("small", { className: "repost", textContent: `↻ أعاد نشره ${shortName(reposter)}` })
      : null;
    const follow = el("button", {
      className: "follow-btn",
      type: "button",
      textContent: "+",
      ariaLabel: "متابعة",
      onclick: () => followUser(pk),
    });
    const like = el("button", {
      className: "act like",
      type: "button",
      ariaLabel: "إعجاب",
      onclick: () => toggleLike(ev),
    }, el("span", { className: "icon", textContent: "♡" }), el("span", { className: "count", textContent: "0" }));
    const comment = el("button", {
      className: "act",
      type: "button",
      ariaLabel: "التعليقات",
      onclick: () => onComment(ev),
    }, el("span", { className: "icon", textContent: "💬" }), el("span", { className: "count", textContent: "0" }));
    const share = el("button", {
      className: "act",
      type: "button",
      ariaLabel: "مشاركة",
      onclick: () => sharePost(ev),
    }, el("span", { className: "icon", textContent: "↗" }), el("span", { className: "count", textContent: "مشاركة" }));

    const body = el("div", { className: "body" });
    if (media?.type === "image") body.append(buildImage(media.url));
    else if (media?.type === "video") body.append(buildVideo(media.url));
    else body.append(el("div", { className: "text-only" }, ...renderText(caption)));

    const captionNode = media ? el("p", { className: "caption" }, ...renderText(caption)) : null;
    const infoChildren = [
      repost,
      author,
      el("small", { className: "time", textContent: formatTime(ev.created_at) }),
      captionNode,
    ].filter(Boolean);

    const card = el("article", {
      className: "card",
      dataset: { id: ev.id, pk, t: String(ev.created_at) },
    },
      body,
      el("div", { className: "side" },
        el("div", { className: "avatar-wrap" }, avatar, follow),
        like, comment, share),
      el("div", { className: "info" }, ...infoChildren),
    );

    if (media?.type === "video") card.append(muteButton());

    return {
      id: ev.id,
      pk,
      card,
      author,
      avatar,
      repost,
      repostPk: reposter ?? null,
      follow,
      like,
      comment,
    };
  }

  function paintCard(id) {
    const entry = cards.get(id);
    if (!entry) return;
    const self = me();
    const likes = reactions.get(id);
    const liked = !!(self && likes?.has(self));

    entry.like.classList.toggle("on", liked);
    entry.like.querySelector(".icon").textContent = liked ? "♥" : "♡";
    entry.like.querySelector(".count").textContent = formatCount(likes?.size ?? 0);
    entry.comment.querySelector(".count").textContent = formatCount(commentCounts.get(id)?.size ?? 0);
    entry.follow.hidden = entry.pk === self || follows.has(entry.pk);
    entry.card.hidden = tab === "following" && entry.pk !== self && !follows.has(entry.pk);
  }

  function applyVisibility() {
    for (const id of cards.keys()) paintCard(id);
  }

  function insertCard(card, time) {
    const next = [...feedEl.querySelectorAll(":scope > .card")]
      .find(c => Number(c.dataset.t) < time);
    feedEl.insertBefore(card, next ?? null);
  }

  function removeCard(id) {
    const entry = cards.get(id);
    if (!entry) return;
    const video = entry.card.querySelector("video");
    if (video) {
      video.pause();
      if (activeVideo === video) activeVideo = null;
    }
    io.unobserve(entry.card);
    entry.card.remove();
    cards.delete(id);
  }

  function trim() {
    if (cards.size <= MAX_CARDS) return;
    const all = feedEl.querySelectorAll(":scope > .card");
    const last = all[all.length - 1];
    if (!last) return;
    removeCard(last.dataset.id);
    const remaining = feedEl.querySelectorAll(":scope > .card");
    const newLast = remaining[remaining.length - 1];
    if (newLast) oldest = Number(newLast.dataset.t);
  }

  function addEvent(ev, reposter) {
    if (!ev || cards.has(ev.id) || removed.has(ev.id)) return;
    if (!FEED_KINDS.includes(ev.kind)) return;
    if (ev.kind === KIND.REPOST || ev.kind === KIND.GENERIC_REPOST) return;
    if (blocked.has(ev.pubkey) || (reposter && blocked.has(reposter))) return;
    if (ev.kind === KIND.NOTE && ev.tags.some(t => t[0] === "e")) return;
    if (!hasTag(ev, APP_TAG)) return;
    if (currentTag && !hasTag(ev, currentTag)) return;
    if (!findMedia(ev) && !captionOf(ev)) return;

    const entry = buildCard(ev, reposter);
    cards.set(ev.id, entry);
    if (emptyEl) emptyEl.hidden = true;
    insertCard(entry.card, ev.created_at);
    io.observe(entry.card);

    if (!oldest || ev.created_at < oldest) oldest = ev.created_at;
    requestProfile(ev.pubkey);
    if (reposter) requestProfile(reposter);
    requestCounts(ev.id);
    paintCard(ev.id);
    trim();
  }

  function handleFeedEvent(ev) {
    if (ev.kind === KIND.REPOST || ev.kind === KIND.GENERIC_REPOST) {
      if (!verified(ev) || blocked.has(ev.pubkey)) return;
      let inner;
      try { inner = JSON.parse(ev.content); } catch { return; }
      if (!inner || typeof inner !== "object" || !verified(inner)) return;
      return addEvent(inner, ev.pubkey);
    }
    if (!verified(ev)) return;
    addEvent(ev, null);
  }

  function feedFilter(extra = {}) {
    return { kinds: FEED_KINDS, "#t": [currentTag ?? APP_TAG], ...extra };
  }

  function subscribeFeed() {
    mainSub?.close();
    mainSub = pool.subscribe([feedFilter({ limit: 100 })], {
      onEvent: handleFeedEvent,
      onEose: () => {
        if (cards.size === 0 && emptyEl) {
          emptyEl.hidden = false;
          emptyEl.textContent = currentTag
            ? `لا منشورات بعد بالوسم #${currentTag}`
            : "لا منشورات بعد. كن أول من ينشر!";
        }
      },
    });
  }

  function loadOlder() {
    if (loadingOlder || !oldest) return;
    loadingOlder = true;
    olderSub?.close();
    olderSub = pool.subscribe([feedFilter({ until: oldest - 1, limit: 50 })], {
      onEvent: handleFeedEvent,
      onEose: () => {
        loadingOlder = false;
        olderSub?.close();
      },
    });
    setTimeout(() => { loadingOlder = false; }, 6000);
  }

  function onScroll() {
    const remaining = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight;
    if (remaining < feedEl.clientHeight * 2) loadOlder();
  }

  function handleDelete(e) {
    if (!verified(e)) return;
    for (const tag of e.tags) {
      if (tag[0] !== "e") continue;
      const id = tag[1];
      removed.add(id);

      const entry = cards.get(id);
      if (entry && entry.pk === e.pubkey) removeCard(id);

      for (const [targetId, map] of reactions) {
        if (map.get(e.pubkey)?.id === id) {
          map.delete(e.pubkey);
          paintCard(targetId);
        }
      }
      for (const [targetId, set] of commentCounts) {
        if (set.delete(id)) paintCard(targetId);
      }
    }
  }

  function loadContacts() {
    contactSub?.close();
    contactsEvent = null;
    contactsLoaded = false;
    follows.clear();

    const self = me();
    if (!self) {
      applyVisibility();
      return;
    }

    contactSub = pool.subscribe([{ kinds: [KIND.CONTACTS], authors: [self], limit: 1 }], {
      onEvent: ev => {
        if (!verified(ev) || ev.pubkey !== me()) return;
        if (contactsEvent && contactsEvent.created_at >= ev.created_at) return;
        contactsEvent = ev;
        follows.clear();
        for (const t of ev.tags) if (t[0] === "p" && t[1]) follows.add(t[1]);
        contactsLoaded = true;
        applyVisibility();
      },
      onEose: () => { contactsLoaded = true; },
    });
  }

  async function followUser(pk) {
    const self = me();
    if (!self) return notify("سجّل الدخول أولاً");
    if (pk === self || follows.has(pk)) return;
    if (!contactsLoaded) return notify("جارٍ تحميل قائمة المتابعة، حاول بعد لحظات");

    const next = new Set(follows);
    next.add(pk);
    const tags = [...next].map(p => ["p", p]);
    tags.push(["t", APP_TAG]);

    try {
      const ev = await signEvent({
        kind: KIND.CONTACTS,
        content: contactsEvent?.content ?? "",
        tags,
      });
      if (pool.publish(ev) === 0) return notify("تعذّر الإرسال: لا يوجد مرحّل متصل");
      contactsEvent = ev;
      follows.add(pk);
      applyVisibility();
      notify("تمت المتابعة");
    } catch (err) {
      notify(err?.message || "تعذّرت المتابعة");
    }
  }

  async function toggleLike(ev) {
    const self = me();
    if (!self) return notify("سجّل الدخول لتتفاعل");

    const map = reactions.get(ev.id) ?? new Map();
    reactions.set(ev.id, map);
    const mine = map.get(self);

    try {
      if (mine) {
        const del = await signEvent({
          kind: KIND.DELETE,
          content: "",
          tags: [["e", mine.id], ["k", String(KIND.REACTION)], ["t", APP_TAG]],
        });
        if (pool.publish(del) === 0) return notify("تعذّر الإرسال: لا يوجد مرحّل متصل");
        removed.add(mine.id);
        map.delete(self);
      } else {
        const reaction = await signEvent({
          kind: KIND.REACTION,
          content: "+",
          tags: [["e", ev.id], ["p", ev.pubkey], ["k", String(ev.kind)], ["t", APP_TAG]],
        });
        if (pool.publish(reaction) === 0) return notify("تعذّر الإرسال: لا يوجد مرحّل متصل");
        map.set(self, { id: reaction.id });
      }
      paintCard(ev.id);
    } catch (err) {
      notify(err?.message || "تعذّر تنفيذ الإجراء");
    }
  }

  function sharePost(ev) {
    const nevent = NT.nip19.neventEncode({
      id: ev.id,
      author: ev.pubkey,
      relays: pool.urls.slice(0, 2),
    });
    const link = `${location.href.split("#")[0]}#${nevent}`;
    if (navigator.share) {
      navigator.share({ url: link, text: captionOf(ev).slice(0, 80) }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(link).then(
        () => notify("تم نسخ الرابط"),
        () => notify("تعذّر النسخ"),
      );
    }
  }

  function clearCards() {
    for (const id of [...cards.keys()]) removeCard(id);
    oldest = 0;
    loadingOlder = false;
    if (emptyEl) {
      emptyEl.hidden = false;
      emptyEl.textContent = "جارٍ التحميل…";
    }
  }

  function setTag(name) {
    currentTag = name ? name.toLowerCase() : null;
    clearCards();
    subscribeFeed();
  }

  function setTab(next) {
    tab = next;
    applyVisibility();
    feedEl.scrollTo({ top: 0 });
  }

  function start() {
    subscribeFeed();
    pool.subscribe([{ kinds: [KIND.DELETE], "#t": [APP_TAG], limit: 500 }], { onEvent: handleDelete });
    loadContacts();
    feedEl.addEventListener("scroll", onScroll, { passive: true });
  }

  function onAuthChange() {
    loadContacts();
    applyVisibility();
  }

  return {
    start,
    setTab,
    setTag,
    onAuthChange,
    get currentTag() { return currentTag; },
  };
                                           }
