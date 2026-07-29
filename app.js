/* =========================================================
   TINDER — app.js  (Version 2)
   ---------------------------------------------------------
   SECTIONS
     01  Constants & state
     02  Small utilities
     03  Avatars & profile helpers
     04  Theme
     05  Connection & presence
     06  Login / auto login / logout
     07  Users listener (members, online count)
     08  Chat index listener (previews + unread)
     09  Chat list rendering
     10  Opening a conversation (listener lifecycle)
     11  Message rendering
     12  Read receipts (delivered / seen)
     13  Sending: text, image, voice note
     14  Typing indicator
     15  Action sheet: reply, copy, pin, edit, delete, react
     16  Search (name / message / date)
     17  Settings & profile editing
     18  Members modal
     19  Browser notifications
     20  Boot
   ========================================================= */


/* =========================================================
   01 — CONSTANTS & STATE
   ========================================================= */

/* Every tunable now lives in APP_CONFIG (firebase.js). These aliases
   keep the rest of the file readable without duplicating values. */
const SECRET_CODE  = APP_CONFIG.SECRET_CODE;
const MAX_MESSAGE  = APP_CONFIG.MAX_MESSAGE;
const PAGE_SIZE    = APP_CONFIG.PAGE_SIZE;
const PREVIEW_MAX  = APP_CONFIG.PREVIEW_MAX;
const REC_MAX_SEC  = APP_CONFIG.REC_MAX_SEC;

/* Signed-in user. `uid` is stable: renaming never changes it. */
const me = { uid: "", username: "", age: "", photo: "" };

/* Conversation currently on screen: GROUP_ID or a peer uid */
let activeChat = GROUP_ID;
let activePeer = null;          // peer uid for private chats, null for group

/* Live data caches — these avoid re-reading Firebase */
let usersMap    = {};           // uid -> user record
let chatIndex   = {};           // peerUid -> { last, ts, from, unread }
let groupState  = {};           // uid -> { seenAt }
let peerState   = {};           // uid -> { deliveredAt, seenAt }  (open chat only)
let msgCache    = {};           // msgKey -> message data (open chat only)
let msgNodes    = {};           // msgKey -> DOM element (open chat only)
let pinned      = null;         // pinned message of the open chat

/* Composer state */
let replyTarget = null;
let editingKey  = null;
let sheetKey    = null;

/* Listener bookkeeping so we never attach a duplicate listener */
let chatListeners = [];         // detach functions for the open conversation
let usersListenerOn = false;
let indexListenerOn = false;

/* Rendering helpers */
let lastDayKey  = "";
let notifyReady = false;

/* Pagination — older messages load on demand instead of all at once */
let oldestKey    = null;    // first message key currently on screen
let loadingOlder = false;   // blocks overlapping page requests
let noMoreOlder  = false;   // reached the start of the conversation
let olderLoader  = null;    // "Loading older messages…" element

/* Batched rendering: several Firebase events in one tick produce ONE repaint */
let listDirty    = false;
let membersDirty = false;
let renderQueued = false;

/* Guards against double sends and overlapping saves */
let sending = false;
let savingProfile = false;

/* Voice recording */
let mediaRecorder = null;
let recChunks = [];
let recTimer = null;
let recStart = 0;


/* =========================================================
   02 — SMALL UTILITIES
   ========================================================= */

const $  = (q) => document.querySelector(q);
const $$ = (q) => Array.from(document.querySelectorAll(q));

const clean = (text) => (text || "").trim();

/* Firebase keys cannot contain . # $ / [ ] */
const safeKey = (text) => (text || "").replace(/[.#$/[\]]/g, "_");

function toast(message) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = message;
  t.classList.remove("hidden");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

function formatTime(time) {
  if (!time) return "";
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* "Today" / "Yesterday" / "12 Mar 2026" — used by the date separators */
function dayKey(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
}

function dayLabel(ts) {
  const d = new Date(ts || Date.now());
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);

  if (dayKey(d) === dayKey(today)) return "Today";
  if (dayKey(d) === dayKey(yest)) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/* Compact relative time for last-seen and chat list rows */
function relativeTime(ts) {
  if (!ts) return "a while ago";
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? " hour ago" : " hours ago");
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return days + " days ago";
  return new Date(ts).toLocaleDateString([], { day: "numeric", month: "short" });
}

/* Time shown on the right of a chat list row */
function shortTime(ts) {
  if (!ts) return "";
  const label = dayLabel(ts);
  if (label === "Today") return formatTime(ts);
  if (label === "Yesterday") return "Yesterday";
  return new Date(ts).toLocaleDateString([], { day: "numeric", month: "short" });
}

/* One-line summary of any message, used in previews and pins */
function previewOf(data) {
  if (!data) return "";
  if (data.deleted) return "This message was deleted.";
  if (data.audio) return "🎙️ Voice note";
  if (data.image) return "🖼️ Photo";
  const text = data.text || "";
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + "…" : text;
}

/* Shrinks any picked image so Realtime Database writes stay small */
function compressImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        let { width, height } = img;

        /* A broken or zero-sized image would produce an unusable canvas */
        if (!width || !height) {
          reject(new Error("empty image"));
          return;
        }

        const scale = Math.min(1, maxSide / Math.max(width, height));
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        /* Some browsers refuse a 2d context when memory is tight */
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas unavailable"));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);

        try {
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (err) {
          reject(new Error("encode failed"));
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* Does this message belong to me? (V1 messages have no uid — fall back to name) */
function isMine(data) {
  if (!data) return false;
  return data.uid ? data.uid === me.uid : data.sender === me.username;
}

/* Shows a database failure to the user in plain language */
function failToast(message) {
  toast(message);
}

/* Convenience: run a write and surface any failure as a toast */
function write(operation, failMessage) {
  return dbWrite(operation, failMessage, failToast);
}


/* ---------------------------------------------------------
   VALIDATION
   Nothing reaches Firebase without passing through here, so the
   database can never receive null, undefined, empty or malformed
   values.
   --------------------------------------------------------- */

/* Returns "" when valid, otherwise the reason to show the user */
function validateUsername(name) {
  const value = clean(name);

  if (!value) return "Enter a username.";
  if (value.length < APP_CONFIG.USERNAME_MIN) return "Username must be at least " + APP_CONFIG.USERNAME_MIN + " characters.";
  if (value.length > APP_CONFIG.USERNAME_MAX) return "Username can be at most " + APP_CONFIG.USERNAME_MAX + " characters.";
  if (!APP_CONFIG.USERNAME_PATTERN.test(value)) return "Use only letters, numbers, spaces and underscores.";

  return "";
}

/* Age is optional; when present it must be a whole number in range */
function validateAge(age) {
  const value = clean(age);
  if (value === "") return "";

  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) return "Age must be a whole number.";
  if (number < APP_CONFIG.AGE_MIN || number > APP_CONFIG.AGE_MAX) {
    return "Age must be between " + APP_CONFIG.AGE_MIN + " and " + APP_CONFIG.AGE_MAX + ".";
  }
  return "";
}

function validateMessageText(text) {
  const value = clean(text);
  if (value === "") return "Write something first.";
  if (value.length > MAX_MESSAGE) return "Messages are limited to " + MAX_MESSAGE + " characters.";
  return "";
}

/* Usernames are compared case-insensitively and space-insensitively */
function normaliseName(name) {
  return clean(name).replace(/\s+/g, " ").toLowerCase();
}

/* Strips undefined, null and empty values so Firebase only ever
   receives fields that actually carry information */
function compact(object) {
  const result = {};
  Object.keys(object).forEach((key) => {
    const value = object[key];
    if (value === undefined || value === null) return;
    if (typeof value === "string" && value === "") return;
    if (typeof value === "number" && !Number.isFinite(value)) return;
    result[key] = value;
  });
  return result;
}

/* True when the object has at least one usable field */
function hasContent(object) {
  return Object.keys(object).length > 0;
}


/* ---------------------------------------------------------
   PASSWORDS
   The password itself is never sent to Firebase. What is stored is a
   PBKDF2-SHA256 hash plus a random per-user salt, so the database only
   ever holds a value that cannot be read back into the password.

   Web Crypto needs a secure origin (https), which Vercel provides.
   On plain http the app falls back to device-based recognition and
   says so, instead of pretending to be protected.
   --------------------------------------------------------- */

function passwordsSupported() {
  return !!(window.crypto && window.crypto.subtle && window.crypto.getRandomValues);
}

function validatePassword(password) {
  const value = password || "";
  if (!value) return "Enter your password.";
  if (value.length < APP_CONFIG.PASSWORD_MIN) return "Password must be at least " + APP_CONFIG.PASSWORD_MIN + " characters.";
  if (value.length > APP_CONFIG.PASSWORD_MAX) return "Password is too long.";
  return "";
}

function bytesToHex(bytes) {
  return Array.prototype.map.call(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/* Derives the stored hash from a password and salt */
async function derivePasswordHash(password, saltHex, iterations) {
  const material = await window.crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await window.crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: iterations, hash: "SHA-256" },
    material, 256
  );
  return bytesToHex(new Uint8Array(bits));
}

/* Builds the record that gets written to users/{uid}/auth */
async function buildAuthRecord(password) {
  const salt = randomSalt();
  const iterations = APP_CONFIG.PBKDF2_ITERATIONS;
  const hash = await derivePasswordHash(password, salt, iterations);
  return { algo: "PBKDF2-SHA256", salt: salt, iter: iterations, hash: hash };
}

/* Compares in constant time so the comparison itself leaks nothing */
function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function passwordMatches(password, auth) {
  if (!auth || !auth.salt || !auth.hash) return false;
  const candidate = await derivePasswordHash(password, auth.salt, auth.iter || APP_CONFIG.PBKDF2_ITERATIONS);
  return sameHash(candidate, auth.hash);
}


/* =========================================================
   03 — AVATARS & PROFILE HELPERS
   ========================================================= */

/* Stable colour per user so avatars are recognisable without a photo */
function hueOf(text) {
  let hash = 0;
  for (let i = 0; i < (text || "").length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return hash;
}

/* Fills an .avatar element with a photo, or coloured initials */
function paintAvatar(el, user, isGroup) {
  if (!el) return;
  el.innerHTML = "";
  el.classList.toggle("group", !!isGroup);

  if (isGroup) {
    el.style.background = "";
    el.textContent = "#";
    return;
  }

  if (user && user.photo) {
    const img = document.createElement("img");
    img.src = user.photo;
    img.alt = "";
    el.style.background = "";
    el.appendChild(img);
    return;
  }

  const name = (user && user.username) || "?";
  const hue = hueOf(name);
  el.style.background = `linear-gradient(135deg, hsl(${hue},70%,55%), hsl(${(hue + 40) % 360},70%,60%))`;
  el.textContent = name.charAt(0).toUpperCase();
}

/* Avatar + presence dot, ready to drop into a list row */
function avatarWithPresence(user, isGroup, size) {
  const wrap = document.createElement("div");
  wrap.className = "avatar-wrap";

  const av = document.createElement("div");
  av.className = "avatar " + (size || "md");
  paintAvatar(av, user, isGroup);
  wrap.appendChild(av);

  if (!isGroup) {
    const dot = document.createElement("span");
    dot.className = "presence" + (user && user.online ? " on" : "");
    wrap.appendChild(dot);
  }
  return wrap;
}

function displayName(uid) {
  const user = usersMap[uid];
  return (user && user.username) || uid || "Unknown";
}


/* =========================================================
   04 — THEME
   ========================================================= */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("tinder_theme", theme);

  const btn = $("#themeToggle");
  if (btn) btn.textContent = theme === "dark" ? "🌙" : "☀️";

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0d0d12" : "#f4f5f9");
}

applyTheme(localStorage.getItem("tinder_theme") || "dark");

$("#themeToggle").onclick = () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
};


/* =========================================================
   05 — CONNECTION & PRESENCE
   ========================================================= */

/* One connection listener for the whole app. It re-registers presence
   after every reconnect, which is what keeps `online` accurate. */
connectedRef.on("value", (snap) => {
  const connected = snap.val() === true;
  $("#connBanner").classList.toggle("hidden", connected);

  if (connected && me.uid) registerPresence();
});

/* Presence failures are silent on purpose: the connection banner already
   tells the user, and a toast on every reconnect would be noise. They are
   still caught, so no promise is ever left unhandled. */
function registerPresence() {
  const ref = usersRef.child(me.uid);

  dbWrite(ref.onDisconnect().update({ online: false, lastSeen: TIMESTAMP }));
  dbWrite(ref.update({ online: true, lastSeen: TIMESTAMP }));
  dbWrite(typingRef.child(GROUP_ID).child(me.uid).onDisconnect().remove());
}

/* Update last seen when the tab is backgrounded or closed */
document.addEventListener("visibilitychange", () => {
  if (!me.uid) return;
  if (document.hidden) {
    dbWrite(usersRef.child(me.uid).update({ lastSeen: TIMESTAMP }));
  } else {
    dbWrite(usersRef.child(me.uid).update({ online: true, lastSeen: TIMESTAMP }));
    markSeen();
  }
});


/* =========================================================
   06 — LOGIN / AUTO LOGIN / LOGOUT
   ========================================================= */

$("#loginBtn").onclick = login;

/* Enter used to work in the secret-code box only, which meant finishing
   the form in the password field and pressing Enter did nothing. */
["#loginUsername", "#loginCode", "#loginPassword"].forEach((selector) => {
  const field = $(selector);
  if (!field) return;
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      login();
    }
  });
});

