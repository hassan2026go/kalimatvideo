export const APP_TAG = "kalimat-app";
export const BLOSSOM_URL = "https://blossom.primal.net";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

export const KIND = {
  PROFILE: 0,
  NOTE: 1,
  CONTACTS: 3,
  DELETE: 5,
  REPOST: 6,
  REACTION: 7,
  GENERIC_REPOST: 16,
  IMAGE: 20,
  VIDEO: 21,
  SHORT_VIDEO: 22,
  GIFT_WRAP: 1059,
  BLOSSOM_AUTH: 24242,
  HIDE: 30078,
};

export const FEED_KINDS = [KIND.NOTE, KIND.REPOST, KIND.GENERIC_REPOST, KIND.IMAGE, KIND.VIDEO, KIND.SHORT_VIDEO];

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
