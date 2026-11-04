/* kalimat-extras.js
   يُحمَّل بعد السكربت الرئيسي في index.html.
   1) مكالمة فيديو فردية (WebRTC). الإشارات (عرض/رد/إنهاء) تُرسل كرسائل خاصة مشفّرة (NIP-17)،
      ولا تمر عبر خادم مركزي. تحتاج الطرفين مسجّلين بمفتاح خاص لا عبر محفظة خارجية.
   2) زر "إبلاغ" داخل قائمة خيارات المنشور (NIP-56).
*/
(function () {
  const PREFIX = "KCALL1:";
  const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  let C = null;            // الحالة الحالية للمكالمة
  let ringTimer = null;

  /* ---------- إعدادات الـhead تلقائياً (بدون تعديل index.html) ---------- */
  (function headSetup() {
    const vp = document.querySelector('meta[name="viewport"]');
    if (vp) vp.setAttribute("content", "width=device-width,initial-scale=1,viewport-fit=cover");
    const add = (attr, key, content) => {
      if (document.head.querySelector("meta[" + attr + '="' + key + '"]')) return;
      const m = document.createElement("meta");
      m.setAttribute(attr, key);
      m.setAttribute("content", content);
      document.head.append(m);
    };
    add("property", "og:type", "website");
    add("property", "og:title", "kalimat — منصة لامركزية للكلمة والصورة والفيديو");
    add("property", "og:description", "بلا حسابات مركزية ولا إعلانات");
    add("property", "og:image", location.origin + "/icon-512.png");
    add("name", "twitter:card", "summary");
  })();

  const rid = () => Math.random().toString(36).slice(2, 12);
  const $q = (s) => document.querySelector(s);

  /* ---------- إشارات مشفّرة عبر الرسائل الخاصة ---------- */
  function sendSig(peer, obj) {
    if (!sk) throw new Error("سجّل الدخول بمفتاح خاص");
    const text = PREFIX + JSON.stringify(obj);
    NT.nip17.wrapManyEvents(sk, [{ publicKey: peer }, { publicKey: pk }], text).forEach(publish);
  }

  // نعترض دالة استقبال الرسائل الخاصة الموجودة في الصفحة الرئيسية
  const origDmIn = window.dmIn;
  window.dmIn = function (r) {
    try {
      if (typeof r.content === "string" && r.content.startsWith(PREFIX)) {
        if (r.pubkey === pk) return;                 // نسخة من رسالتنا نفسها
        if (Date.now() / 1000 - r.created_at > 120) return; // إشارة قديمة
        handleSig(r.pubkey, JSON.parse(r.content.slice(PREFIX.length)), r.created_at);
        return;
      }
    } catch (e) { return; }
    return origDmIn && origDmIn.apply(this, arguments);
  };

  async function handleSig(from, m, t) {
    if (!m || !m.c) return;
    if (m.t === "offer") return onOffer(from, m);
    if (!C || m.c !== C.id || from !== C.peer) return;
    if (m.t === "answer" && C.role === "caller") {
      clearTimeout(C.timer);
      await C.pc.setRemoteDescription({ type: "answer", sdp: m.s });
      return;
    }
    if (m.t === "busy") { toast("الطرف الآخر مشغول"); return endCall(false); }
    if (m.t === "end") { toast("أُنهيت المكالمة"); return endCall(false); }
  }

  /* ---------- WebRTC ---------- */
  function newPc() {
    const pc = new RTCPeerConnection({ iceServers: STUN });
    pc.ontrack = (e) => { $q("#kRemote").srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => {
      if (!C || C.pc !== pc) return;
      if (pc.connectionState === "connected") { C.connected = true; status("متصل"); }
      if (pc.connectionState === "failed") { toast("تعذّر الاتصال المباشر بين الطرفين"); endCall(true); }
    };
    return pc;
  }
  function waitIce(pc) {
    return new Promise((res) => {
      if (pc.iceGatheringState === "complete") return res();
      const done = () => { if (pc.iceGatheringState === "complete") { pc.removeEventListener("icegatheringstatechange", done); res(); } };
      pc.addEventListener("icegatheringstatechange", done);
      setTimeout(res, 5000);
    });
  }
  const media = () => navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: "user", width: { ideal: 640 } } });

  async function startCall(peer) {
    if (!sk) return toast("المكالمات تتطلب تسجيل الدخول بمفتاح خاص");
    if (C) return toast("لديك مكالمة جارية");
    let stream;
    try { stream = await media(); } catch { return toast("امنح إذن الكاميرا والميكروفون للمتصفح"); }
    C = { id: rid(), peer, role: "caller", stream };
    C.pc = newPc();
    stream.getTracks().forEach((t) => C.pc.addTrack(t, stream));
    showUI("جارٍ الاتصال…");
    try {
      await C.pc.setLocalDescription(await C.pc.createOffer());
      await waitIce(C.pc);
      sendSig(peer, { c: C.id, t: "offer", s: C.pc.localDescription.sdp });
    } catch (e) { toast("تعذّر بدء المكالمة"); return endCall(false); }
    C.timer = setTimeout(() => { if (C && !C.connected) { toast("لم يُجب الطرف الآخر"); endCall(true); } }, 45000);
  }

  function onOffer(from, m) {
    if (C) { try { sendSig(from, { c: m.c, t: "busy" }); } catch {} return; }
    C = { id: m.c, peer: from, role: "callee", offerSdp: m.s };
    showIncoming(from);
    ringTimer = setTimeout(() => { if (C && C.role === "callee" && !C.accepted) endCall(true); }, 45000);
  }

  async function acceptCall() {
    if (!C || C.role !== "callee") return;
    clearTimeout(ringTimer);
    C.accepted = true;
    hideIncoming();
    try { C.stream = await media(); }
    catch { toast("امنح إذن الكاميرا والميكروفون"); sendSig(C.peer, { c: C.id, t: "end" }); return endCall(false); }
    showUI("جارٍ الاتصال…");
    C.pc = newPc();
    C.stream.getTracks().forEach((t) => C.pc.addTrack(t, C.stream));
    try {
      await C.pc.setRemoteDescription({ type: "offer", sdp: C.offerSdp });
      await C.pc.setLocalDescription(await C.pc.createAnswer());
      await waitIce(C.pc);
      sendSig(C.peer, { c: C.id, t: "answer", s: C.pc.localDescription.sdp });
    } catch { toast("تعذّر قبول المكالمة"); endCall(true); }
  }

  function declineCall() {
    if (!C) return;
    hideIncoming();
    try { sendSig(C.peer, { c: C.id, t: "end" }); } catch {}
    endCall(false);
  }

  function endCall(notify) {
    if (!C) return;
    const c = C;
    C = null;
    clearTimeout(ringTimer); clearTimeout(c.timer);
    if (notify && c.peer) { try { sendSig(c.peer, { c: c.id, t: "end" }); } catch {} }
    try { c.stream && c.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { c.pc && c.pc.close(); } catch {}
    hideUI();
  }

  /* ---------- واجهة المكالمة ---------- */
  const BTN = "border:0;border-radius:50%;width:56px;height:56px;font-size:22px;color:#fff;background:#2b2f36;";
  function buildUI() {
    if ($q("#kCall")) return;
    const box = document.createElement("div");
    box.id = "kCall";
    box.style.cssText = "position:fixed;inset:0;z-index:3000;background:#000;display:none;flex-direction:column;";
    box.innerHTML = `
      <video id="kRemote" autoplay playsinline style="flex:1;width:100%;object-fit:cover;background:#000"></video>
      <video id="kLocal" autoplay muted playsinline style="position:absolute;top:14px;inset-inline-end:14px;width:110px;height:150px;object-fit:cover;border-radius:14px;border:2px solid #19bfff;background:#111"></video>
      <div id="kStatus" style="position:absolute;top:18px;inset-inline-start:0;inset-inline-end:0;text-align:center;color:#fff;font-size:15px;text-shadow:0 1px 6px #000"></div>
      <div style="display:flex;justify-content:center;gap:18px;padding:18px calc(10px + env(safe-area-inset-bottom,0px));background:#0008">
        <button id="kMic" style="${BTN}" aria-label="كتم الميكروفون">🎤</button>
        <button id="kCam" style="${BTN}" aria-label="إيقاف الكاميرا">📷</button>
        <button id="kEnd" style="${BTN}background:#e0245e" aria-label="إنهاء المكالمة">✖</button>
      </div>`;
    document.body.append(box);
    $q("#kEnd").onclick = () => endCall(true);
    $q("#kMic").onclick = () => { if (C && C.stream) C.stream.getAudioTracks().forEach((t) => (t.enabled = !t.enabled)); };
    $q("#kCam").onclick = () => { if (C && C.stream) C.stream.getVideoTracks().forEach((t) => (t.enabled = !t.enabled)); };

    const inc = document.createElement("div");
    inc.id = "kIn";
    inc.style.cssText = "position:fixed;inset:0;z-index:3100;background:#000c;display:none;align-items:center;justify-content:center;padding:20px";
    inc.innerHTML = `
      <div style="background:#0c1f2e;color:#fff;border:1px solid #19bfff66;border-radius:20px;padding:24px;text-align:center;width:min(92vw,340px)">
        <div style="font-size:40px">📹</div>
        <p id="kInText" style="margin:12px 0 18px;font-size:16px;line-height:1.6"></p>
        <div style="display:flex;gap:10px">
          <button id="kAcc" style="flex:1;padding:12px;border:0;border-radius:12px;background:#16a34a;color:#fff;font-weight:700">قبول</button>
          <button id="kDec" style="flex:1;padding:12px;border:0;border-radius:12px;background:#e0245e;color:#fff;font-weight:700">رفض</button>
        </div>
      </div>`;
    document.body.append(inc);
    $q("#kAcc").onclick = acceptCall;
    $q("#kDec").onclick = declineCall;
  }
  function status(t) { const s = $q("#kStatus"); if (s) s.textContent = t; }
  function showUI(t) {
    buildUI();
    const box = $q("#kCall");
    box.style.display = "flex";
    status(t);
    const local = $q("#kLocal");
    if (C && C.stream) local.srcObject = C.stream;
    const remote = $q("#kRemote");
    remote.play && remote.play().catch(() => {});
  }
  function hideUI() {
    const box = $q("#kCall");
    if (!box) return;
    box.style.display = "none";
    $q("#kRemote").srcObject = null;
    $q("#kLocal").srcObject = null;
  }
  function showIncoming(from) {
    buildUI();
    $q("#kInText").textContent = "مكالمة فيديو واردة من " + nmOf(from);
    $q("#kIn").style.display = "flex";
  }
  function hideIncoming() { const i = $q("#kIn"); if (i) i.style.display = "none"; }

  /* ---------- زر المكالمة في صفحة الملف الشخصي ---------- */
  const origOpenProf = window.openProf;
  window.openProf = function (p) {
    const r = origOpenProf.apply(this, arguments);
    setTimeout(() => addCallButton(p), 0);
    return r;
  };
  function addCallButton(p) {
    if (!p || p === pk) return;
    const pa = document.querySelector("#pg .pa");
    if (!pa || pa.querySelector(".kcall-btn")) return;
    const b = document.createElement("button");
    b.className = "kcall-btn";
    b.textContent = "📹 مكالمة فيديو";
    b.onclick = () => startCall(p);
    pa.append(b);
  }

  /* ---------- الإبلاغ عن المنشور (NIP-56) ---------- */
  const origPostMenu = window.postMenu;
  window.postMenu = function (ev) {
    const r = origPostMenu.apply(this, arguments);
    const box = document.getElementById("ab");
    if (box && ev.pubkey !== pk) {
      const b = document.createElement("button");
      b.className = "b dl";
      b.textContent = "🚩 إبلاغ عن المنشور";
      b.onclick = async () => {
        const reason = prompt("سبب الإبلاغ (مثال: محتوى مسيء، احتيال، انتحال هوية):");
        if (!reason || !reason.trim()) return;
        try {
          const e = await sign({
            kind: 1984, created_at: now(), content: reason.trim().slice(0, 300),
            tags: [["p", ev.pubkey], ["e", ev.id, "other"], ["t", TAG]]
          });
          publish(e);
          document.querySelectorAll('.card[data-id="' + ev.id + '"]').forEach((c) => c.remove());
          document.getElementById("dAct").close();
          toast("شكراً، تم إرسال البلاغ");
        } catch { toast("تعذّر إرسال البلاغ"); }
      };
      box.append(b);
    }
    return r;
  };
})();