/* Picks a database key that is free, so two different names can never
   collide after the unsafe characters are stripped out */
function freeUid(username, users) {
  const base = safeKey(clean(username)) || "user";
  if (!users[base]) return base;

  let candidate;
  do {
    candidate = base + "_" + Math.random().toString(36).slice(2, 6);
  } while (users[candidate]);

  return candidate;
}

async function login() {
  const errorEl = $("#loginError");
  const button = $("#loginBtn");
  const code = clean($("#loginCode").value);
  const password = $("#loginPassword").value || "";

  /* --- Validation before anything touches the database --- */
  const nameError = validateUsername($("#loginUsername").value);
  if (nameError) {
    errorEl.textContent = nameError;
    return;
  }
  if (code !== SECRET_CODE) {
    errorEl.textContent = "That secret code is not correct.";
    return;
  }

  const usePasswords = passwordsSupported();
  if (usePasswords) {
    const passError = validatePassword(password);
    if (passError) {
      errorEl.textContent = passError;
      return;
    }
  }

  const username = clean($("#loginUsername").value).replace(/\s+/g, " ");
  const savedUid = localStorage.getItem("tinder_uid");

  errorEl.textContent = "";
  button.disabled = true;
  button.textContent = "Checking…";

  const finish = () => {
    button.disabled = false;
    button.textContent = "Login";
  };

  const snap = await dbRead(usersRef, "Could not reach the database.", (message) => {
    errorEl.textContent = message;
  });
  if (snap === null) {
    finish();
    return;
  }

  const users = snap.val() || {};
  const target = normaliseName(username);
  const owner = Object.keys(users).find(
    (uid) => users[uid] && normaliseName(users[uid].username) === target
  );

  let uid;
  let newAuth = null;

  try {
    if (owner) {
      const stored = users[owner].auth;

      if (stored && !usePasswords) {
        errorEl.textContent = "This account has a password, which needs a secure (https) connection.";
        finish();
        return;
      }

      if (stored) {
        /* The password proves ownership, so this works from ANY device */
        const correct = await passwordMatches(password, stored);
        if (!correct) {
          errorEl.textContent = "Incorrect password for this username.";
          finish();
          return;
        }
        uid = owner;

      } else if (owner === savedUid) {
        /* Older account with no password yet, on its own device:
           it adopts the password typed here from now on */
        uid = owner;
        if (usePasswords) newAuth = await buildAuthRecord(password);

      } else {
        /* Someone else's name and no password to prove otherwise */
        errorEl.textContent = "This username is already in use.";
        finish();
        return;
      }

    } else {
      /* Free name: a new account, or a rename on this device.
         The uid is created once and reused forever, so renaming never
         orphans your messages or private chats. */
      uid = savedUid || freeUid(username, users);
      if (usePasswords) newAuth = await buildAuthRecord(password);
    }
  } catch (err) {
    errorEl.textContent = "Could not check the password. Try again.";
    finish();
    return;
  }

  if (newAuth) {
    const saved = await write(
      usersRef.child(uid).child("auth").set(newAuth),
      "Could not save your password."
    );
    if (!saved) {
      finish();
      return;
    }
  }

  localStorage.setItem("tinder_uid", uid);
  localStorage.setItem("tinder_user", username);
  localStorage.setItem("tinder_auth", "1");

  finish();
  $("#loginPassword").value = "";
  startSession(uid, username);
}

/* Skips the login screen for a returning user on the same device */
function autoLogin() {
  const uid = localStorage.getItem("tinder_uid");
  const username = localStorage.getItem("tinder_user");
  const authed = localStorage.getItem("tinder_auth") === "1";

  if (username) $("#loginUsername").value = username;
  if (uid && username && authed) startSession(uid, username);
}

/* Everything that must happen exactly once per session */
function startSession(uid, username) {
  me.uid = uid;
  me.username = username;

  $("#loginScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");

  /* Write the profile without wiping fields set on another device.
     compact() guarantees no empty strings reach the database. */
  dbRead(usersRef.child(uid), "Could not load your profile.", failToast).then((snap) => {
    const existing = (snap && snap.val()) || {};
    me.age = existing.age || "";
    me.photo = existing.photo || "";

    write(
      usersRef.child(uid).update(compact({
        username: username,
        age: existing.age,
        photo: existing.photo,
        online: true,
        lastSeen: TIMESTAMP
      })),
      "Profile save failed."
    );

    paintMeStrip();
  });

  registerPresence();
  listenUsers();
  listenChatIndex();
  listenGroupPreview();
  listenGroupState();
  sweepDelivered();
  askNotificationPermission();

  /* V1 behaviour is preserved: you land straight in the group chat */
  openChat(GROUP_ID);

  setTimeout(() => { notifyReady = true; }, 1500);
}

$("#logoutBtn").onclick = () => {
  if (!confirm("Logout from TINDER?")) return;

  dbWrite(typingRef.child(GROUP_ID).child(me.uid).remove());
  if (activePeer) dbWrite(typingRef.child(activeChat).child(me.uid).remove());

  localStorage.removeItem("tinder_auth");
  localStorage.removeItem("tinder_user");

  /* Reload only once the offline state is stored, otherwise the page can
     unload mid-write and leave the user showing as online. The timeout
     makes sure a dead connection still logs you out.

     Both paths used to call location.reload(), so a healthy connection
     reloaded twice — the flag makes sure it happens exactly once. */
  let reloaded = false;
  const done = () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  };
  setTimeout(done, 1500);
  dbWrite(usersRef.child(me.uid).update({ online: false, lastSeen: TIMESTAMP })).then(done);
};


/* =========================================================
   07 — USERS LISTENER
   One listener feeds the online counter, chat list and members list.
   ========================================================= */

function listenUsers() {
  if (usersListenerOn) return;   // guards against duplicate listeners
  usersListenerOn = true;

  usersRef.on("value", (snap) => {
    usersMap = snap.val() || {};

    let online = 0;
    Object.keys(usersMap).forEach((uid) => {
      if (usersMap[uid] && usersMap[uid].online) online++;
    });
    $("#onlineCount").textContent = online;

    paintMeStrip();
    refreshPeerHeader();
    refreshAllTicks();                            // group ticks depend on who exists
    scheduleRender({ list: true, members: true }); // batched, never per-event
  }, (error) => failToast(describeDbError(error, "Could not load members.")));
}

function paintMeStrip() {
  const user = usersMap[me.uid] || { username: me.username, photo: me.photo };
  paintAvatar($("#meAvatar"), user, false);
  $("#meName").textContent = user.username || me.username;
}


