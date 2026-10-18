import { $, el } from "./util.js";
import { createRelayPool, loadRelayList } from "./relays.js";
import * as auth from "./identity.js";
import { createFeed } from "./feed.js";

const pool = createRelayPool(loadRelayList());
const feedEl = $("#feed");
const emptyEl = $("#empty");

function toast(message) {
  const node = el("div", { className: "toast", textContent: message });
  document.body.append(node);
  setTimeout(() => node.remove(), 2200);
}

function openDialog(dialog, content) {
  dialog.replaceChildren(...content);
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function renderLogin() {
  const dlg = $("#dlgLogin");
  const status = el("p", { className: "muted" });
  const input = el("input", { type: "password", placeholder: "nsec1…", dir: "ltr", autocomplete: "off" });

  const action = (label, fn, cls = "btn") => el("button", {
    className: cls,
    textContent: label,
    onclick: async () => {
      status.textContent = "";
      try {
        await fn();
        closeDialog(dlg);
        if (auth.isLoggedIn()) renderAccount();
      } catch (err) {
        status.textContent = err?.message || "حدث خطأ";
      }
    },
  });

  openDialog(dlg, [
    el("h2", { textContent: "الدخول إلى kalimat" }),
    action("إنشاء حساب جديد", async () => {
      const nsec = await auth.createKey();
      showBackupNotice(nsec);
    }),
    action("الدخول عبر محفظة NIP-07", () => auth.loginWithExtension(), "btn ghost"),
    el("p", { className: "muted", textContent: "أو استيراد مفتاح موجود:" }),
    input,
    action("استيراد المفتاح", () => auth.importKey(input.value), "btn ghost"),
    el("p", { className: "warn", textContent: "المفتاح يُحفظ مشفّراً على هذا الجهاز ولا يغادره." }),
    status,
    el("button", { className: "btn ghost", textContent: "إغلاق", onclick: () => closeDialog(dlg) }),
  ]);
}

function showBackupNotice(nsec) {
  const dlg = $("#dlgNotice");
  openDialog(dlg, [
    el("h2", { textContent: "احفظ مفتاحك الآن" }),
    el("p", { className: "warn", textContent: "هذا المفتاح هو حسابك. لا يمكن استرجاعه إن فقدته." }),
    el("code", { className: "key", dir: "ltr", textContent: nsec }),
    el("button", {
      className: "btn",
      textContent: "نسخ المفتاح",
      onclick: () => navigator.clipboard.writeText(nsec).then(() => toast("تم النسخ")),
    }),
    el("button", { className: "btn ghost", textContent: "تم، لقد حفظته", onclick: () => closeDialog(dlg) }),
  ]);
}

function renderAccount() {
  feedEl.hidden = true;
  const page = $("#page");
  page.hidden = false;
  const snap = auth.getAuth();

  if (!auth.isLoggedIn()) {
    page.replaceChildren(
      el("h2", { textContent: "حسابي" }),
      el("button", { className: "btn", textContent: "تسجيل الدخول", onclick: renderLogin }),
    );
    return;
  }

  const children = [
    el("h2", { textContent: "حسابي" }),
    el("p", { className: "muted", dir: "ltr", textContent: `npub…${snap.pubkey.slice(-8)}` }),
  ];

  if (snap.canExportKey) {
    children.push(el("button", {
      className: "btn ghost",
      textContent: "عرض المفتاح للنسخ الاحتياطي",
      onclick: () => {
        if (!confirm("لا تشارك المفتاح مع أحد. هل تريد عرضه؟")) return;
        showBackupNotice(auth.exportNsec());
      },
    }));
  }

  children.push(el("button", {
    className: "btn danger",
    textContent: "تسجيل الخروج",
    onclick: async () => {
      const warning = snap.canExportKey
        ? "سيُحذف المفتاح من هذا الجهاز. تأكد أنك نسخته قبل المتابعة. هل تريد الخروج؟"
        : "هل تريد تسجيل الخروج؟";
      if (!confirm(warning)) return;
      await auth.logout();
      showView("home");
      toast("تم تسجيل الخروج");
    },
  }));

  page.replaceChildren(...children);
}

function setActiveNav(view) {
  document.querySelectorAll(".nav-btn[data-view]").forEach(b => {
    b.classList.toggle("on", b.dataset.view === view);
  });
}

function showView(view) {
  setActiveNav(view);
  if (view === "home") {
    $("#page").hidden = true;
    feedEl.hidden = false;
  } else if (view === "account") {
    renderAccount();
  } else {
    toast("ستتوفر هذه الصفحة لاحقاً");
  }
}

document.querySelectorAll(".nav-btn[data-view]").forEach(btn => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

$("#btnPost").addEventListener("click", () => {
  if (!auth.isLoggedIn()) return renderLogin();
  toast("النشر سيُضاف لاحقاً");
});

const feed = createFeed({
  pool,
  getAuth: auth.getAuth,
  signEvent: auth.signEvent,
  notify: toast,
  feedEl,
  emptyEl,
  onComment: () => toast("التعليقات ستُضاف لاحقاً"),
  onOpenProfile: () => toast("الملف الشخصي سيُضاف لاحقاً"),
});

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b === btn));
    feed.setTab(btn.dataset.tab);
  });
});

const statusTimer = setInterval(() => {
  if (pool.connectedCount > 0 && emptyEl.textContent.startsWith("جارٍ الاتصال")) {
    emptyEl.textContent = "متصل. ستظهر المنشورات هنا قريباً.";
  }
}, 1000);

setTimeout(() => {
  clearInterval(statusTimer);
  if (pool.connectedCount === 0) emptyEl.textContent = "تعذّر الاتصال بالمرحّلات. تحقق من الإنترنت.";
}, 15000);

auth.onAuthChange(() => feed.onAuthChange());

async function boot() {
  await auth.init();
  const snap = auth.getAuth();
  if (snap.error) toast(snap.error);
  feed.start();
  if (!auth.isLoggedIn()) emptyEl.textContent = "مرحباً بك في kalimat. سجّل الدخول من «حسابي» للبدء.";
}

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

boot();
