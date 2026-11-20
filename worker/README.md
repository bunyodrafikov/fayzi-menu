# Menu admin

The manager edits the menu at `https://fayzi-chayhana.site/admin/` with a password.

```
admin page (site/admin/)  ->  this Worker (checks password)  ->  commit to GitHub  ->  Pages workflow rebuilds site
```

The password and the GitHub token live only in the Worker as secrets. Every save is a normal commit
("Menu update from admin page"), so any change can be reverted with git.

## One-time setup

1. **GitHub token.** github.com → Settings → Developer settings → Fine-grained tokens → Generate:
   - Repository access: *Only select repositories* → `fayzi-menu`
   - Permissions: *Contents* → Read and write (nothing else)
   - Expiration: up to you (a year is fine; the admin page stops saving when it expires)
2. **Cloudflare.** Create a free account at dash.cloudflare.com, then from this folder:
   ```bash
   cd worker
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put GITHUB_TOKEN      # paste the token
   npx wrangler secret put ADMIN_PASSWORD    # the manager's password: long, e.g. four random words
   ```
   `deploy` prints the Worker URL, e.g. `https://fayzi-menu-admin.<you>.workers.dev`.
3. Put that URL into `API` at the top of the script in `site/admin/index.html`, commit, push.

## Day to day

- **Change the password:** `npx wrangler secret put ADMIN_PASSWORD` (takes effect at once; the manager logs in again).
- **Revoke access completely:** delete the token on GitHub.
- **Changed the site address** (custom domain): update `ALLOWED_ORIGIN` in `wrangler.toml` and `npx wrangler deploy`.
- **Test:** `node worker/test.mjs`