/* =========================================================
   08 — CHAT INDEX LISTENER  (previews + unread badges)
   A single small node per user, so the chat list costs one listener
   instead of one listener per conversation.
   ========================================================= */

function listenChatIndex() {
  if (indexListenerOn) return;
  indexListenerOn = true;

  chatIndexRef.child(me.uid).on("value", (snap) => {
    const next = snap.val() || {};

    /* Notify only for genuinely new incoming messages */
    if (notifyReady) {
      Object.keys(next).forEach((peer) => {
        const before = chatIndex[peer];
        const after = next[peer];
        const isNew = after && after.from !== me.uid && (!before || after.ts !== before.ts);
        const chatOpen = activePeer === peer && !document.hidden;
        if (isNew && !chatOpen) {
          notify(displayName(peer), previewOf({ text: after.last }), peer);
        }
      });
    }

    chatIndex = next;
    scheduleRender({ list: true });
  }, (error) => failToast(describeDbError(error, "Could not load your chats.")));
}

/* On login, mark everything waiting for us as delivered.
   Pure writes — no message reads at all. */
function sweepDelivered() {
  dbRead(chatIndexRef.child(me.uid), "Could not sync delivery status.").then((snap) => {
    const index = (snap && snap.val()) || {};

    Object.keys(index).forEach((peer) => {
      if (index[peer] && index[peer].unread > 0) {
        dbWrite(
          chatsRef.child(chatIdOf(me.uid, peer))
            .child("state").child(me.uid)
            .update({ deliveredAt: TIMESTAMP })
        );
      }
    });
  });
}

/* The group conversation has no chatIndex entry — nothing writes one,
   because that would mean a write per member on every message. Its row
   therefore always showed the member count and never a preview or a
   time. One listener on the newest group message fixes that for the
   cost of a single tiny read. */
let groupLast = null;
let groupPreviewOn = false;

function listenGroupPreview() {
  if (groupPreviewOn) return;
  groupPreviewOn = true;

  const query = messagesRef.limitToLast(1);

  const absorb = (snap) => {
    const data = snap.val() || {};
    groupLast = {
      last: previewOf(data) || "Message",
      ts: data.timestamp || Date.now(),
      from: data.uid || ""
    };
    scheduleRender({ list: true });
  };

  query.on("child_added", absorb, () => { /* non-critical */ });
  query.on("child_changed", absorb, () => { /* edits and deletions */ });
}

/* Group read receipts share one tiny node per user */
function listenGroupState() {
  groupStateRef.on("value", (snap) => {
    groupState = snap.val() || {};
    if (activeChat === GROUP_ID) refreshAllTicks();
  }, (error) => describeDbError(error, ""));   // non-critical: ticks simply stay grey
}


/* =========================================================
   09 — CHAT LIST RENDERING
   ========================================================= */

let chatFilterText = "";
let filterTimer = null;

/* Several Firebase events often land in the same tick (a user goes online
   while a message arrives). Marking the views dirty and repainting once on
   the next frame keeps the DOM work down to a single pass. */
function scheduleRender(flags) {
  if (flags.list) listDirty = true;
  if (flags.members) membersDirty = true;
  if (renderQueued) return;

  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;

    if (listDirty) {
      listDirty = false;
      renderChatList();
    }
    /* The members list is only worth building while it is on screen */
    if (membersDirty) {
      membersDirty = false;
      if (!$("#membersModal").classList.contains("hidden")) renderMembers();
    }
  });
}

$("#chatFilter").oninput = (e) => {
  const value = e.target.value.toLowerCase();
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    chatFilterText = value;
    scheduleRender({ list: true });
  }, APP_CONFIG.SEARCH_DEBOUNCE);
};

function renderChatList() {
  const list = $("#chatList");
  if (!list || !me.uid) return;

  const fragment = document.createDocumentFragment();

  /* --- Group chat always sits at the top --- */
  if (!chatFilterText || "group chat".includes(chatFilterText)) {
    const groupMeta = groupLast || chatIndex[GROUP_ID] || {};
    fragment.appendChild(
      buildChatRow({
        id: GROUP_ID,
        isGroup: true,
        name: "Group Chat",
        sub: groupMeta.last
          ? (groupMeta.from === me.uid ? "You: " : "") + groupMeta.last
          : Object.keys(usersMap).length + " members",
        ts: groupMeta.ts,
        unread: 0
      })
    );
  }

  /* --- Everyone else, most recent conversation first --- */
  const people = Object.keys(usersMap)
    .filter((uid) => uid !== me.uid)
    .filter((uid) => displayName(uid).toLowerCase().includes(chatFilterText))
    .sort((a, b) => {
      const ta = (chatIndex[a] && chatIndex[a].ts) || 0;
      const tb = (chatIndex[b] && chatIndex[b].ts) || 0;
      if (tb !== ta) return tb - ta;
      return displayName(a).localeCompare(displayName(b));
    });

  if (people.length) {
    const label = document.createElement("div");
    label.className = "list-label";
    label.textContent = "Direct messages";
    fragment.appendChild(label);
  }

  people.forEach((uid) => {
    const meta = chatIndex[uid] || {};
    const user = usersMap[uid] || {};
    const sub = meta.last
      ? (meta.from === me.uid ? "You: " : "") + meta.last
      : (user.online ? "Online" : "Last seen " + relativeTime(user.lastSeen));

    fragment.appendChild(
      buildChatRow({
        id: uid,
        user: user,
        name: user.username || uid,
        sub: sub,
        ts: meta.ts,
        unread: meta.unread || 0
      })
    );
  });

  if (!people.length && chatFilterText) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = "No one matches that name.";
    fragment.appendChild(empty);
  }

  list.innerHTML = "";
  list.appendChild(fragment);
}

function buildChatRow(cfg) {
  const row = document.createElement("div");
  row.className = "chat-row" + (activeChat === cfg.id || activePeer === cfg.id ? " active" : "");

  row.appendChild(avatarWithPresence(cfg.user, cfg.isGroup, "md"));

  const body = document.createElement("div");
  body.className = "row-body";

  const top = document.createElement("div");
  top.className = "row-top";

  const name = document.createElement("span");
  name.className = "row-name";
  name.textContent = cfg.name;
  top.appendChild(name);

  const time = document.createElement("span");
  time.className = "row-time";
  time.textContent = shortTime(cfg.ts);
  top.appendChild(time);

  body.appendChild(top);

  const sub = document.createElement("div");
  sub.className = "row-sub";
  sub.textContent = cfg.sub || "";
  body.appendChild(sub);

  row.appendChild(body);

  if (cfg.unread > 0) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = cfg.unread > 99 ? "99+" : cfg.unread;
    row.appendChild(badge);
  }

  row.onclick = () => openChat(cfg.isGroup ? GROUP_ID : cfg.id);
  return row;
}


/* =========================================================
   10 — OPENING A CONVERSATION
   Every listener attached here is recorded so it can be detached
   the moment the user switches chats. No duplicates, ever.
   ========================================================= */

function detachChatListeners() {
  chatListeners.forEach((off) => { try { off(); } catch (e) { /* already gone */ } });
  chatListeners = [];
}

/* Where the messages of a conversation live */
function messagesRefOf(chatId) {
  return chatId === GROUP_ID
    ? messagesRef
    : chatsRef.child(chatId).child("messages");
}

/* Tracks which conversation is actually wired up, so tapping the row you
   are already reading does not tear down and rebuild every listener. */
let openedChatId = null;

function openChat(target) {
  const isGroup = target === GROUP_ID;
  const nextChat = isGroup ? GROUP_ID : chatIdOf(me.uid, target);

  if (openedChatId === nextChat) {
    $("#appShell").classList.add("chat-open");
    return;
  }
  openedChatId = nextChat;

  /* Stop typing in the conversation we are leaving */
  setTyping(false);
  detachChatListeners();

  activePeer = isGroup ? null : target;
  activeChat = isGroup ? GROUP_ID : chatIdOf(me.uid, target);

  /* Reset per-conversation state */
  msgCache = {};
  msgNodes = {};
  peerState = {};
  pinned = null;
  lastDayKey = "";
  replyTarget = null;
  editingKey = null;

  /* Receipt tracking is per conversation. A retry queued for the chat we
     are leaving must not fire against the one we are opening. */
  clearTimeout(seenRetry);
  clearTimeout(deliveredRetry);
  newestIncoming = 0;
  markedSeenTs = 0;
  markedDeliveredTs = 0;

  /* Pagination starts fresh for every conversation */
  oldestKey = null;
  loadingOlder = false;
  noMoreOlder = false;
  hideOlderLoader();
  $("#replyBar").classList.add("hidden");
  $("#editBar").classList.add("hidden");
  $("#pinnedBar").classList.add("hidden");
  $("#messages").innerHTML = "";
  closeSearch();

  $("#appShell").classList.add("chat-open");
  refreshPeerHeader();
  scheduleRender({ list: true });

  /* Clear the unread badge for this conversation */
  if (activePeer) {
    dbWrite(chatIndexRef.child(me.uid).child(activePeer).child("unread").set(0));
  }

  listenMessages();
  listenTyping();
  listenPin();
  if (activePeer) listenPeerState();
}

$("#backBtn").onclick = () => {
  $("#appShell").classList.remove("chat-open");
};

/* Header: name, avatar, online / last seen */
function refreshPeerHeader() {
  const nameEl = $("#peerName");
  const statusEl = $("#peerStatus");

  if (!activePeer) {
    paintAvatar($("#peerAvatar"), null, true);
    nameEl.textContent = "Group Chat";
    const total = Object.keys(usersMap).length;
    const online = Object.values(usersMap).filter((u) => u && u.online).length;
    statusEl.className = "peer-status";
    statusEl.textContent = total + " members · " + online + " online";
    return;
  }

  const user = usersMap[activePeer] || {};
  paintAvatar($("#peerAvatar"), user, false);
  nameEl.textContent = user.username || activePeer;

  if (user.online) {
    statusEl.className = "peer-status online";
    statusEl.textContent = "Online";
  } else {
    statusEl.className = "peer-status";
    statusEl.textContent = "Last seen " + relativeTime(user.lastSeen);
  }
}


