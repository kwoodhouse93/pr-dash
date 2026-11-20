# pr-dash

A local dashboard for pull requests you authored and pull requests you review. Stacks collapse to one row. CI, review, and review threads are on the row. Each list is one outline: Linear projects, then initiatives, then issues with no project, then pull requests with no issue.

My PRs is changes you opened. Review is open pull requests that request your review, including teams you belong to, plus open pull requests you have already reviewed. Review rows show the author and leave out merge actions. A refresh loads the tab you are looking at first.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:4317.

The server uses `GITHUB_TOKEN` or `GH_TOKEN` when set, and otherwise `gh auth token`. A refresh pulls the open list you are looking at, then keeps that snapshot in `data/pr-dash.sqlite`. The server keeps that list moving about every minute, including while the tab is in the background, and pauses when few GraphQL points remain. Finished checks are kept when the pull request and its check rollup have not changed. Running checks are read again, and each refresh also rereads the checks that were fetched least recently so a quiet rerun still shows up. Thread replies load after the list, and again when a pull request changes. The row menu can refresh one pull request. Required checks are cached for a day. Settings has a full sync that reloads both lists and reads rulesets again. Sort, filters, and which stacks are expanded are remembered in this browser. The address also carries the open page and its filters, so a filtered list can be bookmarked; a link that names a filter replaces the saved filters for that page. Press `/` to search, `j` and `k` to move through the rows, and `?` for the full list of keys. The keyboard button in the header shows the same list.

Settings chooses which repositories a refresh includes. Pick an owner, then the repositories under that owner. None are included until you select them, so a refresh does not ask GitHub about every repository you can access. Removing a repository deletes the pull requests, cached rules, agent sessions, and merge queue entries stored for it. That does not change the repository on GitHub.

`LINEAR_API_KEY` is optional. Without it, issue titles still come from the Linear link on the pull request. Project names, status, assignee, and linking a pull request to an issue need the key. Linking uses Linear’s GitHub attachment, so the workspace GitHub integration has to be connected. The link stays on the pull request after a refresh.

Agents start from a row: resolve a merge conflict, investigate failing CI, fix a review thread, or run your own prompt. Each agent pushes to the pull request’s existing head branch. The dashboard remembers every session and refreshes active ones with the pull requests. Two providers can run them, and **Agents** in Settings picks which: one default, and any repository can use the other.

- **Cursor.** Cursor Cloud Agents, billed by Cursor. Set `CURSOR_API_KEY`. Create a user or service-account key in the Cursor dashboard. The key remains on this server.
- **T3 Code.** A thread in T3 Code on this machine, under the coding agent you are signed in to there. It needs the `t3` command (or `T3_BIN` set to its path), T3 Code running, and a T3 Code project for the repository. The dashboard finds that project by itself, from the GitHub repository its folder is a checkout of, and Settings shows which one it found. To work in another folder, or when it finds none, set a folder beside the repository in Settings. Each agent gets a new worktree made from the pull request’s branch on `origin`, so a pull request from a fork cannot be started this way. T3 Code works on this machine only, so a server deployed elsewhere should keep Cursor.

Settings shows whether each provider is ready, and why not when it is not. If the provider for a repository cannot be used when you start an agent, the error says why and offers the other provider when that one is ready. It never switches by itself. A provider that stops answering while an agent runs does not fail the session: it keeps its last status, and its detail says since when that status may be out of date.

## What a row means

