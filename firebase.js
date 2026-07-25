/* ================= TINDER — firebase.js ================= */

const firebaseConfig = {
  apiKey: "AIzaSyCs8Rz0t7vKwTAS14zsuaTaM2691RjwcuA",
  authDomain: "tinder-9bbeb.firebaseapp.com",
  databaseURL: "https://tinder-9bbeb-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "tinder-9bbeb",
  storageBucket: "tinder-9bbeb.firebasestorage.app",
  messagingSenderId: "967709156109",
  appId: "1:967709156109:web:c67e1f1f1ca0ac0adbc644"
};

/* ---- Initialize (Realtime Database only, no Firestore, no Auth) ---- */
firebase.initializeApp(firebaseConfig);

const db = firebase.database();

/* ---- Shared references ---- */
const usersRef = db.ref("users");
const messagesRef = db.ref("messages");
const typingRef = db.ref("typing");
const connectedRef = db.ref(".info/connected");

/* ---- Helpers ---- */
const TIMESTAMP = firebase.database.ServerValue.TIMESTAMP;