/* =========================================================
   11 — MESSAGE RENDERING
   ========================================================= */

function listenMessages() {
  /* Only the newest page is live. Older pages are fetched on demand in
     loadOlderMessages(), which keeps the initial load small and fast
     even in a conversation with thousands of messages. */
  const query = messagesRefOf(activeChat).limitToLast(PAGE_SIZE);
  const chatAtAttach = activeChat;

  const onAdd = query.on("child_added", (snap) => {
    if (chatAtAttach !== activeChat) return;   // stale callback guard
    if (msgNodes[snap.key]) return;            // already on screen: never duplicate

    const data = snap.val() || {};
    msgCache[snap.key] = data;
    if (!oldestKey) oldestKey = snap.key;      // first key of the live page

    appendMessage(snap.key, data);

    if (!isMine(data)) {
      /* Remembering the newest incoming stamp lets markSeen/markDelivered
         skip the write entirely when nothing new has arrived. */
      newestIncoming = Math.max(newestIncoming, data.timestamp || 0);
      markDelivered();
      markSeen();
      if (activeChat === GROUP_ID && notifyReady && document.hidden) {
        notify(data.sender || "New message", previewOf(data), GROUP_ID);
      }
    }
  });

  /* Edits, deletions and reactions arrive here */
  const onChange = query.on("child_changed", (snap) => {
    if (chatAtAttach !== activeChat) return;
    const data = snap.val() || {};
    msgCache[snap.key] = data;
    updateMessage(snap.key, data);
  });

  const onRemove = query.on("child_removed", (snap) => {
    if (chatAtAttach !== activeChat) return;
    delete msgCache[snap.key];
    const node = msgNodes[snap.key];
    if (node && node.parentNode) node.parentNode.removeChild(node);
    delete msgNodes[snap.key];
    rebuildDividers();
  }, (error) => failToast(describeDbError(error, "Could not load messages.")));

  chatListeners.push(() => {
    query.off("child_added", onAdd);
    query.off("child_changed", onChange);
    query.off("child_removed", onRemove);
  });
}

/* ---------------------------------------------------------
   LAZY LOADING (pagination)
   Scrolling to the top fetches the previous page with a single
   one-shot read. Keys already on screen are skipped, so a message
   can never appear twice, and the scroll position is restored so
   the view does not jump under the reader's thumb.
   --------------------------------------------------------- */

function loadOlderMessages() {
  if (loadingOlder || noMoreOlder || !oldestKey) return;

  loadingOlder = true;
  showOlderLoader();

  const box = $("#messages");
  const chatAtRequest = activeChat;
  const anchorKey = oldestKey;

  messagesRefOf(activeChat)
    .orderByKey()
    .endAt(anchorKey)
    .limitToLast(PAGE_SIZE + 1)
    .once("value")
    .then((snap) => {
      if (chatAtRequest !== activeChat) return;   // user switched chats meanwhile

      const batch = [];
      snap.forEach((child) => {
        if (child.key === anchorKey) return;      // the anchor is already rendered
        if (msgNodes[child.key]) return;          // duplicate guard
        batch.push({ key: child.key, data: child.val() || {} });
      });

      if (!batch.length) {
        noMoreOlder = true;
        return;
      }

      const beforeHeight = box.scrollHeight;
      const beforeTop = box.scrollTop;

      const fragment = document.createDocumentFragment();
      batch.forEach((item) => {
        msgCache[item.key] = item.data;
        const node = buildMessage(item.key, item.data);
        msgNodes[item.key] = node;
        fragment.appendChild(node);
        applySearchTo(node, item.key);
      });

      box.insertBefore(fragment, box.firstChild);
      oldestKey = batch[0].key;
      rebuildDividers();

      /* Restore the reading position (smooth scrolling off for one frame) */
      box.classList.add("no-smooth");
      box.scrollTop = beforeTop + (box.scrollHeight - beforeHeight);
      requestAnimationFrame(() => box.classList.remove("no-smooth"));

      if (batch.length < PAGE_SIZE) noMoreOlder = true;
    })
    .catch((error) => {
      failToast(describeDbError(error, "Could not load older messages."));
    })
    .then(() => {
      loadingOlder = false;
      hideOlderLoader();
    });
}

function showOlderLoader() {
  const box = $("#messages");
  if (!olderLoader) {
    olderLoader = document.createElement("div");
    olderLoader.className = "older-loader";
    olderLoader.textContent = "Loading older messages…";
  }
  if (olderLoader.parentNode !== box) box.insertBefore(olderLoader, box.firstChild);
}

function hideOlderLoader() {
  if (olderLoader && olderLoader.parentNode) {
    olderLoader.parentNode.removeChild(olderLoader);
  }
}

/* Recomputes every date separator in one pass. Used after a page of older
   messages is prepended, where incremental tracking cannot work. */
function rebuildDividers() {
  const box = $("#messages");

  $$(".day-divider").forEach((divider) => {
    if (divider.parentNode === box) divider.parentNode.removeChild(divider);
  });

  let current = "";
  Array.prototype.slice.call(box.children).forEach((node) => {
    const key = node.dataset && node.dataset.key;
    const data = key ? msgCache[key] : null;
    if (!data) return;

    const stamp = dayKey(data.timestamp);
    if (stamp === current) return;

    current = stamp;
    const divider = document.createElement("div");
    divider.className = "day-divider";
    divider.textContent = dayLabel(data.timestamp);
    if (searchQuery) divider.classList.add("hidden");
    box.insertBefore(divider, node);
  });

  lastDayKey = current;
}

/* True when the user is already reading the newest messages */
function nearBottom() {
  const box = $("#messages");
  return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
}

function appendMessage(key, data) {
  const box = $("#messages");
  const stick = nearBottom() || isMine(data);

  /* Date separator whenever the day changes */
  const key2 = dayKey(data.timestamp);
  if (key2 !== lastDayKey) {
    lastDayKey = key2;
    const divider = document.createElement("div");
    divider.className = "day-divider";
    divider.textContent = dayLabel(data.timestamp);
    box.appendChild(divider);
  }

  const node = buildMessage(key, data);
  msgNodes[key] = node;
  box.appendChild(node);

  if (stick) scrollToBottom();
  else $("#jumpBtn").classList.remove("hidden");

  applySearchTo(node, key);
}

function scrollToBottom() {
  const box = $("#messages");
  box.scrollTop = box.scrollHeight;
  $("#jumpBtn").classList.add("hidden");
}

$("#jumpBtn").onclick = scrollToBottom;

/* One throttled scroll handler drives the jump button, read receipts and
   lazy loading. Work happens once per frame instead of once per event. */
let scrollQueued = false;

$("#messages").addEventListener("scroll", () => {
  if (scrollQueued) return;
  scrollQueued = true;

  requestAnimationFrame(() => {
    scrollQueued = false;
    const box = $("#messages");

    $("#jumpBtn").classList.toggle("hidden", nearBottom());
    markSeen();

    if (box.scrollTop < 80) loadOlderMessages();
  });
}, { passive: true });

/* Rebuilds a single bubble in place — used for edit / delete / reactions */
function updateMessage(key, data) {
  const old = msgNodes[key];
  if (!old) return;
  const fresh = buildMessage(key, data);
  /* replaceChild instead of replaceWith: same result, wider browser support */
  if (old.parentNode) old.parentNode.replaceChild(fresh, old);
  msgNodes[key] = fresh;
  applySearchTo(fresh, key);
}

function buildMessage(key, data) {
  const mine = isMine(data);

  const wrap = document.createElement("div");
  wrap.className = "msg " + (mine ? "me" : "other") + (data.deleted ? " deleted" : "");
  wrap.dataset.key = key;

  /* --- Sender name (hidden in private chats for my own messages) --- */
  if (!mine || activeChat === GROUP_ID) {
    const name = document.createElement("div");
    name.className = "msg-name";
    name.textContent = mine ? "You" : (data.sender || "Unknown");
    wrap.appendChild(name);
  }

  if (data.deleted) {
    const text = document.createElement("div");
    text.className = "msg-text";
    text.textContent = "This message was deleted.";
    wrap.appendChild(text);
    wrap.appendChild(buildMeta(data, mine));
    return wrap;
  }

  /* --- Quoted reply --- */
  if (data.replyTo) {
    const quote = document.createElement("div");
    quote.className = "msg-quote";

    const who = document.createElement("strong");
    who.textContent = data.replyTo.sender || "";
    quote.appendChild(who);

    const what = document.createElement("span");
    what.textContent = data.replyTo.text || "";
    quote.appendChild(what);

    wrap.appendChild(quote);
  }

  /* --- Image --- */
  if (data.image) {
    const img = document.createElement("img");
    img.className = "msg-img";
    img.loading = "lazy";
    img.src = data.image;
    img.alt = "Photo";
    img.onclick = (e) => {
      e.stopPropagation();
      $("#viewerImg").src = data.image;
      $("#imageViewer").classList.remove("hidden");
    };
    wrap.appendChild(img);
  }

  /* --- Voice note --- */
  if (data.audio) {
    const audio = document.createElement("audio");
    audio.className = "msg-audio";
    audio.controls = true;
    audio.preload = "none";
    audio.src = data.audio;
    audio.onclick = (e) => e.stopPropagation();
    wrap.appendChild(audio);
  }

  /* --- Text --- */
  if (data.text) {
    const text = document.createElement("div");
    text.className = "msg-text";
    text.textContent = data.text;
    wrap.appendChild(text);
  }

  wrap.appendChild(buildMeta(data, mine));

  /* --- Reactions --- */
  const reactions = data.reactions || {};
  const emojis = Object.keys(reactions).filter((e) => Object.keys(reactions[e] || {}).length);
  if (emojis.length) {
    const row = document.createElement("div");
    row.className = "reactions";
    emojis.forEach((emoji) => {
      const users = Object.keys(reactions[emoji]);
      const chip = document.createElement("span");
      chip.className = "reaction" + (users.includes(me.uid) ? " mine" : "");
      chip.textContent = emoji + " " + users.length;
      chip.title = users.map(displayName).join(", ");
      row.appendChild(chip);
    });
    wrap.appendChild(row);
  }

  wrap.onclick = () => openSheet(key);
  return wrap;
}

