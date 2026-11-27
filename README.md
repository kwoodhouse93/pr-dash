# pr-dash

A local dashboard for pull requests you authored and pull requests you review. Stacks collapse to one row. CI, review, and review threads are on the row. Each list is one outline: Linear projects, then initiatives, then issues with no project, then pull requests with no issue.

My PRs is changes you opened. Review is open pull requests that request your review, including teams you belong to, plus open pull requests you have already reviewed. Review rows show the author and leave out merge actions. A refresh loads the tab you are looking at first.

What each part of the dashboard shows and does is in [docs/behaviour.md](docs/behaviour.md).

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:4317.

Settings chooses which repositories a refresh includes. None are included until you select them.

Keys are read from the environment, or from a `.env` file in the folder the server starts in.

| Key | What it is for |
| --- | --- |
| `GITHUB_TOKEN` or `GH_TOKEN` | Reads pull requests, reruns workflows and merges. Without either, the server uses `gh auth token`. |
| `LINEAR_API_KEY` | Optional. Project names, status, assignee, and linking a pull request to an issue. |
| `CURSOR_API_KEY` | Optional. Starts agents in Cursor. |
| `T3_BIN` | Optional. The path to the `t3` command when it is not on your `PATH`, for agents in T3 Code. |
| `HOST`, `PORT`, `DATABASE_PATH` | Where the server listens and keeps its data. See Deploy. |

## Desktop app (Mac)

`desktop/` is an Electron shell around the same server. The dashboard is the first tab. A link it opens, such as a pull request, a Linear issue or a Graphite stack, becomes another tab in the same window, and sign-ins are kept between launches. The button at the right of the tab strip, or ⇧⌘O, opens the current tab in your default browser. Right-click a link to open it there instead. Linear pages stay in the tab even when Linear is set to open links in its desktop app. ⌘T opens the link on the clipboard.

```bash
cd desktop
npm install
npm run install-app   # builds PR Dash.app and copies it to /Applications
```

`npm run dev` runs it without packaging. The app is built for Apple silicon and signed for this machine only.

The app keeps its own data in `~/Library/Application Support/PR Dash`: the database under `data/`, an optional `.env` with the same keys as above, and `server.log`. It listens on `127.0.0.1:4318`, so `npm run dev` can run beside it. Only the dashboard tab can reach that API; pages in other tabs cannot.

**Updates.** Every push to `main` builds the server and web assets and replaces the asset on the `payload` release. The app checks that release when it starts and every five minutes, using `GITHUB_TOKEN` or `gh auth token`. A newer build is downloaded, the server is restarted on it, and the dashboard tab reloads. Other tabs are left alone. While you are looking at the dashboard the app waits and shows an Update button, so a reply you are typing is not lost; it applies the update when you switch tab or window. A build that fails to start is dropped and the previous one keeps running. The shell itself changes only when you run `npm run install-app` again.

The sidebar and its list of agents are described in [docs/behaviour.md](docs/behaviour.md#desktop-app).

## Deploy

The process is one Node server. Bind address defaults to `127.0.0.1`. To run it somewhere else:

```bash
npm run build
HOST=0.0.0.0 PORT=4317 DATABASE_PATH=/data/pr-dash.sqlite GITHUB_TOKEN=... npm start
```

Or build the Docker image. Mount a volume at `/data` so initiatives and the snapshot survive restarts.

The server holds a token that can read your pull requests, rerun workflows, and squash-merge into the default branch. Keep it on a private network.

The API refuses requests from pages on another site. On the default local address it also refuses any request whose `Host` is not this machine. With `HOST` set to anything else it accepts whatever name it is reached by, so that check is off.

## Working on it

```bash
npm test            # every test, once
npm run typecheck   # the dashboard; run it in desktop/ for the app
npm run lint        # formatting and lint rules, for the dashboard and the app
npm run format      # rewrites what lint would complain about, where it can
```

Formatting and linting are Biome's, set up in `biome.json`. A push to `main` runs all three, and publishes the build the desktop app downloads only when they pass.

- `src/shared` is what the server, the page and the desktop app all use: the types, and the rules for stacks, checks, reviews and the merge queue. Nothing in it touches the network, the database or the page.
- `src/server` is the API. `app.ts` builds it from the route files in `routes/`, which throw what went wrong for one handler to answer. `github.ts` reads the lists, `github-pull.ts` reads and changes one pull request, and `github-feedback.ts` is review threads. `schema.ts` holds the database's tables as numbered steps; a change to a table is a new step at the end.
- `src/web` is the page. `App.tsx` is the layout, `use-snapshot.ts` reads the lists and asks for refreshes, and `table.tsx` with the files in `table/` is the list itself.
- `desktop` is the Electron app. It takes what it shares with the page from `src/shared`.