/* ---------- تثبيت التطبيق: زر واحد واضح بدون فحص تقني ---------- */
(function installSimple() {
  let deferred = null;
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    const b = document.getElementById("installAccountEntry");
    if (b) b.hidden = true;
  });

  // يستبدل الدالة الأصلية التي يستدعيها زر التثبيت
  window.installKalimatApp = async function () {
    if (standalone()) { toast("التطبيق مثبّت بالفعل"); return; }
    if (deferred) {
      deferred.prompt();
      try { await deferred.userChoice; } catch (e) {}
      deferred = null;
      return;
    }
    showInstallHelp();
  };

  function showInstallHelp() {
    let d = document.getElementById("kInstHelp");
    if (!d) { d = document.createElement("dialog"); d.id = "kInstHelp"; document.body.append(d); }
    d.innerHTML =
      '<h2>تثبيت kalimat</h2>' +
      '<p class="w">على أندرويد (Chrome): اضغط النقاط الثلاث ⋮ في أعلى الشاشة، ثم اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».</p>' +
      '<p class="w">على الآيفون (Safari): اضغط زر المشاركة ⬆️ ثم اختر «إضافة إلى الشاشة الرئيسية».</p>' +
      '<button class="b g" type="button">إغلاق</button>';
    d.querySelector("button").onclick = () => d.close();
    d.showModal();
  }
})();

/* ---------- إشعار قصير يؤكد أن الإضافة عملت (يظهر مرة في كل جلسة) ---------- */
(function loadNotice() {
  try {
    if (sessionStorage.getItem("kx-loaded")) return;
    sessionStorage.setItem("kx-loaded", "1");
  } catch (e) {}
  setTimeout(() => { if (typeof toast === "function") toast("✓ تم تحميل تحديثات kalimat"); }, 1500);
})();