/* Time · edited flag · delivery ticks (ticks only for the sender) */
function buildMeta(data, mine) {
  const meta = document.createElement("div");
  meta.className = "msg-meta";

  if (data.edited && !data.deleted) {
    const edited = document.createElement("span");
    edited.className = "edited";
    edited.textContent = "Edited";
    meta.appendChild(edited);
  }

  const time = document.createElement("span");
  time.textContent = formatTime(data.timestamp);
  meta.appendChild(time);

  if (mine) {
    const ticks = document.createElement("span");
    ticks.className = "ticks";
    applyTickState(ticks, data.timestamp);
    meta.appendChild(ticks);
  }
  return meta;
}


/* =========================================================
   12 — READ RECEIPTS (delivered / seen)
   Instead of writing a flag on every message, each side stores one
   `deliveredAt` / `seenAt` timestamp. Ticks are derived from it, so a
   conversation of 300 messages still costs a single tiny write.
   ========================================================= */

function applyTickState(el, ts) {
  const status = tickStatus(ts);
  el.classList.toggle("seen", status === "seen");
  el.textContent = status === "sent" ? "✓" : "✓✓";
  el.title = status === "sent" ? "Sent" : status === "delivered" ? "Delivered" : "Seen";
}

function tickStatus(ts) {
  if (!ts) return "sent";

  /* Private chat: read the peer's single state node */
  if (activePeer) {
    const state = peerState[activePeer] || {};
    if (state.seenAt >= ts) return "seen";
    if (state.deliveredAt >= ts) return "delivered";
    return "sent";
  }

  /* Group chat: seen when every other member has read past this point */
  const others = Object.keys(usersMap).filter((uid) => uid !== me.uid);
  if (!others.length) return "sent";

  const readers = others.filter((uid) => (groupState[uid] || {}).seenAt >= ts);
  if (readers.length === others.length) return "seen";
  if (readers.length > 0) return "delivered";
  return others.some((uid) => usersMap[uid] && usersMap[uid].online) ? "delivered" : "sent";
}

function refreshAllTicks() {
  Object.keys(msgNodes).forEach((key) => {
    const data = msgCache[key];
    if (!data || !isMine(data)) return;
    const el = msgNodes[key].querySelector(".ticks");
    if (el) applyTickState(el, data.timestamp);
  });
}

function listenPeerState() {
  const ref = chatsRef.child(activeChat).child("state");
  const chatAtAttach = activeChat;

  const handler = ref.on("value", (snap) => {
    if (chatAtAttach !== activeChat) return;
    peerState = snap.val() || {};
    refreshAllTicks();
  }, (error) => describeDbError(error, ""));   // non-critical: ticks stay grey

  chatListeners.push(() => ref.off("value", handler));
}

/* Both writes are throttled so scrolling never floods the database */
let newestIncoming = 0;    // timestamp of the newest message from someone else
let lastSeenWrite = 0;
let markedSeenTs = 0;
let lastDeliveredWrite = 0;
let markedDeliveredTs = 0;

let seenRetry = null;
let deliveredRetry = null;

function markSeen() {
  if (!me.uid || document.hidden) return;
  if (newestIncoming <= markedSeenTs) return;              // nothing new to confirm

  /* The throttle used to simply drop the call. When several messages
     landed inside one window the last of them was never confirmed, so
     the sender kept seeing a single grey tick. Now the call comes back
     as soon as the window closes. */
  const now = Date.now();
  const wait = APP_CONFIG.RECEIPT_THROTTLE - (now - lastSeenWrite);
  if (wait > 0) {
    clearTimeout(seenRetry);
    seenRetry = setTimeout(markSeen, wait + 40);
    return;
  }

  clearTimeout(seenRetry);
  lastSeenWrite = now;
  markedSeenTs = newestIncoming;

  if (activePeer) {
    dbWrite(chatsRef.child(activeChat).child("state").child(me.uid)
      .update({ seenAt: TIMESTAMP, deliveredAt: TIMESTAMP }));
    dbWrite(chatIndexRef.child(me.uid).child(activePeer).child("unread").set(0));
  } else {
    dbWrite(groupStateRef.child(me.uid).update({ seenAt: TIMESTAMP }));
  }
}

function markDelivered() {
  if (!me.uid || !activePeer) return;
  if (newestIncoming <= markedDeliveredTs) return;

  const now = Date.now();
  const wait = APP_CONFIG.RECEIPT_THROTTLE - (now - lastDeliveredWrite);
  if (wait > 0) {
    clearTimeout(deliveredRetry);
    deliveredRetry = setTimeout(markDelivered, wait + 40);
    return;
  }

  clearTimeout(deliveredRetry);
  lastDeliveredWrite = now;
  markedDeliveredTs = newestIncoming;

  dbWrite(chatsRef.child(activeChat).child("state").child(me.uid)
    .update({ deliveredAt: TIMESTAMP }));
}

/* Reading is an interaction, not just a page load.
   (Scrolling already calls markSeen from the throttled handler above.) */
window.addEventListener("focus", markSeen);


/* =========================================================
   13 — SENDING: TEXT, IMAGE, VOICE NOTE
   ========================================================= */

const input = $("#messageInput");

input.addEventListener("input", () => {
  const length = input.value.length;
  const counter = $("#charCount");
  counter.textContent = length + "/" + MAX_MESSAGE;
  counter.classList.toggle("warn", length > MAX_MESSAGE - 100);

  /* Grow the box with the text, up to the CSS max-height */
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 130) + "px";

  setTyping(input.value.trim() !== "");
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$("#sendBtn").onclick = sendMessage;

/* Shared writer for every message type */
function pushMessage(payload) {
  if (!me.uid) return Promise.resolve(false);

  /* compact() removes every empty field, so a message never carries
     null, undefined or "" into the database */
  const data = compact({
    uid: me.uid,
    sender: me.username,
    text: payload.text,
    image: payload.image,
    audio: payload.audio,
    replyTo: replyTarget
      ? compact({ sender: replyTarget.sender, text: replyTarget.text, key: replyTarget.key })
      : null
  });

  /* A message must carry at least one kind of content */
  if (!data.text && !data.image && !data.audio) {
    toast("Nothing to send.");
    return Promise.resolve(false);
  }

  data.timestamp = TIMESTAMP;
  data.edited = false;
  data.deleted = false;

  const preview = previewOf(data);
  const ref = messagesRefOf(activeChat).push();

  /* The reply is cleared optimistically so the composer feels instant,
     but it is remembered: a failed send used to throw the quote away and
     the user had to find the message again. */
  const previousReply = replyTarget;
  clearReply();
  setTyping(false);

  /* The chat list is only updated once the message really landed */
  return write(ref.set(data), "Message failed to send.").then((ok) => {
    if (ok) {
      if (activePeer) updateChatIndex(preview);
      return true;
    }

    if (previousReply) {
      replyTarget = previousReply;
      $("#replyBarName").textContent = previousReply.sender;
      $("#replyBarText").textContent = previousReply.text;
      $("#replyBar").classList.remove("hidden");
    }
    return false;
  });
}

/* Writes both sides of the index: mine (read) and theirs (unread + 1) */
function updateChatIndex(preview) {
  if (!activePeer || !me.uid) return;

  /* `last` must never be empty, or the row would render blank */
  const base = { last: clean(preview) || "Message", ts: Date.now(), from: me.uid };

  dbWrite(chatIndexRef.child(me.uid).child(activePeer).update(Object.assign({ unread: 0 }, base)));
  dbWrite(chatIndexRef.child(activePeer).child(me.uid).update(base));
  dbWrite(chatIndexRef.child(activePeer).child(me.uid).child("unread")
    .transaction((current) => (current || 0) + 1));
}

function sendMessage() {
  if (sending) return;                       // blocks double taps / Enter spam

  const problem = validateMessageText(input.value);
  if (problem) {
    toast(problem);
    return;
  }

  const text = clean(input.value);
  sending = true;
  $("#sendBtn").disabled = true;

  const finish = () => {
    sending = false;
    $("#sendBtn").disabled = false;
  };

  /* Editing reuses the composer */
  if (editingKey) {
    const key = editingKey;
    const original = msgCache[key];

    /* Re-check ownership at write time, not just when the sheet opened */
    if (!original || !isMine(original) || original.deleted) {
      toast("You can only edit your own messages.");
      cancelEdit();
      resetComposer();
      finish();
      return;
    }

    write(
      messagesRefOf(activeChat).child(key).update({ text: text, edited: true }),
      "Could not edit the message."
    ).then((ok) => {
      if (ok) toast("Message updated");
      finish();
    });

    cancelEdit();
    resetComposer();
    return;
  }

  pushMessage({ text: text }).then(finish);
  resetComposer();
}

function resetComposer() {
  input.value = "";
  input.style.height = "auto";
  $("#charCount").textContent = "0/" + MAX_MESSAGE;
  $("#charCount").classList.remove("warn");
}

/* ---------- Image ---------- */

$("#imageBtn").onclick = () => $("#imageInput").click();

$("#imageInput").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";           // allow picking the same file twice
  if (!file) return;

  if (file.type && file.type.indexOf("image/") !== 0) {
    toast("That file is not an image.");
    return;
  }
  if (sending) return;

  sending = true;
  toast("Preparing photo…");

  try {
    const dataUrl = await compressImage(file, APP_CONFIG.IMAGE_MAX_SIDE, 0.72);

    if (!dataUrl || dataUrl.indexOf("data:image") !== 0) {
      toast("Image failed. Try another photo.");
      return;
    }
    if (dataUrl.length > APP_CONFIG.MEDIA_MAX_CHARS) {
      toast("That photo is too large to send.");
      return;
    }
    await pushMessage({ image: dataUrl });
  } catch (err) {
    toast("Image failed. Could not read that photo.");
  } finally {
    sending = false;
  }
};

