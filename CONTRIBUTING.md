# Contributing from this fork

This repository is maintained as a security-hardened downstream of
[`openbnb-org/mcp-server-airbnb`](https://github.com/openbnb-org/mcp-server-airbnb).

## Upstream updates

Run `scripts/sync-upstream.sh` to fetch and compare upstream. It never merges or
pushes code automatically. Review the displayed commits, create an upgrade branch,
then run the build, production dependency audit, and MCP smoke test before opening
a pull request in this fork.

Keep `origin` pointing at this fork and `upstream` pointing at the OpenBnB project:

```bash
git remote -v
git config remote.pushDefault origin
```

## Contributing fixes upstream

Make and validate a focused change on a branch in this fork, then open a pull
request whose base repository is `openbnb-org/mcp-server-airbnb` and whose head is
`jrjenkinsiv:<branch>`. Do not include local ecosystem wiring or credentials in an
upstream contribution.

## Local security contract

- This fork is search and listing-detail only; it never books or messages hosts.
- It does not expose a robots.txt override and fails closed if robots.txt cannot be
  fetched or parsed.
- Tool-call logs contain only the tool name, duration, and outcome—not destinations,
  dates, guest counts, or listing identifiers.
- Keep dependencies patched: `npm audit --omit=dev` must report zero production
  vulnerabilities before release.
