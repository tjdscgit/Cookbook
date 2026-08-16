# Cookbook

A recipe app for phone and desktop. Recipes scale to any serving size, and the method shows each
ingredient *and its amount* beside the step that uses it — so you're not scrolling back to the
ingredient list with wet hands.

Vanilla HTML/CSS/JS. No build step, no `npm install`, no framework. Data lives in Firestore.

## Setup

**1. Create a Firebase project** at [console.firebase.google.com](https://console.firebase.google.com).
Stay on the free Spark plan — nothing here needs billing.

**2. Add Firestore and an account.** In the console: **Firestore Database → Create database**
(production mode, any region), then **Authentication → Sign-in method → Email/Password → Enable**,
then **Authentication → Users → Add user** with the email and password you'll sign in with. There
are no collections or fields to create — Firestore makes them on first write.

**3. Publish the security rules.** Copy [firestore.rules](firestore.rules) into **Firestore Database
→ Rules**, replacing `OWNER_UID` with the uid shown against your user under Authentication → Users.
Without this step the database is either closed to the app or open to the world.

**4. Open the app** and paste the project id and web API key (Project settings → General) into
Settings ⚙, then sign in. "Test connection" tells you immediately if something's wrong.

**5. Optional — an Anthropic API key.** Only needed to clip recipes from **photos** and **social
posts**. Website clipping and manual entry work without it. Roughly 5–6¢ per photo.

The project id and API key are not secrets — they identify the project and grant nothing. Access
comes from being signed in, and the rules restrict every document to your account.

## Running it

```bash
npx -y serve -l 8935 .
```

Then open <http://localhost:8935>. For the real thing, push to a GitHub repo and enable Pages — it
installs to a phone or desktop home screen from there and works offline for reading.

## Tests

```bash
node cookbook-units.test.js
```

Covers the scaling engine: fraction parsing and formatting, ingredient parsing, serving scaling,
non-scaling amounts, and shopping-list aggregation. No test framework — deliberately, so it stays
runnable with nothing installed.

## Regenerating the icons

```bash
node scripts/make-icons.mjs
```

Writes real PNGs with no dependencies. Edit the two hex constants at the top to re-tint them.

## Files

| File | What it does |
|---|---|
| `index.html` | App shell and all markup |
| `cookbook.css` | Theming (light + dark) and layout |
| `cookbook-units.js` | Ingredient parsing, serving scaling, shopping-list aggregation |
| `cookbook-data.js` | The only file that knows Firestore exists |
| `firestore.rules` | Security rules — paste into the Firebase console |
| `cookbook-clip.js` | Clipping from websites, photos and pasted text |
| `cookbook-plan.js` | Weekly planner and shopping-list rendering |
| `cookbook-ui.js` | State, navigation and every view |
| `sw.js` | Service worker — network-first, `no-store` |

## Notes on measurements

Defaults to **Australian** measures: 1 tbsp = 20 ml, 1 cup = 250 ml. The US tablespoon is 15 ml, so
a recipe using 4 tbsp of raising agent is a third out if the wrong system is assumed. There's a US
toggle in Settings.

Recipes always **display** the units they were written in — conversion happens only when combining
amounts onto a shopping list.