/* ---------- Voice note ---------- */

$("#micBtn").onclick = () => {
  if (mediaRecorder && mediaRecorder.state === "recording") return;
  startRecording();
};

/* Recording needs getUserMedia + MediaRecorder + a secure origin (https).
   Chrome, Edge, Firefox and Android Chrome all qualify; anything else
   simply loses the button instead of throwing. */
function recordingSupported() {
  return !!(navigator.mediaDevices &&
            navigator.mediaDevices.getUserMedia &&
            window.MediaRecorder);
}

/* Different browsers support different containers — pick the first that works */
function pickAudioType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";

  for (let i = 0; i < candidates.length; i++) {
    if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
  }
  return "";
}

async function startRecording() {
  if (!recordingSupported()) {
    toast("Voice notes are not supported in this browser.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks = [];

    const mimeType = pickAudioType();
    const options = { audioBitsPerSecond: 16000 };
    if (mimeType) options.mimeType = mimeType;

    mediaRecorder = new MediaRecorder(stream, options);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = () => stream.getTracks().forEach((t) => t.stop());
    mediaRecorder.start();

    recStart = Date.now();
    $("#recordBar").classList.remove("hidden");
    $("#micBtn").classList.add("recording");

    recTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - recStart) / 1000);
      $("#recTime").textContent = Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");
      if (secs >= REC_MAX_SEC) finishRecording(true);
    }, 250);
  } catch (err) {
    /* NotAllowedError = permission refused, NotFoundError = no microphone */
    const name = (err && err.name) || "";
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      toast("No microphone was found.");
    } else if (name === "NotAllowedError" || name === "SecurityError") {
      toast("Microphone permission is needed for voice notes.");
    } else {
      toast("Voice note failed to start.");
    }

    clearInterval(recTimer);
    mediaRecorder = null;
    $("#recordBar").classList.add("hidden");
    $("#micBtn").classList.remove("recording");
  }
}

$("#recSend").onclick = () => finishRecording(true);
$("#recCancel").onclick = () => finishRecording(false);

function finishRecording(send) {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;

  clearInterval(recTimer);
  $("#recordBar").classList.add("hidden");
  $("#micBtn").classList.remove("recording");
  $("#recTime").textContent = "0:00";

  mediaRecorder.addEventListener("stop", () => {
    if (!send || !recChunks.length) return;

    try {
      const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      if (!blob.size) {
        toast("Voice note failed. Nothing was recorded.");
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => toast("Voice note failed to encode.");
      reader.onload = () => {
        if (typeof reader.result !== "string" || reader.result.indexOf("data:") !== 0) {
          toast("Voice note failed to encode.");
          return;
        }
        if (reader.result.length > APP_CONFIG.MEDIA_MAX_CHARS) {
          toast("That voice note is too long to send.");
          return;
        }
        pushMessage({ audio: reader.result });
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      toast("Voice note failed.");
    }
  }, { once: true });

  try {
    mediaRecorder.stop();
  } catch (err) {
    toast("Voice note failed to stop cleanly.");
  }
}


/* =========================================================
   14 — TYPING INDICATOR
   ========================================================= */

let typingActive = false;   // mirrors what the database currently holds

function setTyping(active) {
  if (!me.uid) return;
  const scope = typingRef.child(activeChat).child(me.uid);

  if (active) {
    /* One write per typing burst — the timer is refreshed locally,
       so a long message costs a single write instead of one per key. */
    if (!typingActive) {
      typingActive = true;
      dbWrite(scope.set(me.username));
      dbWrite(scope.onDisconnect().remove());
    }
    clearTimeout(window.typingTimer);
    window.typingTimer = setTimeout(() => {
      typingActive = false;
      dbWrite(scope.remove());
    }, 2500);
    return;
  }

  clearTimeout(window.typingTimer);
  if (!typingActive) return;      // already clear: no write needed
  typingActive = false;
  dbWrite(scope.remove());
}

function listenTyping() {
  const ref = typingRef.child(activeChat);
  const chatAtAttach = activeChat;

  /* If the tab dies while typing, the flag removes itself */
  dbWrite(typingRef.child(activeChat).child(me.uid).onDisconnect().remove());

  const handler = ref.on("value", (snap) => {
    if (chatAtAttach !== activeChat) return;

    const typing = snap.val() || {};
    const names = Object.keys(typing)
      .filter((uid) => uid !== me.uid)
      .map((uid) => typing[uid]);

    const el = $("#typingIndicator");
    if (!names.length) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }

    el.classList.remove("hidden");
    el.textContent = names.length === 1
      ? names[0] + " is typing…"
      : names.slice(0, 2).join(", ") + (names.length > 2 ? " and others are" : " are") + " typing…";
  }, (error) => describeDbError(error, ""));   // non-critical

  chatListeners.push(() => ref.off("value", handler));
}


/* =========================================================
   15 — ACTION SHEET: reply, copy, pin, edit, delete, react
   ========================================================= */

function openSheet(key) {
  const data = msgCache[key];
  if (!data || data.deleted) return;

  sheetKey = key;
  const mine = isMine(data);

  /* Edit and delete belong to the sender only */
  $$("#actionSheet .own-only").forEach((btn) => btn.classList.toggle("hidden", !mine));
  /* Text-only actions */
  $("#actionSheet [data-act='copy']").classList.toggle("hidden", !data.text);
  $("#actionSheet [data-act='edit']").classList.toggle("hidden", !mine || !data.text);

  $("#actionSheet").classList.remove("hidden");
}

function closeSheet() {
  $("#actionSheet").classList.add("hidden");
  sheetKey = null;
}

$("#actionSheet").onclick = (e) => {
  if (e.target.id === "actionSheet") closeSheet();
};

/* Reactions — one per user per emoji, tapping again removes it */
$$("#actionSheet .react").forEach((btn) => {
  btn.onclick = () => {
    if (!sheetKey) return;
    const emoji = btn.dataset.emoji;
    const key = sheetKey;
    const data = msgCache[key];
    if (!data || data.deleted) { closeSheet(); return; }

    const ref = messagesRefOf(activeChat).child(key)
      .child("reactions").child(emoji).child(me.uid);

    /* A transaction toggles in ONE round trip: null removes, true adds */
    write(
      ref.transaction((current) => (current ? null : true)),
      "Could not save your reaction."
    );
    closeSheet();
  };
});

$$("#actionSheet .sheet-item").forEach((btn) => {
  btn.onclick = () => {
    const act = btn.dataset.act;
    const key = sheetKey;
    const data = key ? msgCache[key] : null;
    closeSheet();
    if (!data && act !== "cancel") return;

    if (act === "reply") startReply(key, data);
    if (act === "copy") copyText(data);
    if (act === "pin") pinMessage(key, data);
    if (act === "edit") startEdit(key, data);
    if (act === "delete") deleteMessage(key);
  };
});

/* ---------- Reply ---------- */

function startReply(key, data) {
  replyTarget = { sender: data.sender || "Unknown", text: previewOf(data), key: key };
  $("#replyBarName").textContent = replyTarget.sender;
  $("#replyBarText").textContent = replyTarget.text;
  $("#replyBar").classList.remove("hidden");
  input.focus();
}

function clearReply() {
  replyTarget = null;
  $("#replyBar").classList.add("hidden");
}

$("#replyCancel").onclick = clearReply;

/* ---------- Copy ---------- */

function copyText(data) {
  const text = (data && data.text) || "";
  if (!text) return;

  /* The async Clipboard API needs a secure context; older browsers and
     plain http fall back to a hidden textarea. */
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(
      () => toast("Copied"),
      () => legacyCopy(text)
    );
    return;
  }
  legacyCopy(text);
}

function legacyCopy(text) {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();

    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    toast(ok ? "Copied" : "Could not copy");
  } catch (err) {
    toast("Could not copy");
  }
}

/* ---------- Pin (one pinned message per conversation) ---------- */

function pinMessage(key, data) {
  if (!key || !data || data.deleted) {
    toast("That message cannot be pinned.");
    return;
  }

  write(
    pinsRef.child(activeChat).set({
      key: key,
      text: clean(previewOf(data)) || "Message",
      sender: data.sender || "Unknown"
    }),
    "Could not pin the message."
  ).then((ok) => { if (ok) toast("Message pinned"); });
}

function listenPin() {
  const ref = pinsRef.child(activeChat);
  const chatAtAttach = activeChat;

  const handler = ref.on("value", (snap) => {
    if (chatAtAttach !== activeChat) return;
    pinned = snap.val();
    renderPin();
  }, (error) => describeDbError(error, ""));   // non-critical

  chatListeners.push(() => ref.off("value", handler));
}

function renderPin() {
  const bar = $("#pinnedBar");
  if (!pinned) {
    bar.classList.add("hidden");
    return;
  }
  $("#pinnedName").textContent = pinned.sender;
  $("#pinnedText").textContent = pinned.text;
  bar.classList.remove("hidden");
}

/* Tapping the pinned bar jumps to the original message */
$("#pinnedBar").onclick = (e) => {
  if (e.target.id === "pinnedRemove") return;
  if (!pinned) return;

  const node = msgNodes[pinned.key];
  if (!node) {
    toast("That message is older than the loaded history.");
    return;
  }
  node.scrollIntoView({ block: "center" });
  node.classList.add("flash");
  setTimeout(() => node.classList.remove("flash"), 1200);
};

$("#pinnedRemove").onclick = (e) => {
  e.stopPropagation();
  write(pinsRef.child(activeChat).remove(), "Could not unpin the message.")
    .then((ok) => { if (ok) toast("Message unpinned"); });
};

/* ---------- Edit ---------- */

function startEdit(key, data) {
  editingKey = key;
  input.value = data.text || "";
  input.dispatchEvent(new Event("input"));
  $("#editBarText").textContent = previewOf(data);
  $("#editBar").classList.remove("hidden");
  clearReply();
  input.focus();
}

