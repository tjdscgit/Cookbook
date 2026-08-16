# Cookbook — handover

Written 2026-08-06, picking the project back up on a new machine after the original laptop died.

## Verdict: fully revivable

Nothing was lost. The project lives on Google Drive (`G:\My Drive\Roseberry\Documents\Claude Code\CookbookApp`), which synced to this machine intact, and the same commits are on GitHub. One repo corruption caused by Drive was found and fixed (see *Repo damage*, below).

| Thing | State | Checked how |
|---|---|---|
| Source files | All 33 tracked files present | `git status` clean |
| Git history | 3 commits, healthy | `git fsck` clean after repair |
| GitHub remote | `github.com/tjdscgit/Cookbook`, in sync (0 ahead / 0 behind) | `git fetch` + `rev-list` |
| Live app | https://tjdscgit.github.io/Cookbook/ serving | fetched, renders |
| Local server | starts on :8935, no console errors | `npx serve` |
| Tests | 58 passed, 0 failed | `node cookbook-units.test.js` |
| Airtable base | `app6LxARn89Lgqrf2` "Cookbook", all 4 tables + fields intact | Airtable API |
| Node | v24.19.0 installed | `node --version` |

## Repo damage that was found and fixed

Google Drive writes hidden `desktop.ini` folder-metadata files into every directory it syncs — **including inside `.git/`**. Sixty of them had landed in `.git/refs/`, `.git/objects/` and `.git/logs/`, and git read them as refs and objects. The result:

```
fatal: bad object refs/desktop.ini
error: https://github.com/tjdscgit/Cookbook.git did not send all necessary objects
```

`git fetch` and `git push` were both broken. They have been deleted and `git fsck` is now clean.

**This will come back.** Any time Drive re-indexes the folder it can re-create them. If fetch or push starts failing with `bad object` or `badRefContent`, run:

```bash
find .git -name "desktop.ini" -delete
```

`.gitignore` already ignores `desktop.ini` in the working tree, but `.gitignore` cannot protect the inside of `.git/` — that's why this bit. If it becomes a nuisance, the durable fix is moving the repo off Drive to a local path and using GitHub as the sync mechanism instead.

## Getting running on this machine

Nothing to install — no build step, no `npm install`, no framework.

Serve it:

```bash
npx -y serve -l 8935 .
```

Then open <http://localhost:8935>. (Claude Code can also start it via `.claude/launch.json` — the config is named `static`.)

Run the tests:

```bash
node cookbook-units.test.js
```

## Credentials you need to re-enter

Credentials were never in the repo — they live in browser storage, which died with the laptop. **You have to set them again on this machine**, in three separate places (each is isolated storage):

1. **The web app** — open it, hit Settings ⚙
2. **The GitHub Pages copy** — same, separately, if you use it from this desktop
3. **The Chrome extension** — its own Options page (see below)

What to enter:

- **Airtable personal access token** — create at <https://airtable.com/create/tokens> with scopes `data.records:read`, `data.records:write`, `schema.bases:read`, granted access to the Cookbook base. If your old token was stored only in the dead laptop's browser, make a new one and revoke the old.
- **Base id**: `app6LxARn89Lgqrf2`
- **Anthropic API key** — *optional*. Only needed for clipping recipes from photos and social posts. Website clipping and manual entry work without it. ~5–6¢ per photo.

"Test connection" in Settings verifies the token and every table name immediately.

## Installing the Chrome extension on this computer

The extension is not on the Chrome Web Store — it installs unpacked from the repo folder.

1. Open `chrome://extensions`
2. Turn on **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select this folder:
   `G:\My Drive\Roseberry\Documents\Claude Code\CookbookApp\extension`
5. Click the puzzle-piece icon in the toolbar and **pin** "Cookbook Clipper"
6. Right-click the pinned icon → **Options**, and enter the Airtable token + base id (and optionally the Anthropic key). The extension's storage is separate from the web app's, so you must enter them here even if the app already has them.

Two caveats specific to loading it from Google Drive:

- Chrome loads unpacked extensions **from the path**, and re-reads it at every browser start. If Drive ever makes the folder unavailable offline, the extension silently disables. If that annoys you, copy `extension/` to a local path (e.g. `C:\Users\tjami\Extensions\cookbook-clipper`) and load it from there instead — just remember to re-copy after changing extension code.
- Developer-mode extensions make Chrome show a "Disable developer mode extensions" nag on each launch. Dismissing it is fine; it doesn't affect the extension.

**Using it:** open a recipe page → click the toolbar icon → **Clip this page**. Most recipe sites publish `schema.org/Recipe` JSON-LD, so it's instant and free. Pages without it fall back to Claude on the page text (needs the Anthropic key). You get a preview before anything is written; nothing saves until you click **Save to Cookbook**.

## Where the work was left off

Last three commits, newest first:

- `01e88e6` Remember last-viewed section (Cookbook/To Try) across reloads
- `dcf3b23` Harden credential fields against password-manager autofill misfire
- `1e46b56` Initial commit: Cookbook recipe app

The working tree is clean — there was no uncommitted work in flight when the laptop went. The most recent feature line was the **Tried / To Try split**: recipes have a `Tried` checkbox, and the app shows unticked ones under "To Try" and ticked ones under "Cookbook", with the last-viewed section remembered across reloads.

