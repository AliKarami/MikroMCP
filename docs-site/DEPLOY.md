# Deploying the MikroMCP Docs Site

Static Starlight build. Content comes from `../docs/wiki/*.md`, transformed at build time
by `scripts/sync-wiki.mjs` (runs automatically via the `prebuild` hook). Edit docs in
`docs/wiki/` as usual — never edit `src/content/docs/` (it is generated and git-ignored).

## 1. Build

```bash
cd docs-site
npm ci
npm run build
```

Output lands in `docs-site/dist/`. The build also generates a Pagefind search index under
`dist/pagefind/`.

> **Note:** `npm ci` must install the platform-specific Pagefind binary (`@pagefind/<platform>`).
> On the Linux build/deploy host this resolves to `@pagefind/linux-x64` (or `linux-arm64`),
> which is recorded in `package-lock.json`. If a build ever fails with
> "Failed to install either of [pagefind_extended, pagefind]", delete `node_modules` and
> `package-lock.json` and run `npm install` once with network access to repopulate the
> optional dependency, then commit the refreshed lockfile.

## 2. Push to the server (rsync)

```bash
rsync -avz --delete docs-site/dist/ user@your-hetzner-host:/var/www/docs.mikromcp.com/
```

`--delete` keeps the server in sync with the build. Adjust user/host/path.

## 3. nginx server block

`/etc/nginx/sites-available/docs.mikromcp.com`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name docs.mikromcp.com;
    root /var/www/docs.mikromcp.com;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 256;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        try_files $uri $uri/ $uri.html =404;
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    location /pagefind/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/docs.mikromcp.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Cloudflare

- **DNS:** `A`/`AAAA` record for `docs.mikromcp.com` → server IP, **Proxied** (orange cloud).
- **SSL/TLS:** **Full (strict)** with a Cloudflare **Origin Certificate** installed on nginx
  (port 443). Mirror the 443 server block from the landing site's `site/DEPLOY.md`, swapping
  `server_name` to `docs.mikromcp.com` and `root` to `/var/www/docs.mikromcp.com`.
- **Always Use HTTPS:** On.
- **Caching:** static assets (`/assets/`, `/pagefind/`) are fingerprinted/safe to cache
  long-term; let HTML revalidate so doc edits appear after a deploy. Purge the Cloudflare
  cache after a deploy if needed.

## 5. Note on CI

A unified GitHub Actions workflow that builds and deploys BOTH `site/` (mikromcp.com) and
`docs-site/` (docs.mikromcp.com) on push to `main` is the next planned task. Until then, use
the manual build + rsync above.