function cancelEdit() {
  editingKey = null;
  $("#editBar").classList.add("hidden");
}

$("#editCancel").onclick = () => {
  cancelEdit();
  resetComposer();
};

/* ---------- Delete for everyone ---------- */

function deleteMessage(key) {
  const data = msgCache[key];

  /* Ownership is checked again here, not only when the sheet opened */
  if (!data || !isMine(data)) {
    toast("You can only delete your own messages.");
    return;
  }
  if (data.deleted) return;
  if (!confirm("Delete this message for everyone?")) return;

  /* The message stays in place as a tombstone. `null` is Firebase's own
     delete instruction, which is why these fields are removed rather
     than written as empty strings. */
  write(
    messagesRefOf(activeChat).child(key).update({
      text: null,
      image: null,
      audio: null,
      reactions: null,
      deleted: true
    }),
    "Could not delete the message."
  ).then((ok) => {
    if (!ok) return;
    toast("Message deleted");

    if (pinned && pinned.key === key) dbWrite(pinsRef.child(activeChat).remove());

    if (activePeer) {
      const note = { last: "This message was deleted." };
      dbWrite(chatIndexRef.child(me.uid).child(activePeer).update(note));
      dbWrite(chatIndexRef.child(activePeer).child(me.uid).update(note));
    }
  });
}


/* =========================================================
   16 — SEARCH (name / message / date)
   ========================================================= */

let searchQuery = "";

$("#searchToggle").onclick = () => {
  const bar = $("#searchBar");
  const opening = bar.classList.contains("hidden");
  bar.classList.toggle("hidden", !opening);
  if (opening) $("#searchInput").focus();
  else closeSearch();
};

$("#searchClear").onclick = closeSearch;

let searchTimer = null;

$("#searchInput").oninput = (e) => {
  const value = e.target.value.trim().toLowerCase();

  /* Debounced: filtering runs once the user pauses, not per keystroke */
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = value;
    applySearch();
  }, APP_CONFIG.SEARCH_DEBOUNCE);
};

function closeSearch() {
  clearTimeout(searchTimer);
  searchQuery = "";
  const bar = $("#searchBar");
  if (bar) bar.classList.add("hidden");
  const field = $("#searchInput");
  if (field) field.value = "";
  applySearch();
}

/* Everything searchable about a message: who, what, and when */
function haystack(data) {
  return [
    data.sender || "",
    data.text || "",
    data.image ? "photo image" : "",
    data.audio ? "voice note audio" : "",
    dayLabel(data.timestamp),
    new Date(data.timestamp || Date.now()).toLocaleDateString(),
    formatTime(data.timestamp)
  ].join(" ").toLowerCase();
}

function applySearch() {
  Object.keys(msgNodes).forEach((key) => applySearchTo(msgNodes[key], key));
  /* Date separators only make sense in the unfiltered view */
  $$(".day-divider").forEach((d) => d.classList.toggle("hidden", !!searchQuery));
}

function applySearchTo(node, key) {
  const data = msgCache[key];
  if (!node || !data) return;

  if (!searchQuery) {
    node.classList.remove("hidden");
    restoreText(node, data);
    return;
  }

  const match = haystack(data).includes(searchQuery);
  node.classList.toggle("hidden", !match);
  if (match) highlightText(node, data);
}

function restoreText(node, data) {
  const el = node.querySelector(".msg-text");
  if (el && !data.deleted) el.textContent = data.text || "";
}