- **Age.** Time since the pull request was ready for review: when it last left draft, or when it was opened if it never was one. It is plain for three hours, turns yellow by the end of a day, and red after two days. A draft shows the time since it was opened, with no colour, and its row is dimmed. A stack shows its oldest pull request that is out of draft. The time comes with the next refresh; until then the row uses the time it was opened.
- **CI.** Passed is shown plainly, so the colours are the rows that need a look. Red means a required check failed, including a GitHub Actions workflow that failed before it created any jobs. Yellow means required checks are fine and an optional check failed. Blue means something is still running, or GitHub is still blocked on a required check that never reported. Hover a status for each check. A check from an older run of the same workflow does not count once a later run has replaced it, including a matrix job that was cancelled before it expanded and kept its bare name. Rerun failed, or rerun all, applies to GitHub Actions workflows on that row. Vercel and other external checks are listed and cannot be rerun from here.
- **Branch.** A red cross is a merge conflict. A white cross is a branch behind its base with no conflict. Nothing means it is up to date. Click a red cross to start an agent that resolves the conflict on the pull request’s existing branch; its status shows under Agents. Click a white cross to rebase.
- **Review.** Three marks, in order: any approval, a human approval, and GitHub’s merge requirement (including code owners when that rule applies). Grey means no review is required, which is common on drafts and on stacked pull requests whose base is not the default branch. White is still waiting. Green means that mark is satisfied. Hover for the reviewers on each pull request: a green ring approved, a red ring asked for changes.
- **Feedback.** Each count sits beside an icon; hover one for its name and click it to open the feedback drawer filtered to it. The drawer has one filter per count plus All, which shows the conversation and every thread, so any click reaches everything. A thread you answer stays in view until you change the filter. On My PRs: threads awaiting you, comments, and unresolved threads. Awaiting you means the thread is unresolved and the latest human comment is not yours. On Review: unread threads you joined that have a newer reply, comments, resolved threads you joined that moved after you last spoke, and unresolved threads. A comment is a conversation comment or a review summary you have not answered. On Review the comment count is highlighted when one is a review summary or a conversation you already joined. Inline thread replies count as an answer. The total thread count shows only when nothing else does.
- **Merge.** A Merge button shows when the pull request targets the repository’s default branch and looks ready to squash: not a draft, not conflicting, not behind, and not blocked by required reviews or checks. One click puts it in the merge queue, which reads the pull request again, updates the branch if it has fallen behind, and squash-merges it. With nothing else in flight for that repository this happens straight away. The row shows the queue’s status until the merge lands. A pull request the merge queue has merged stays off the list when a refresh still sees it as open. It comes back when GitHub reports that it is still open, or when a later queue attempt for it fails. Each repository runs its own line in the merge queue, so a merge waiting on checks in one repository does not hold up another, and the queue page shows one section per repository. A queued merge that fails is held aside, and the merges behind it carry on. On the row, hover or click the Failed badge for the reason; the queue page shows it in full. Retry, on the row or on the queue page, reads the pull request again and puts the entry back where it stood, so a fix you pushed since is what merges. Remove drops it. A stack that stopped part-way through a rebase needs its remaining branches restacked before a retry can continue.
- **Agents.** Sessions started from this dashboard, in Cursor or T3 Code. Each row shows how many sessions it has, colored by the most active one: yellow while one waits for an answer, blue while one is creating or running, green when finished, red when failed, and grey when cancelled or expired. Click the count for a line on each session: what it is for, its status, and when it started. Click a line to open a sidebar with a section for each session, holding its prompt, final reply, pushed branch, links to the session in Cursor or T3 Code, and a button that copies the reply. Statuses update when the dashboard refreshes.
- **Row menu.** *Link Linear issue* attaches this pull request to an issue. Merging the pull request does not close that issue. *Work on #N with Cursor*, or *with T3 Code*, starts an agent with your prompt, plus the pull request’s link, branches, and linked issues. *Investigate CI failure* appears when a check failed, and is also in the CI popover. That agent reads the failing logs, pushes a fix when the cause is clear, and otherwise reports what it found. A conflict or CI agent runs once at a time on a pull request. Prompts can run side by side.

Required check names come from each repository’s rulesets, so a check that is required to land on the default branch still counts as required on a stacked pull request.

## Stacks and headings

A collapsed stack shows one segment for each pull request, the bottom of the stack first. Green can merge now, amber needs you, red has a conflict or failing CI, grey is waiting on someone else, and an outline is a draft. On Review, green means you approved it. Hover a segment for the pull request number.

A stack with branches is one stack, and each pull request is listed once. Collapsed, the row is named after the top of the part every branch shares, the strip splits into a line for each branch, and the row says how many branches there are. Expanded, the rail gives each branch its own lane and curves in where a branch joins the pull request it is based on. Merging a pull request merges it and the ones below it, and restacks every other branch in the stack. Rebasing one restacks every branch above it. A branch that is neither above nor below what a section shows is left out of that section.

Project, issue and initiative headings count the same states for the rows under them, so a collapsed heading still says whether it needs you.

## Repositories

Each repository has an icon and a colour. It starts with a pair chosen from its name, and you can change it beside the repository in Settings. The Repo column shows the icon, and is hidden when every pull request in the list is in one repository. The merge queue shows it beside each repository name.

