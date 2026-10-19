# Instructions for AI coding agents

You are likely an AI coding agent building an app on
`@brass-build/client`. The [README](./README.md) teaches the API. This
page covers how to verify your work and the UX baseline a generated app
should meet. Apply both.

## Find out where the app's data comes from

**The request names a format, a corpus, or an export.** Our IFC models,
the GPX tracks off my watch, the change orders our subs email us. Ask
for one real example as your first action, before you design anything.
You take your record shape from that file, and an app built ahead of it
guesses at a shape the real files contradict.

**The work has a customary shape in the user's trade.** A punch list, a
timesheet, an RFI, a site diary: people in that line of work pass these
around as documents whose fields they all expect, so a shape for it
exists and the user probably has a copy. Ask for theirs before you
design a schema. Inventing a schema for a shape that already exists
forks that shape: the picker routes documents to apps by their declared
schema, so each app's documents stop opening in the other, and the split
stands. Ask the user rather than searching for the shape yourself: it
reaches you as a document they already have.

Ask as well whenever the user brings up another application. What that
product can hand over decides whether you adopt a shape or integrate,
and only the user knows.

A product you assumed, rather than one the user named, works the other
way round. Data a product stores reaches you through its API rather than
as a document, so a sprint board, a sales pipeline, or a ticket queue
you guess lives in some tool leaves you no shape to adopt. Build it as
below until the user names the tool.

**The data starts in your app.** A canvas, a poll, a garden planner, a
personal collection of notes or recipes: the document means something
only inside your app, and whatever you design becomes its shape.
Design the records from the request, declare their schema in
`brass-app.json`, and build. Asking for a file here stalls a task that
has none behind it, and it reads to the user as though their request
was incomplete.

Ask either question and keep working on what does not depend on the
answer: drive the sign-in, fetch the organization's instructions (next
section), and scaffold the app shell while the user answers.

With an example in hand: the user adds it at their Brass dashboard
(`https://app.brass.build`) and sends you back the document's link,
and you read what that document contains. A resolved schema is your
record contract: pull it and adopt it verbatim
(`npx @brass-build/cli schema pull --doc <docId>`). Read the records too,
before you write code against them
(`npx @brass-build/cli contents --doc <docId>` writes the document's
`default` stream as JSON, and `--stream <name>` writes another stream): the
schema names the fields and the data tells you what is in them.
When your app reads that document through `Brass.chooseInputs` rather than
opening it, pull with `--out input-schema.json` instead and copy that
file's `schema` into an `inputs` entry. A plain pull writes over your
manifest's `schema`, and Brass would then offer your app to open that
document's family.
Read all of it rather than the first few records, since a file's records are
grouped by type and its opening records carry a couple of its types
and none of the rest.
When your app reads many documents through `Brass.chooseInputs`, ask the
user for the project or folder it will read rather than one file, and
sample that set with `npx @brass-build/cli contents --from project:<projectId>`.
Run it first with `--max-documents 0`, which lists the set without reading
it, to see the families the set's files belong to (the `family` on each
document it lists), then pass `--family` the families your `chooseInputs`
call names. The command lists the
documents that call returns, reads several of them whole, and counts every
record type their streams contain, with a few records of each type drawn from
different documents. Sample the set because one file shows only the types
it carries, and other files in the set can carry more. Reading a file
starts its import, as opening it does, so keep some files of the set out
of the sample for the first-run check below.
If a stored file has no schema, your app is its first importer. Register a
function with `Brass.registerImporter` that takes the file and returns its
records as JSON, and declare the schema of those records in
`brass-app.json` so the next app can adopt it. Call `registerImporter` at
startup, unconditionally, not after sign-in or after a document opens:
Brass may load your app only to run its importer.
In your app, the file opens the way every document opens: through the
session and the hosted picker (the picker also brings a file into
Brass).

Adopt a pulled schema verbatim, keywords included. A schema describes
the data, so an `x-brass-` keyword in it belongs to the file you pulled
it from, and dropping the keyword declares a different contract.

`brass publish` prints warnings on stderr and repeats them in
`warnings` in its `--json` result. Read them and act on what they name,
then publish again and expect a clean result. Tell the user what you
changed and why.

## Fetch the organization's coding instructions

Before you write any code (and while the user finds their
example file), run this and follow what it prints:

```sh
npx @brass-build/cli agents pull --stdout
```

It prints the organization's own conventions for apps built on Brass
(its `AGENTS.md` / `CLAUDE.md`) to stdout. Read them inline and treat
them as an instruction file for this task. They take precedence over
the generic defaults here. Run the command rather than deciding up
front whether the org has any: an org that set none prints nothing, and
you proceed with the defaults below.

The pull needs a signed-in session, so when `brass agents pull` reports
no credential, run the sign-in yourself first: run `brass login --start`
and copy the URL and code it prints into the visible text of your reply.
Most interfaces collapse command output, so the human never sees a code
that stays there. Then keep running `brass login --check --wait` in the
same turn until it reports approved: only a check stores the session,
and if the human approves while no check is running, the approval waits
for your next check. If the human sees your reply only when your turn
ends (you run as a subagent, or in a harness that shows only the final
message), end the turn with the URL and code instead, and run the check
as soon as you resume. That is the same credential you will use to
publish (see "Ship the app").

When the pull lists several organizations instead of pulling, ask the
human which one the app is for, and pass that id as `--org` to the pull
and to your first `brass publish`. `brass agents pull` is detailed in
the `@brass-build/cli` package's `AGENTS.md`.

## Have a second agent review your work

Brass documents are persistent and shared: a write that compiles and
looks right on screen can still be subtly wrong in the stored
document, and once saved it syncs to every collaborator and reopens
later. You share the blind spot that produced any such bug, so
reviewing your own work reconfirms it. Build with a review loop.

Once the integration builds, have a **separate** agent (not you)
adversarially review it and drive it in a real browser against the
live backend. Give that reviewer implementation-independent checks:

- It should read the document's records itself (walk
  `doc.map(...).entries()` / `doc.list(...).values()`, or subscribe to
  follow edits) and validate them against the data spec, rather than
  trusting the app's own helpers.
- It should push the negative, zero, and boundary inputs of every
  operation.
- It should confirm each edit round-trips and leaves the document
  consistent.
- If the app reads across many documents, it should run the app over a
  set that includes files nobody has opened yet (the ones you kept out of
  your `contents --from` sample, or files added just before the run),
  because a file's import can still be running when the app opens it. It should confirm the app shows
  a loading state while such an open waits, and renders the records once
  it resolves. It should include a file only another app imports, and
  confirm the app shows that file as not imported yet when its open
  rejects with `not_imported`. Once the other app has imported the file,
  Brass calls the key's handler for it again, and the app should then
  read it.
- If the app offers use without an account, it should make a document
  signed out, then sign in through the app's own sign-in on that page and
  confirm the document is still there. Signing in any other way, such as
  through `brass browser-session`, leaves the document behind.
- It should open the same document as **two** signed-in users and put
  them in the same field at once: with one user's caret sitting in a
  field, the other edits it. The first user's screen has to show that
  value once their caret leaves, and a user whose own edit goes over a
  peer's has to be told so. Both halves fail silently, and a single
  session never reaches either.

Both you and the reviewer need a signed-in browser.
`brass browser-session` prints a URL that opens your app already signed
in as you:

```sh
npx @brass-build/cli browser-session --return-to http://localhost:5173/
```

Point `--return-to` at your dev server while you build, and at the
published URL once you have one. Run the command once per browser
context, at the moment that context is ready to navigate. Each URL signs
in one browser once and expires two minutes after it is printed. Give
each of the two users a URL. Both sign in to the human's account, so ask
the human for a second account when a check needs two different people.

Open the document by its id, through `Brass.openDocumentById` or the
`?doc=` parameter the session restores on boot. Use a document your app
created, or one a user previously opened in your app from Brass. Brass refuses
access to documents the user has not granted to your app, returning a 403 status.
Brass's own dialogs, such as the picker, open in that browser too once the human
has signed in to the Brass dashboard before. Otherwise a dialog asks for a
sign-in that the human has to complete. The `@brass-build/cli` package's
`AGENTS.md` covers the rest, including how to install and drive a headless
browser.

Have the reviewer drive any gesture on a touch device as well as a
desktop mouse. Drags, multi-point taps, and anything else
pointer-driven commonly work under a mouse and break under touch, and a
layout that looks right at a narrow width says nothing about whether
the gesture still works there.

