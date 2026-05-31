# Deploying the MikroMCP Landing Page

The site is a static Astro build. Output is plain HTML/CSS/JS in `site/dist/` — serve it with nginx.

## 1. Build

```bash
cd site
npm ci
npm run build
```

Output lands in `site/dist/`.

## 2. Push to the server (rsync)

```bash
rsync -avz --delete site/dist/ user@your-hetzner-host:/var/www/mikromcp.com/
```

`--delete` keeps the server in sync with the build (removes stale files). Adjust the user/host/path.

## 3. nginx server block

Create `/etc/nginx/sites-available/mikromcp.com` (then symlink into `sites-enabled/` and reload):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name mikromcp.com www.mikromcp.com;
    root /var/www/mikromcp.com;
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

    location = /llms.txt      { default_type text/plain; }
    location = /llms-full.txt { default_type text/plain; }
    location = /robots.txt    { default_type text/plain; }

    # Redirect www -> apex
    if ($host = www.mikromcp.com) {
        return 301 https://mikromcp.com$request_uri;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/mikromcp.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Cloudflare

The domain is on Cloudflare behind the proxy (orange cloud). Recommended settings:

- **DNS:** `A`/`AAAA` record for `mikromcp.com` → your Hetzner server IP, **Proxied** (orange cloud). Add a `www` record the same way (the nginx block redirects www → apex).
- **SSL/TLS mode:** **Full (strict)**. Install a Cloudflare **Origin Certificate** on the server and terminate TLS at nginx on port 443. Cloudflare terminates TLS at the edge and re-encrypts to your origin.
- **Always Use HTTPS:** On.
- **Caching:** Cloudflare will cache static assets automatically. The long `Cache-Control: immutable` on `/assets/` (fingerprinted files) is safe to cache for a year. Do not cache HTML aggressively — either leave HTML uncached or set a short edge TTL so deploys show up quickly. Purge the Cloudflare cache after a deploy if needed.

### TLS variant of the nginx block

Once the Cloudflare Origin Certificate is installed (e.g. at `/etc/ssl/cloudflare/`), add a 443 server:

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name mikromcp.com www.mikromcp.com;
    root /var/www/mikromcp.com;
    index index.html;

    ssl_certificate     /etc/ssl/cloudflare/mikromcp.com.pem;
    ssl_certificate_key /etc/ssl/cloudflare/mikromcp.com.key;

    # ... same gzip / headers / location blocks as the port-80 server above ...
}
```

Keep the port-80 server for the www→apex redirect and to satisfy Cloudflare's origin pull, or redirect 80→443 if you prefer.

## 5. (Optional) Auto-deploy on push

You can add a GitHub Actions workflow that builds `site/` and rsyncs `dist/` to the server on every push to `main` (using an SSH deploy key stored in repo secrets). Not set up yet — add later if you want hands-off deploys.
