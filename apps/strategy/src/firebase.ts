// Own, independent Firebase init — same project as the legacy Hub (index.html currently
// initializes the v9.23.0 compat SDK against this exact config), but via the modern modular
// SDK, and never touching anything the legacy page set up. This is deliberate: the auth-spike
// question is whether a session established by the OLD compat SDK is readable by a NEW
// modular-SDK app on the same origin — reading a legacy global instead would answer a
// different, less useful question (and the working-instructions doc explicitly forbids it:
// Strategy OS must get its own ID token, never read a user object out of a legacy global).
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

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

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