/* Wraps each occurrence of the query in <mark> without touching markup */
function highlightText(node, data) {
  const el = node.querySelector(".msg-text");
  if (!el || !data.text) return;

  const text = data.text;
  const lower = text.toLowerCase();
  el.innerHTML = "";

  let cursor = 0;
  let index = lower.indexOf(searchQuery);

  while (index !== -1) {
    el.appendChild(document.createTextNode(text.slice(cursor, index)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(index, index + searchQuery.length);
    el.appendChild(mark);
    cursor = index + searchQuery.length;
    index = lower.indexOf(searchQuery, cursor);
  }
  el.appendChild(document.createTextNode(text.slice(cursor)));
}


/* =========================================================
   17 — SETTINGS & PROFILE EDITING
   ========================================================= */

let pendingPhoto = null;   // holds a newly picked photo until Save is pressed

$("#settingsBtn").onclick = () => {
  const user = usersMap[me.uid] || {};
  pendingPhoto = null;

  $("#setUsername").value = user.username || me.username || "";
  $("#setAge").value = user.age || "";
  $("#setPhone").value = localStorage.getItem("tinder_phone") || "";
  $("#setPassCurrent").value = "";
  $("#setPassNew").value = "";
  paintAvatar($("#setPhotoPreview"), user, false);

  $("#settingsModal").classList.remove("hidden");
};

$("#settingsClose").onclick = () => $("#settingsModal").classList.add("hidden");

$("#photoBtn").onclick = () => $("#photoInput").click();

$("#photoInput").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  if (file.type && file.type.indexOf("image/") !== 0) {
    toast("That file is not an image.");
    return;
  }

  try {
    /* Profile photos are tiny on purpose: they load with every list */
    const dataUrl = await compressImage(file, APP_CONFIG.PHOTO_MAX_SIDE, 0.7);

    if (!dataUrl || dataUrl.indexOf("data:image") !== 0) {
      toast("Image failed. Try another photo.");
      return;
    }

    pendingPhoto = dataUrl;
    paintAvatar($("#setPhotoPreview"), { photo: pendingPhoto }, false);
  } catch (err) {
    toast("Image failed. Could not read that photo.");
  }
};

$("#photoRemove").onclick = () => {
  pendingPhoto = "";
  paintAvatar($("#setPhotoPreview"), { username: $("#setUsername").value || me.username }, false);
};

$("#settingsSave").onclick = async () => {
  if (savingProfile) return;                     // blocks a double tap on Save

  const username = clean($("#setUsername").value).replace(/\s+/g, " ");
  const age = clean($("#setAge").value);

  /* --- Validation --- */
  const nameError = validateUsername(username);
  if (nameError) {
    toast(nameError);
    return;
  }

  const ageError = validateAge(age);
  if (ageError) {
    toast(ageError);
    return;
  }

  /* --- Duplicate username protection, from the already-loaded members
         list, so this costs no extra database read --- */
  const target = normaliseName(username);
  const clash = Object.keys(usersMap).some(
    (uid) => uid !== me.uid && usersMap[uid] && normaliseName(usersMap[uid].username) === target
  );

  if (clash) {
    toast("This username is already in use.");
    return;
  }

  /* null tells Firebase to delete the field — that is how "no age" and
     "no photo" are stored, instead of writing an empty string */
  const update = {
    username: username,
    age: age === "" ? null : age,
    online: true,
    lastSeen: TIMESTAMP
  };
  if (pendingPhoto !== null) update.photo = pendingPhoto === "" ? null : pendingPhoto;

  savingProfile = true;
  const saveBtn = $("#settingsSave");
  saveBtn.disabled = true;

  /* --- Optional password change --- */
  const currentPass = $("#setPassCurrent").value || "";
  const newPass = $("#setPassNew").value || "";
  let newAuth = null;

  if (currentPass || newPass) {
    const release = () => { savingProfile = false; saveBtn.disabled = false; };

    if (!passwordsSupported()) {
      toast("Changing a password needs a secure (https) connection.");
      release();
      return;
    }

    const passError = validatePassword(newPass);
    if (passError) {
      toast(passError);
      release();
      return;
    }

    const stored = (usersMap[me.uid] || {}).auth;

    /* An existing password must be proved before it can be replaced */
    if (stored) {
      let correct = false;
      try {
        correct = await passwordMatches(currentPass, stored);
      } catch (err) {
        toast("Could not check your password. Try again.");
        release();
        return;
      }
      if (!correct) {
        toast("Your current password is not correct.");
        release();
        return;
      }
    }

    try {
      newAuth = await buildAuthRecord(newPass);
    } catch (err) {
      toast("Could not save the new password.");
      release();
      return;
    }
  }

  if (newAuth) update.auth = newAuth;

  /* One write, then the users listener refreshes every screen instantly */
  write(usersRef.child(me.uid).update(update), "Profile save failed.").then((ok) => {
    savingProfile = false;
    saveBtn.disabled = false;
    if (!ok) return;

    me.username = username;
    me.age = age;
    if (pendingPhoto !== null) me.photo = pendingPhoto;

    localStorage.setItem("tinder_user", username);
    localStorage.setItem("tinder_phone", clean($("#setPhone").value));

    $("#setPassCurrent").value = "";
    $("#setPassNew").value = "";

    $("#settingsModal").classList.add("hidden");
    toast(newAuth ? "Profile and password saved" : "Profile saved");
  });
};


/* =========================================================
   18 — MEMBERS MODAL
   ========================================================= */

$("#onlineBtn").onclick = () => {
  renderMembers();
  $("#membersModal").classList.remove("hidden");
};

$("#membersClose").onclick = () => $("#membersModal").classList.add("hidden");

function renderMembers() {
  const list = $("#membersList");
  if (!list) return;

  const uids = Object.keys(usersMap).sort((a, b) => {
    const ua = usersMap[a] || {}, ub = usersMap[b] || {};
    if (!!ub.online !== !!ua.online) return ub.online ? 1 : -1;   // online first
    return displayName(a).localeCompare(displayName(b));
  });

  const fragment = document.createDocumentFragment();

  uids.forEach((uid) => {
    const user = usersMap[uid] || {};
    const row = document.createElement("div");
    row.className = "member";

    row.appendChild(avatarWithPresence(user, false, "md"));

    const info = document.createElement("div");
    info.className = "info";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = (user.username || uid) + (uid === me.uid ? " (you)" : "");
    if (user.age) {
      const age = document.createElement("span");
      age.className = "age";
      age.textContent = "Age " + user.age;
      name.appendChild(age);
    }
    info.appendChild(name);

    const seen = document.createElement("div");
    seen.className = "seen" + (user.online ? " on" : "");
    seen.textContent = user.online ? "Online now" : "Last seen " + relativeTime(user.lastSeen);
    info.appendChild(seen);

    row.appendChild(info);

    if (uid !== me.uid) {
      const link = document.createElement("span");
      link.className = "msg-link";
      link.textContent = "Message";
      row.appendChild(link);
      row.style.cursor = "pointer";
      row.onclick = () => {
        $("#membersModal").classList.add("hidden");
        openChat(uid);
      };
    }

    fragment.appendChild(row);
  });

  list.innerHTML = "";
  list.appendChild(fragment);
}


/* =========================================================
   19 — BROWSER NOTIFICATIONS
   Never fired for your own messages, and never for the conversation
   you are actively reading.
   ========================================================= */

/* Some browsers expose window.Notification but leave it undefined (private
   mode, embedded webviews), so checking the property alone is not enough. */
function notificationsAvailable() {
  try {
    return typeof Notification !== "undefined" && !!Notification && typeof Notification.permission === "string";
  } catch (err) {
    return false;
  }
}

function askNotificationPermission() {
  if (!notificationsAvailable()) return;
  if (Notification.permission !== "default") return;

  try {
    /* Older browsers return undefined and take a callback instead */
    const result = Notification.requestPermission(() => {});
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch (err) {
    /* Permission simply stays unset — notifications are optional */
  }
}

/* `tag` was a single fixed string, so a message from one person silently
   replaced the notification from another and only the last one was ever
   seen. Tagging per conversation keeps one notification per chat. */
function notify(title, body, tag) {
  if (!notificationsAvailable() || Notification.permission !== "granted") return;

  try {
    const n = new Notification("TINDER · " + title, {
      body: body,
      tag: "tinder-" + (tag || "msg"),
      icon: "icon-192.png",
      badge: "icon-192.png"
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (err) { /* some browsers block constructor notifications */ }
}


/* =========================================================
   20 — BOOT
   ========================================================= */

/* Image viewer. Clearing the src on close releases the decoded photo,
   which matters because images travel as data URLs here. */
function closeViewer() {
  $("#imageViewer").classList.add("hidden");
  $("#viewerImg").src = "";
}

$("#imageViewer").onclick = closeViewer;

/* Feature detection: a control that cannot work should not be on screen.
   Recording also needs https, which is why the check runs at boot rather
   than when the button is pressed. */
if (!recordingSupported()) {
  $("#micBtn").classList.add("hidden");
}

/* Escape closes whatever is on top */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#actionSheet").classList.contains("hidden")) return closeSheet();
  if (!$("#imageViewer").classList.contains("hidden")) return closeViewer();
  if (!$("#installHelp").classList.contains("hidden")) return $("#installHelp").classList.add("hidden");
  if (!$("#settingsModal").classList.contains("hidden")) return $("#settingsModal").classList.add("hidden");
  if (!$("#membersModal").classList.contains("hidden")) return $("#membersModal").classList.add("hidden");
  if (!$("#searchBar").classList.contains("hidden")) return closeSearch();
});

/* Close modals when the backdrop itself is clicked */
["settingsModal", "membersModal", "installHelp"].forEach((id) => {
  $("#" + id).addEventListener("click", (e) => {
    if (e.target.id === id) $("#" + id).classList.add("hidden");
  });
});

/* =========================================================
   21 — PWA INSTALL  (the 📥 button beside the search icon)

   The install event itself is captured by a tiny script in the
   <head> of index.html, before anything else on the page runs.
   That matters for two reasons:

     • Chrome fires beforeinstallprompt very early. This section
       used to attach its listener at the very bottom of app.js,
       after autoLogin() had already started a whole session of
       work, so the event was regularly missed. When it is missed
       nothing calls preventDefault, and Chrome falls back to its
       own install bar across the bottom of the screen — which is
       exactly what was showing instead of this button.

     • A missed event also means the button has no prompt to open,
       so tapping it did nothing at all.

   The button is now visible whenever the app is running in a
   browser, and hides itself once the app is actually installed.
   ========================================================= */

const installBtn = $("#installBtn");

/* Already running as an installed app? Then there is nothing to install.
   iOS reports this through a non-standard property of its own. */
function isStandalone() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
         window.navigator.standalone === true;
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
         (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function refreshInstallBtn() {
  if (!installBtn) return;
  installBtn.classList.toggle("hidden", isStandalone());
}

/* Safari and a few in-app browsers never fire beforeinstallprompt, so
   there is no prompt to open. Rather than a button that does nothing,
   the card explains the manual route AND reports what the browser
   actually thinks, so a failing requirement is visible instead of
   having to be guessed at. */
function showInstallHelp() {
  const text = isIos()
    ? "Open this page in Safari, tap the Share button, then choose \u201cAdd to Home Screen\u201d."
    : "Chrome only offers the install dialog once the page has fully settled. Open the browser menu (\u22ee) and choose \u201cInstall app\u201d, or check the list below.";

  $("#installHelpText").textContent = text;
  $("#installHelp").classList.remove("hidden");
  runInstallDiagnostics();
}

/* Every requirement Chrome checks before it will offer an install */
async function runInstallDiagnostics() {
  const box = $("#installDiag");
  if (!box) return;

  box.textContent = "Checking\u2026";

  const rows = [];
  const add = (label, ok, note) => rows.push({ label, ok, note });

  add("Secure connection (https)", !!window.isSecureContext);

  /* An install needs an ACTIVE worker. On a first visit it is still
     installing, which is the usual reason a fresh page cannot install
     yet — and why a reload so often fixes it. */
  let swOk = false;
  let swNote = "not supported by this browser";
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      swOk = !!(reg && reg.active);
      swNote = !reg ? "not registered yet"
             : reg.active ? ""
             : "still installing \u2014 reload the page";
    } catch (err) {
      swNote = "could not be checked";
    }
  }
  add("Service worker active", swOk, swNote);

  /* Manifest, and then every icon it points at */
  let icons = [];
  let manifestOk = false;
  let manifestNote = "";
  try {
    const res = await fetch("manifest.json", { cache: "no-store" });
    manifestOk = res.ok;
    manifestNote = res.ok ? "" : "HTTP " + res.status;
    if (res.ok) {
      const data = await res.json();
      icons = Array.isArray(data.icons) ? data.icons : [];
    }
  } catch (err) {
    manifestNote = "could not be fetched";
  }
  add("manifest.json", manifestOk, manifestNote);

  const missing = [];
  for (let i = 0; i < icons.length; i++) {
    const src = icons[i].src;
    try {
      const res = await fetch(src, { cache: "no-store" });
      if (!res.ok) missing.push(src + " (HTTP " + res.status + ")");
    } catch (err) {
      missing.push(src + " (unreachable)");
    }
  }
  add("Icon files (" + icons.length + ")", icons.length > 0 && !missing.length, missing.join(", "));

  /* Chrome stays silent when the app is already on the home screen */
  let installedNote = "";
  if (isStandalone()) {
    installedNote = "you are already running the installed app";
  } else if (navigator.getInstalledRelatedApps) {
    try {
      const apps = await navigator.getInstalledRelatedApps();
      if (apps && apps.length) installedNote = "already installed \u2014 uninstall it to see the prompt again";
    } catch (err) { /* not available everywhere */ }
  }

  add(
    "Install prompt received",
    !!window.__installPrompt,
    installedNote || "Chrome has not offered one yet. Stay on the page a few seconds, reload once, then tap \uD83D\uDCE5 again."
  );

  /* ---- render ---- */
  box.textContent = "";
  rows.forEach((row) => {
    const line = document.createElement("div");
    line.className = "diag-row" + (row.ok ? "" : " bad");

    const mark = document.createElement("span");
    mark.className = "diag-mark";
    mark.textContent = row.ok ? "\u2705" : "\u26A0\uFE0F";
    line.appendChild(mark);

    const body = document.createElement("div");
    body.className = "diag-body";

    const label = document.createElement("span");
    label.className = "diag-label";
    label.textContent = row.label;
    body.appendChild(label);

    if (row.note) {
      const note = document.createElement("span");
      note.className = "diag-note";
      note.textContent = row.note;
      body.appendChild(note);
    }

    line.appendChild(body);
    box.appendChild(line);
  });
}

$("#installHelpClose").onclick = () => $("#installHelp").classList.add("hidden");

let installing = false;

installBtn?.addEventListener("click", async () => {
  if (installing) return;                 // blocks a double tap

  const prompt = window.__installPrompt;
  if (!prompt) {
    showInstallHelp();
    return;
  }

  installing = true;
  installBtn.disabled = true;

  try {
    prompt.prompt();
    const choice = await prompt.userChoice;
    toast(choice && choice.outcome === "accepted" ? "Installing TINDER\u2026" : "Install cancelled");
  } catch (err) {
    showInstallHelp();
  } finally {
    /* A saved prompt can only be used once. Chrome fires a fresh
       beforeinstallprompt if the app is still installable. */
    window.__installPrompt = null;
    installing = false;
    installBtn.disabled = false;
  }
});

window.addEventListener("installready", () => {
  refreshInstallBtn();

  /* The event often arrives a few seconds after the page settles. If the
     help card is open at that moment, close it and install immediately
     rather than making the user find the button again. */
  if (!$("#installHelp").classList.contains("hidden")) {
    $("#installHelp").classList.add("hidden");
    toast("Ready to install");
    installBtn?.click();
  }
});

window.addEventListener("installdone", () => {
  toast("TINDER installed");
  refreshInstallBtn();
});

/* Launching the installed app from the home screen should hide the button */
if (window.matchMedia) {
  const standaloneQuery = window.matchMedia("(display-mode: standalone)");
  if (standaloneQuery.addEventListener) standaloneQuery.addEventListener("change", refreshInstallBtn);
  else if (standaloneQuery.addListener) standaloneQuery.addListener(refreshInstallBtn);
}

refreshInstallBtn();

/* The session is started last, on purpose. It kicks off a long chain of
   Firebase work, and if any part of that ever throws, everything wired
   up above it — including the install button — is already in place. */
autoLogin();