Fix what the reviewer finds and iterate until the reviewer's own checks
pass, before you call the integration done.

## Apply these UX defaults

When the prompt you were given is silent on UX, default to the
following. A real design in the prompt overrides any of them; this is
the baseline for when there is no design.

- **Build an app, not a website.** The working surface fills the
  viewport; do not center the app in a `max-width: 720px` column.
- **Render two distinct shells, signed-out and signed-in.** A
  signed-in shell with disabled buttons next to a sign-in CTA reads as
  broken. Mount the working shell when `Brass.authStatus` is
  `'signed-in'` or `'guest'` (a visitor working without an account has no
  user), the signed-out shell only on `'signed-out'`, and **neither**
  during the `'unknown'` window before `init` settles (see "Rendering auth
  state" in the README).
- **Let a visitor try the app without an account.** Give the signed-out
  shell New and Upload buttons beside Sign in, declare
  `"access": { "create": "anyone" }`, and publish with
  `--gate off --visibility public` (see "Try before signing in" in the
  README). Declare `"create": "signed-in"` instead only when the app's
  content comes from files people pick with `Brass.chooseInputs`, or
  when every action calls a service. When one feature calls a service,
  disable that feature for a visitor and offer the rest.
- **Put auth chrome in the header of the signed-in shell only**: the
  user's email or sub, plus sign out. The sign-in CTA, and any way in
  without an account (see "Try before signing in" in the README), belong
  in the body of the signed-out shell, not in a pre-rendered header.
- **Include the viewport meta tag**:
  `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- **If you toggle shells with `el.hidden`, add
  `[hidden] { display: none !important }` to your CSS.** The built-in
  `[hidden]` rule has the lowest possible specificity, so a `display:`
  rule you set on the same element (`display: flex` on a signed-in
  shell) outranks it and `el.hidden = true` silently stops hiding
  anything. A class toggle sidesteps it; the plain-DOM shell pattern is
  where it bites.
- **Make touch targets at least 40px**: `padding: 12px 16px` on
  tappable controls.
- **Draw the `<select>` arrow yourself.** A native `<select>` puts the
  browser's own arrow tight against the control's right edge, at a gap
  that differs per browser, so a select carrying your border and radius
  still reads as a stock control beside your other inputs. Set
  `appearance: none`, draw the chevron as a `background-image` at
  `background-position: right 0.75rem center`, and reserve
  `padding-right: 2.25rem` so a long option cannot run under it.
- **Disable, don't hide, on read-only documents.** When
  `doc.readOnly` is true, render the editor and share controls disabled
  with a `title` explaining why, rather than removing them. It covers
  every reason this user cannot write: a view-only grant, a view-only
  share link, a historical-version preview, a document still loading
  or being prepared for editing, a file too large to edit
  (`doc.atCapacity`), and a copy your app opened with `readOnly` or
  `frozen`. Re-read it in your `doc.subscribe` handler rather than
  reading it once at bind: it also flips when someone withdraws the
  user's access while the document is open, which is what closes the
  editor at the moment writing stops working. Pair it with
  `Brass.onError`, where the sentence explaining a refused write
  arrives.
- **Make each user action one Undo step.** Call
  `void doc.createCheckpoint()` at the end of every action that edits
  the document: on `pointerup` after a drag, after a command runs, after
  a field commits. In a text editor, call it in `beforeinput`
  whenever the coming edit starts a new step (see "Undo, checkpoints,
  and version history" in the README), and leave the automatic interval
  as it is.
- **Name the next action in empty states.** "No document open. Use
  Open to pick or create one."
- **Gate edit affordances on an open document.** When
  `session.status` is `empty` or `signed-out`, render the empty or
  sign-in state in place of the editor, not over it. A canvas or tool
  palette that responds to input before a document is open lets the
  user produce work that silently cannot be persisted and is discarded
  when the first document opens.
- **Render the `error` status.** When `session.status` is `error` (a
  document the user opened could not be opened: deleted, an access the
  platform collapses to a non-disclosing 404, or a file the platform
  could not prepare; or a document that was open being deleted out from
  under the user), render
  `session.error.message` verbatim, surrounded by your own New / Open
  actions, not the plain empty state. Falling through to "No document
  open" reads as if the user asked for nothing and hides the failure.
  Render the platform's message rather than writing your own (same as
  `session.loadingMessage`): it stays one deliberately non-disclosing
  string for both "deleted" and "no access", so never word them
  differently and never let the wording hint which occurred.
- **Prefer `Brass.mountToolbar` for the document menu.** If the shell
  is fully custom, render `session.commands` in one `<menu>` anchored
  to a `<details>`/`<summary>` disclosure widget with the active doc's
  name and a caret as the trigger, and style the `<summary>` with a
  resting button-like affordance so it reads as clickable rather than
  as a heading.
- **Wire presence by default, and wire both halves.** When
  `doc.presence` is non-null (any live open), publish your own
  pointer / camera / selection state on every move AND render other
  participants' state in the working surface, not just an initials
  list in the header (the README's "Presence" section explains why
  wiring only one half is the common mistake). Skip presence entirely
  only if the prompt explicitly says single-user.
- **Follow the copy style.** Sentence case for headings. No em
  dashes, no exclamation marks, and no "please" or "sorry" in errors:
  "Document not found." not "Sorry, we couldn't find that document!"
  Use "sign in" / "sign out", not "log in" / "log out".

## Ship the app

A build that compiles is not a finished integration. It is finished
when a user can sign in and, if the task calls for a deployed app, open
it at a real URL. Drive it there rather than stopping at "it builds".

Run `brass status` first, and act on what it prints:

```sh
npx @brass-build/cli status
```

It inspects the credential and app state for this environment and ends
in a `Next:` line naming the one command to run. Follow that line, then
run `brass status` again, for the rest of this section.

These steps need the human's Brass account, and you cannot stand in for
them. Drive each to completion rather than noting it and stopping:

- **Getting an app id.** `Brass.init` needs the `app_id` of a
  registered app. Run the first `brass publish` (below): it creates the
  app and reports the id, which `--json` gives you as `app_id` for your
  own parsing, and you pass that to `Brass.init('brass_app_...')`. The
  publish also writes `.brass/project.json`, which is the CLI's own
  state: commit it so re-runs target the same app, and read the id from
  the publish result rather than out of that file. A new app already allows sign-in
  from `localhost`, so once you have the id, `Brass.signIn()` works in
  local development with no further setup. (Or the human creates the app
  on the dashboard and gives you the id.)
- **A publish credential.** When `brass status` reports no credential,
  drive the sign-in: run `brass login`. In a local session it opens the
  human's browser to approve and completes on approval. On a headless
  box it prints a URL and short code the human approves from any device.
  Copy both into the visible text of your reply, since most interfaces
  collapse command output.
  Running it and getting the human through approval is your step. For CI
  the human supplies `BRASS_SERVICE_TOKEN` instead.
- **A key for every service you declared.** An app that declares
  `services` in `brass-app.json` calls those hosts through Brass, which
  stores the credential, and the credential comes from the provider's own
  console. `brass publish` names each host still waiting and the page
  that takes its key, in the log and in `warnings` under `--json`. Give
  the human that line as it stands: it carries the host and a link
  straight to the page. Until they paste it, `Brass.callService` answers
  `409` with `code: 'app_credential_not_set'` for that host and the app
  cannot reach it.

Once `brass status` reports a credential, publish:

```sh
npm run build
npx @brass-build/cli publish ./dist --name "My app"
```

This deploys to `https://<slug>.onbrass.app`. If the app lets a visitor
work without an account, declare `"access": { "create": "anyone" }` in
`brass-app.json` and add `--gate off --visibility public`. Without
`--gate off`, Brass asks every visitor to sign in before the app loads.
Without `--visibility public`, a visitor with no account cannot create a
document, and `Brass.session.error` carries the
reason.
Report the integration
against this end state, and close out every item before you call it
done:

- **built**: `npm run build` is clean.
- **signed in**: `brass status` confirms a publish credential.
- **published**: `brass publish` reported a URL.
- **opened**: you loaded that URL in a browser you drive, signed in
  through `brass browser-session`, and used the app there.
- **keyed**: `brass publish` named no host as still waiting for a key. A
  host it named is an open item like any other, so offer the link and
  wait rather than reporting the integration done around it.

An open item is the next thing to offer. When publishing is waiting only
on the human's sign-in, say so and offer to walk them through
`brass login` now, rather than leaving it as a note and stopping. The
short path for you is `AGENTS.md` in the `@brass-build/cli` package.
