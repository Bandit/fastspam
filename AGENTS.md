# AGENTS.md

## Rule: no personal information in this repository

This repository is public. Nothing that identifies the maintainer, their mailbox or the people
who write to them may be committed. That covers every file, commit message, branch name, tag,
pull request, issue and release note. A value that has been pushed stays in the history even
after it is deleted from a file, so the time to catch it is before the commit.

**Never commit:**

- Real email addresses, names or domains: the maintainer's, their correspondents', or senders
  found in their mail. Use invented addresses at the reserved example domains only:
  `example.com`, `example.net`, `example.org`, `*.example`, `*.test`.
- Anything from `.dev.vars`: tokens, `EMAIL_FROM`/`EMAIL_TO`, folder names
  (`INCOMING_MAILBOXES`, `DIGEST_MAILBOX`, `QUARANTINE_MAILBOX`, …), the timezone, and AI
  Gateway ids.
- Cloudflare account ids, KV namespace ids, workers.dev subdomains and deployment ids.
- Real mail: subjects, senders, previews, headers, Message-IDs, JMAP email or thread ids,
  screenshots, and anecdotes that identify the maintainer or their correspondents. Aggregate
  figures with no identifying detail (evaluation scores, "about one message in ten reached the
  model") are fine.
- Anything from `eval-private/` or `eval-results/`. Both are gitignored. Only aggregate scores
  go in the README.

**The one exception:** the git author name and email on commits.

**Use instead:** invented examples at `example.com`, generic folder names such as `Lists/Receipts`,
`Europe/London` for a timezone example, and `UTC` as a default. When the maintainer's own setup
explains why a feature exists, describe it as a general case ("if you file notifications in a
folder…"), not as theirs.

**Where real values may live:** `.dev.vars`, `eval-private/`, `eval-results/`, and scratch
files outside the repository. Never copy from those into a tracked file.

**Checks:** `npm test` runs `test/privacy.test.ts`. It fails on any email address outside the
reserved domains, on tracked `.dev.vars` or eval data, on a committed KV namespace id, and, when
`.dev.vars` exists locally, on any of its personal values found in a tracked file. The test
cannot read commit messages or recognise every kind of personal detail, so read the staged diff
and the commit message against this list before every commit.
