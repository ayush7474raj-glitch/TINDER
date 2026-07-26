/* =========================================================
   TINDER — firebase.js  (Version 2.1)
   Realtime Database only. No Firestore. No Firebase Auth.
   The firebaseConfig below is UNCHANGED from Version 1.
   ========================================================= */


/* =========================================================
   APP CONFIGURATION
   Every tunable value of the app lives here, so changing the
   secret code (or any limit) means editing ONE line.
   ========================================================= */

const APP_CONFIG = {
  /* Login */
  SECRET_CODE: "AYUSH123",

  /* Messages */
  MAX_MESSAGE: 1000,        // characters allowed in one message
  PAGE_SIZE: 50,            // messages loaded per page (initial + each scroll up)
  PREVIEW_MAX: 60,          // characters shown in a chat list preview

  /* Profile rules */
  USERNAME_MIN: 3,
  USERNAME_MAX: 20,
  USERNAME_PATTERN: /^[A-Za-z0-9 _]+$/,   // letters, numbers, space, underscore
  AGE_MIN: 1,
  AGE_MAX: 120,

  /* Password rules. The password is never stored — only a PBKDF2 hash of it,
     together with a random salt generated per user. */
  PASSWORD_MIN: 6,
  PASSWORD_MAX: 64,
  PBKDF2_ITERATIONS: 120000,

  /* Media ceilings (Realtime Database stores these inline as data URLs) */
  REC_MAX_SEC: 60,
  MEDIA_MAX_CHARS: 900000,
  PHOTO_MAX_SIDE: 256,
  IMAGE_MAX_SIDE: 1280,

  /* Write throttles, in milliseconds */
  RECEIPT_THROTTLE: 3000,
  SEARCH_DEBOUNCE: 150
};


const firebaseConfig = {
  apiKey: "AIzaSyCs8Rz0t7vKwTAS14zsuaTaM2691RjwcuA",
  authDomain: "tinder-9bbeb.firebaseapp.com",
  databaseURL: "https://tinder-9bbeb-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "tinder-9bbeb",
  storageBucket: "tinder-9bbeb.firebasestorage.app",
  messagingSenderId: "967709156109",
  appId: "1:967709156109:web:c67e1f1f1ca0ac0adbc644"
};

/* ---- Initialize (Realtime Database only) ---- */
firebase.initializeApp(firebaseConfig);

const db = firebase.database();

/* =========================================================
   DATABASE SHAPE (V1 nodes kept, V2 nodes added)

   users/{uid}            username, age, photo, online, lastSeen   (V1 + new fields)
   messages/{msgId}       group messages                            (V1, unchanged)
   typing/group/{uid}     group typing
   typing/{chatId}/{uid}  personal typing
   groupState/{uid}       { seenAt }              -> group seen ticks
   chats/{chatId}/messages/{msgId}                -> private messages
   chats/{chatId}/state/{uid}  { deliveredAt, seenAt }
   chatIndex/{uid}/{peerUid}   { last, ts, from, unread, type }
   pins/{chatId}          { key, text, sender }   ("group" or a chatId)

   Only ONE small node is read per feature, so reads stay cheap:
   the chat list needs a single listener on chatIndex/{myUid}, and
   read receipts need a single listener per open conversation.
   ========================================================= */

const usersRef      = db.ref("users");
const messagesRef   = db.ref("messages");
const typingRef     = db.ref("typing");
const connectedRef  = db.ref(".info/connected");
const chatsRef      = db.ref("chats");
const chatIndexRef  = db.ref("chatIndex");
const groupStateRef = db.ref("groupState");
const pinsRef       = db.ref("pins");

/* ---- Helpers ---- */
const TIMESTAMP = firebase.database.ServerValue.TIMESTAMP;

/* Identifier used for the group conversation everywhere in the app */
const GROUP_ID = "group";

/* A private chat id is the two uids sorted, so both sides compute
   the exact same key without any extra lookup. */
function chatIdOf(a, b) {
  return [a, b].sort().join("__");
}


/* =========================================================
   ERROR HANDLING
   Firebase rejects with a code we can turn into plain language.
   Every read and write in app.js goes through dbWrite / dbRead so
   a failure always reaches the user instead of the console.
   ========================================================= */

function describeDbError(error, fallback) {
  const code = String((error && (error.code || error.message)) || "").toUpperCase();

  if (code.indexOf("PERMISSION_DENIED") !== -1) return "Permission denied by the database.";
  if (code.indexOf("NETWORK") !== -1 || code.indexOf("DISCONNECT") !== -1) return "Network error. Check your connection.";
  if (code.indexOf("UNAVAILABLE") !== -1) return "Database unavailable. Try again in a moment.";
  if (code.indexOf("MAX_RETRIES") !== -1) return "The database is busy. Try again.";
  if (code.indexOf("TOO BIG") !== -1 || code.indexOf("TOO_LARGE") !== -1) return "That content is too large to send.";

  return fallback || "Something went wrong. Try again.";
}

/* Wraps a write (set / update / push / remove / transaction).
   Resolves to true on success, false on failure. Never throws. */
function dbWrite(operation, failMessage, onError) {
  return Promise.resolve(operation)
    .then(() => true)
    .catch((error) => {
      const message = describeDbError(error, failMessage);
      if (typeof onError === "function") onError(message, error);
      return false;
    });
}

/* Wraps a one-shot read. Resolves to the snapshot value, or null. */
function dbRead(ref, failMessage, onError) {
  return ref.once("value")
    .then((snap) => snap)
    .catch((error) => {
      const message = describeDbError(error, failMessage);
      if (typeof onError === "function") onError(message, error);
      return null;
    });
}