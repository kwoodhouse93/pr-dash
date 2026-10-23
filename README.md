# pr-dash

A local dashboard for pull requests you authored and pull requests you review. Stacks collapse to one row. CI, review, and review threads are on the row. Each list is one outline: Linear projects, then initiatives, then issues with no project, then pull requests with no issue.

My PRs is changes you opened. Review is open pull requests that request your review, including teams you belong to, plus open pull requests you have already reviewed. Review rows show the author and leave out merge actions. A refresh loads the tab you are looking at first.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:4317.

The server uses `GITHUB_TOKEN` or `GH_TOKEN` when set, and otherwise `gh auth token`. A refresh pulls the open list you are looking at, then keeps that snapshot in `data/pr-dash.sqlite`. That list refreshes about every 3 minutes while the tab is visible, and pauses when few GraphQL points remain. Thread replies load after the list, and again when a pull request changes. The row menu can refresh one pull request. Required checks are cached for a day. Settings has a full sync that reloads both lists and reads rulesets again. Sort, filters, and which stacks are expanded are remembered in this browser.

Settings chooses which repositories a refresh includes. Pick an owner, then the repositories under that owner. None are included until you select them, so a refresh does not ask GitHub about every repository you can access. Removing a repository deletes the pull requests, cached rules, agent sessions, and merge queue entries stored for it. That does not change the repository on GitHub.

`LINEAR_API_KEY` is optional. Without it, issue titles still come from the Linear link on the pull request. Project names, status, assignee, and linking a pull request to an issue need the key. Linking uses Linear’s GitHub attachment, so the workspace GitHub integration has to be connected. The link stays on the pull request after a refresh.

Set `CURSOR_API_KEY` to start Cursor Cloud Agents from a row: resolve a merge conflict, investigate failing CI, or run your own prompt. Each agent works on and pushes to the pull request’s existing head branch. The dashboard remembers every session and refreshes active ones with the pull requests. Create a user or service-account key in the Cursor dashboard. The key remains on this server.

## What a row means

- **CI.** Red means a required check failed, including a GitHub Actions workflow that failed before it created any jobs. Yellow means required checks are fine and an optional check failed. Blue means something is still running, or GitHub is still blocked on a required check that never reported. Hover a status for each check. Rerun failed, or rerun all, applies to GitHub Actions workflows on that row. Vercel and other external checks are listed and cannot be rerun from here.
- **Review.** Three marks, in order: any approval, a human approval, and GitHub’s merge requirement (including code owners when that rule applies). Grey means no review is required, which is common on drafts and on stacked pull requests whose base is not the default branch. White is still waiting. Green means that mark is satisfied.
- **Feedback.** On My PRs: threads, unresolved threads, and threads awaiting you. Awaiting you means the thread is unresolved and the latest human comment is not yours. On Review: unread threads you joined that have a newer reply, resolved threads you joined that moved after you last spoke, unresolved threads, and total threads. On My PRs, a highlighted comment means a conversation comment or a review summary you have not answered. On Review, that highlight is a review summary, or a conversation you already joined. Other conversation comments stay visible without the highlight. Inline thread replies count as an answer.
- **Merge.** A Merge button shows when the pull request targets the repository’s default branch and looks ready to squash: not a draft, not conflicting, not behind, and not blocked by required reviews or checks. One click squash-merges it. The button stays pending until GitHub confirms. The row leaves the list after a success, and stays, with GitHub’s error, if the merge is refused. A pull request the merge queue has merged stays off the list when a refresh still sees it as open. It comes back when GitHub reports that it is still open, or when a later queue attempt for it fails.
- **Conflict.** Click a red conflict mark and choose the affected pull request to start a Cursor Cloud Agent. It resolves the conflict on the pull request’s existing branch. Its status shows under Agents.
- **Agents.** Cursor sessions started from this dashboard. One session shows its status: Creating, Running, Finished, Failed, Cancelled, or Expired. More than one shows a count, colored by the most active session. Click it to see each session’s task, status, final reply, pushed branch, and links to Cursor and the web. Statuses update when the dashboard refreshes.
- **Row menu.** *Link Linear issue* attaches this pull request to an issue. Merging the pull request does not close that issue. *Work on #N with Cursor* starts an agent with your prompt, plus the pull request’s link, branches, and linked issues. *Investigate CI failure* appears when a check failed, and is also in the CI popover. That agent reads the failing logs, pushes a fix when the cause is clear, and otherwise reports what it found. A conflict or CI agent runs once at a time on a pull request. Prompts can run side by side.

Required check names come from each repository’s rulesets, so a check that is required to land on the default branch still counts as required on a stacked pull request.

## Initiatives

Initiatives are tags stored in this app, not on GitHub. Use them for cleanup, refactors, and other work that has no Linear project. A pull request can have more than one. A pull request with a Linear project stays under that project; the initiative chip still shows on the row. A stack that also contains other work shows `…` rows above or below the slice in that section.

## Deploy

The process is one Node server. Bind address defaults to `127.0.0.1`. To run it somewhere else:

```bash
npm run build
HOST=0.0.0.0 PORT=4317 DATABASE_PATH=/data/pr-dash.sqlite GITHUB_TOKEN=... npm start
```

Or build the Docker image. Mount a volume at `/data` so initiatives and the snapshot survive restarts.

The server holds a token that can read your pull requests, rerun workflows, and squash-merge into the default branch. Keep it on a private network.
