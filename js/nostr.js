export const NT = window.NostrTools;

if (!NT) {
  throw new Error("مكتبة nostr-tools لم تُحمَّل. تحقق من وسم السكربت في index.html");
}