## Initiatives

Initiatives are tags stored in this app, not on GitHub. Create, rename, and delete them in Settings. Use them for cleanup, refactors, and other work that has no Linear project. A pull request can have more than one. A pull request with a Linear project stays under that project; the initiative chip still shows on the row. A stack that also contains other work shows `…` rows above or below the slice in that section.

## Desktop app (Mac)

`desktop/` is an Electron shell around the same server. The dashboard is the first tab. A link it opens, such as a pull request, a Linear issue or a Graphite stack, becomes another tab in the same window, and sign-ins are kept between launches. The button at the right of the tab strip, or ⇧⌘O, opens the current tab in your default browser. Right-click a link to open it there instead. Linear pages stay in the tab even when Linear is set to open links in its desktop app. ⌘T opens the link on the clipboard.

**Sidebar.** The button at the left of the tab strip, or ⌃⌘S, swaps the strip's tabs for a sidebar, and the strip then names the page you are on. The sidebar lists open tabs only. A tab on a pull request the dashboard knows shows that pull request's title, check status and the number of comments waiting on you, whether the tab is on GitHub or Graphite. The picker beside Tabs groups them as the dashboard does, by project, issue, initiative or stack, or not at all. Groups and the pull requests in them come in the dashboard's order, so a stack reads top to bottom. A line through the status dots joins the open pull requests of a stack: dotted where pull requests between two rows are not open, a short dotted end where the stack goes on above or below, and a second lane for a branch, which curves in at the pull request it is based on. Hover a row to see what it is based on. A page opened from a pull request sits under it. Linear pages have a section of their own, grouped by project, which is known for issues and projects linked to a pull request on the dashboard. Linear Tabs by Project in the picker turns that grouping off. Other pages that belong to no pull request go under Other. A dashboard link to a pull request that already has a tab goes to that tab. When a tab leaves its pull request the row takes the new page's name at once, and moves to its new place when you switch to another tab. Drag the sidebar's right edge to resize it, or double-click the edge to reset it. Merge queue and Settings at the bottom switch the dashboard to those pages; Pull requests at the top goes back to the list, at the place you left it. ⌘+ and ⌘- zoom the page, or the strip and sidebar when you last clicked there. Closing a tab returns to the tab you were on before it.

**Agents.** The sidebar lists every agent started from the dashboard that is running, or that finished or failed since you last looked at it. Click one to open it, which marks it read; it keeps its row until you switch to another tab. The × sets it aside without opening it. Read and set-aside agents are under Earlier. With the sidebar hidden, a count in the strip opens the same list. What you have read is kept in `agents.json` in the app's data folder.

```bash
cd desktop
npm install
npm run install-app   # builds PR Dash.app and copies it to /Applications
```

`npm run dev` runs it without packaging. The app is built for Apple silicon and signed for this machine only.

The app keeps its own data in `~/Library/Application Support/PR Dash`: the database under `data/`, an optional `.env` with the same keys as above, and `server.log`. It listens on `127.0.0.1:4318`, so `npm run dev` can run beside it. Only the dashboard tab can reach that API; pages in other tabs cannot.

**Updates.** Every push to `main` builds the server and web assets and replaces the asset on the `payload` release. The app checks that release when it starts and every five minutes, using `GITHUB_TOKEN` or `gh auth token`. A newer build is downloaded, the server is restarted on it, and the dashboard tab reloads. Other tabs are left alone. While you are looking at the dashboard the app waits and shows an Update button, so a reply you are typing is not lost; it applies the update when you switch tab or window. A build that fails to start is dropped and the previous one keeps running. The shell itself changes only when you run `npm run install-app` again.

## Deploy

The process is one Node server. Bind address defaults to `127.0.0.1`. To run it somewhere else:

```bash
npm run build
HOST=0.0.0.0 PORT=4317 DATABASE_PATH=/data/pr-dash.sqlite GITHUB_TOKEN=... npm start
```

Or build the Docker image. Mount a volume at `/data` so initiatives and the snapshot survive restarts.

The server holds a token that can read your pull requests, rerun workflows, and squash-merge into the default branch. Keep it on a private network.

The API refuses requests from pages on another site. On the default local address it also refuses any request whose `Host` is not this machine. With `HOST` set to anything else it accepts whatever name it is reached by, so that check is off.
