// Own, independent Firebase init — same project as the legacy Hub, via the modern modular
// SDK. See the Step 1 auth-spike commit for why this is safe: a session established by
// the legacy compat SDK is genuinely visible here, confirmed live on a real deploy.
//
// Every Firebase interaction in this app goes through the small wrapper API below
// (onAuthChange/getIdTokenOrNull/listenPath) rather than components importing
// onAuthStateChanged/ref/onValue from "firebase/auth"/"firebase/database" directly. That's
// not just tidiness: in test mode (import.meta.env.MODE === "test") this file swaps in
// firebase.fake.ts — a lightweight HTTP-polling fake backed by the same fake RTDB server
// every other test in this repo already uses — instead of the real SDK, which would
// otherwise try to reach Loona's actual production Firebase project from every Playwright
// test. Keeping the swap at this one boundary means every screen built on top of these
// three functions is automatically testable, with no per-component test-mode branching.
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, type User } from "firebase/auth";
import { getDatabase, onValue, ref } from "firebase/database";
import * as fake from "./firebase.fake";

const firebaseConfig = {
  apiKey: "AIzaSyBnESbCpAiVcSPHOZk4ANFwlIqw7DhB4A0",
  authDomain: "loona-hub-c85d7.firebaseapp.com",
  databaseURL: "https://loona-hub-c85d7-default-rtdb.firebaseio.com",
  projectId: "loona-hub-c85d7",
  storageBucket: "loona-hub-c85d7.firebasestorage.app",
  messagingSenderId: "8715646518",
  appId: "1:8715646518:web:59ec314c8eb4849bb84a97",
  measurementId: "G-2KGSH3TNPM",
};

const isTestMode = import.meta.env.MODE === "test";

const app = isTestMode ? null : initializeApp(firebaseConfig);
const realAuth = app ? getAuth(app) : null;
const realDb = app ? getDatabase(app) : null;

export type CurrentUser = { uid: string; email: string | null; displayName: string | null };

let currentUser: CurrentUser | null = null;

export function onAuthChange(cb: (user: CurrentUser | null) => void): () => void {
  if (isTestMode) return fake.onAuthChange((u) => { currentUser = u; cb(u); });
  return onAuthStateChanged(realAuth!, (u: User | null) => {
    currentUser = u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null;
    cb(currentUser);
  });
}

export async function getIdTokenOrNull(): Promise<string | null> {
  if (isTestMode) return fake.getIdTokenOrNull();
  return realAuth?.currentUser ? realAuth.currentUser.getIdToken() : null;
}

export function listenPath<T>(path: string, cb: (value: T | null) => void): () => void {
  if (isTestMode) return fake.listenPath<T>(path, cb);
  return onValue(ref(realDb!, path), (snap) => cb((snap.val() as T | null) ?? null));
}
