# Petpooja → LOONA Hub · Live Attendance Setup

This connects the hub to Petpooja Payroll so the attendance cards, calendar and
founder board show **real** punch data instead of placeholders.

The design keeps your **Client Secret server-side** (in Netlify environment
variables). It is never placed in `index.html`, so it can't be stolen from the
browser. The hub only ever talks to your own function, which returns safe,
already-computed data.

```
Browser (index.html)  →  /.netlify/functions/petpooja-attendance  →  Petpooja API
        (no secret)              (holds the secret via env vars)
```

---

## Files

| File | Where it goes |
|------|----------------|
| `index.html` | site root |
| `netlify.toml` | site root |
| `netlify/functions/petpooja-attendance.js` | keep this exact path |
| `test-petpooja.js` | run locally only (do not deploy) |

---

## Step 1 — Set the credentials in Netlify (never in code)

Netlify → **Site settings → Environment variables** → add:

| Key | Value |
|-----|-------|
| `PETPOOJA_CLIENT_ID` | `48271593` |
| `PETPOOJA_CLIENT_SECRET` | *(your secret)* |
| `PETPOOJA_BASE_URL` | `https://payrolltp.petpooja.com` |

> Because the secret was shared over chat, consider asking Petpooja to **rotate**
> it once, then use the new value here.

## Step 2 — Deploy

Push these files to the repo Netlify builds (or drag-drop the folder). Netlify
auto-detects the function. Test it in a browser:

```
https://loonahub.netlify.app/.netlify/functions/petpooja-attendance?start_date=2026-07-01&end_date=2026-07-02
```

You should get `{"success":true,"records":[…]}`.

## Step 3 — Discover your real employee IDs

Run the tester on your machine (Node 18+). It prints every `emp_id` + name:

```bash
PETPOOJA_CLIENT_ID=48271593 \
PETPOOJA_CLIENT_SECRET='your-secret' \
PETPOOJA_BASE_URL=https://payrolltp.petpooja.com \
node test-petpooja.js 2026-07-01 2026-07-02
```

## Step 4 — Map employee IDs to hub names

In `index.html`, find the **LIVE** config block near the top of the attendance
module and fill it in:

```js
var LIVE = {
  url: "/.netlify/functions/petpooja-attendance",   // turn ON by setting this
  empMap: {
    // "petpooja_emp_id": "Hub Name",
    "LSPL004": "Chinmay",
    "LSPL005": "Nishant",
    "LSPL006": "Muskan",
    "LSPL008": "Anurag",
    "LSPL010": "Majid",
    "LSPL001": "Gokul",
    // …fill the rest from Step 3
  }
};
```

- While `url` is empty, the hub shows placeholder data (safe default).
- Once `url` + `empMap` are set, cards, calendar counts, late/absent and the
  founder board update from live punches. Any employee not in `empMap` is skipped.

---

## How the rules are applied to live data

From each employee's In/Out punches per day the function computes **worked
minutes**, **break minutes** and **first punch-in**. The hub then applies:

- **Late** — first punch-in after **10:30 am** (10:00–10:30 grace).
- **Absent** — worked under the day's minimum: **7 h** weekdays, **5 h**
  Saturdays (10:00–3:30). Excludes breaks.
- **Late fee** — ₹200 for every 3 late days in the month.
- **Holidays** (Gokul-managed) and **Sundays** are excluded from absent logic.

## Notes / gotchas

- The doc shows `GET /attendance/punches` with a JSON body. Browsers can't send a
  GET body, so the function passes the range as query params. If Petpooja rejects
  that, switch the function's `getPunches` to `POST` (comment in the code shows how);
  the test script already auto-retries as POST.
- Access token = 15 min, refresh token = 30 days; the function handles renewal.
- For history/persistence across users, the next step is a scheduled daily pull
  into your Firebase (`loona-hub-c85d7`). Ask and I'll add that function.
