# pr-dash

A local dashboard for pull requests you authored. Stacks collapse to one row. CI, review, and review threads are on the row. The page is one outline: Linear projects, then initiatives, then issues with no project, then pull requests with no issue.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:4317.

The server uses `GITHUB_TOKEN` or `GH_TOKEN` when set, and otherwise `gh auth token`. A refresh pulls your open pull requests, then keeps that snapshot in `data/pr-dash.sqlite`. The page refreshes itself about once a minute while the tab is visible. Sort, filters, and which stacks are expanded are remembered in this browser.

`LINEAR_API_KEY` is optional. Without it, issue titles still come from the Linear link on the pull request. Project names need the key.

## What a row means

- **CI.** Red means a required check failed. Yellow means required checks are fine and an optional check failed. Blue means something is still running. Hover a status for each check. Rerun failed, or rerun all, applies to GitHub Actions workflows on that row. Vercel and other external checks are listed and cannot be rerun from here.
- **Review.** Three marks, in order: any approval, a human approval, and GitHub’s merge requirement (including code owners when that rule applies). Grey means no review is required, which is common on drafts and on stacked pull requests whose base is not the default branch. White is still waiting. Green means that mark is satisfied.
- **Feedback.** Threads, unresolved threads, and threads awaiting you. Awaiting you means the thread is unresolved and the latest human comment is not yours.
- **Merge.** A Merge button shows when the pull request targets the repository’s default branch and looks ready to squash: not a draft, not conflicting, not behind, and not blocked by required reviews or checks. One click squash-merges it. The button stays pending until GitHub confirms. The row leaves the list after a success, and stays, with GitHub’s error, if the merge is refused.

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