### One known loose end

`extension/lib/cookbook-data.js` is meant to be a byte-identical copy of the app's `cookbook-data.js` (Chrome can't load files from outside the extension folder, and the project deliberately has no build step). It has **drifted**: the extension's copy predates the `Tried` field, so it lacks `F.tried`, `setTried()`, and the parse/write of that field.

In practice this is harmless right now — recipes clipped by the extension simply arrive with `Tried` unset, which lands them in "To Try", which is where a freshly clipped recipe belongs anyway. But the two files are supposed to stay identical, so re-sync it when you next touch either:

```bash
cp cookbook-data.js extension/lib/cookbook-data.js
```

Note that doing so drops the "SYNCED COPY" header comment at the top of the extension copy — re-add it, or accept the loss. `extension/lib/cookbook-units.js` differs *only* by that header comment and is otherwise in sync.

## Orientation for future-you

Read [README.md](README.md) for the file-by-file map and [cookbook-schema.md](cookbook-schema.md) for the Airtable layout. The two things worth knowing up front:

- **Measurements default to Australian** — 1 tbsp = 20 ml, 1 cup = 250 ml (the US tbsp is 15 ml, so a recipe with 4 tbsp of raising agent is a third out if you assume wrong). There's a US toggle in Settings. Recipes always *display* the units they were written in; conversion happens only when combining amounts onto a shopping list.
- **Ingredients and steps are stored as JSON in single fields**, not as separate records — one recipe costs one Airtable record instead of ~20, which keeps the free tier's 1,000-record limit out of reach. Same reason meal plans are one record per *week*, not per meal. Don't hand-edit those JSON fields in Airtable; the step↔ingredient links break.

## Housekeeping worth doing

- **Revoke the old Airtable token** if it was only ever stored on the dead laptop — you can't get it back, and a live token you no longer hold is worth killing.
- Consider moving the repo off Google Drive to a local path to end the `desktop.ini` problem permanently, with GitHub as the sync between machines.
- `gh` (GitHub CLI) is not installed on this machine. Not required — plain `git` push/pull over HTTPS works — but install it if you want PR commands.

---

# Addendum, 2026-08-16: Airtable is gone, the backend is Firestore

Everything above about Airtable is now **historical**. Read this section over the top of it.

## What happened

The app stopped working. The cause was Airtable's free-plan cap of **1,000 API calls per month**,
confirmed directly:

```
Public API request returned 429: API billing plan limit exceeded.
You've reached the maximum number of requests allowed for this month.
```

Not a rate limit and not the 1,000-*record* ceiling the schema was designed around — the library was
only 51 recipes, about 5% of that. A cookbook that reloads whenever you open it exhausts a
thousand monthly calls on its own, so this was a wall rather than something to engineer around.

Firebase/Firestore replaced it. The free Spark tier allows 50,000 reads and 20,000 writes **per
day**; a full load of the cookbook costs about 51 reads. Firebase also isn't capped at two projects
the way Supabase's free plan is, which is what ruled Supabase out.

## What this changes for you

- **Setup is different.** See [README.md](README.md) — Firebase project, Firestore database, an
  email/password account, and [firestore.rules](firestore.rules) published to the console.
- **Credentials are different.** No more token and base id. You now enter a **project id** and a
  **web API key**, then **sign in** with email and password. The first two aren't secrets — they
  name the project and grant nothing. The password is never stored; sign-in swaps it once for a
  refresh token. This is a genuinely better arrangement than the Airtable PAT it replaces, which
  *was* a secret sitting in `localStorage`.
- **The extension needs re-entering too**, on its own Options page, same as before.
- **The service worker cache is bumped to v2.** Any device still holding the v1 shell would run the
  old Airtable code against a backend that no longer answers; the bump forces it to update.

## The one real caveat: the Airtable data could not be exported

The API cap blocked reading the base as well as writing to it, so there is no API-made export. The
migration source is [flavorish-import.json](flavorish-import.json) — 51 recipes, already in the
app's exact internal shape, with original source photo URLs on 50 of them — re-imported through the
app's existing Import button in Settings ⚙.

**What that misses:** anything changed *inside the app* after 10 Aug 2026 — favourite and tried
flags, edited notes, meal plans, shopping lists. If that matters, export the four tables as CSV from
the Airtable web UI (grid view → **Download CSV**), which does **not** consume API quota, and
reconcile by hand. Do it before the base is deleted.

Also note that photos now stay **hotlinked** from the source site rather than being copied the way
Airtable copied attachments. Cheaper and free, but a photo can disappear if the site takes it down.

## Loose ends from above, resolved

- The `extension/lib/cookbook-data.js` drift described under *One known loose end* is **fixed** —
  the two files are byte-identical again apart from the four-line SYNCED COPY header.
- *Ingredients and steps are stored as JSON in single fields* is **no longer true**. That existed
  only to dodge Airtable's 1,000-record ceiling. They are now real nested arrays of objects.
  `parseRecipe` still reads the old JSON-string shape, so nothing breaks on a carried-over document.
- Meal plans are still one document per week, but the week's Monday is now the **document id**, so
  loading a week is a single get with no query or index.
