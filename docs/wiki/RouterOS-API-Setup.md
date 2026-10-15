# RouterOS API Setup

This page covers everything on the router side: enabling the REST API, creating a dedicated user, setting up TLS, and opening firewall access. Complete these steps before following [Getting-Started.md](Getting-Started.md).

---

## Enable the REST API

RouterOS exposes the REST API at `/rest` through the `www-ssl` (HTTPS, default port `443`) or `www` (HTTP, default port `80`, supported since RouterOS `7.9`) service. Use HTTPS for all production setups. The `api` and `api-ssl` services are the separate binary API, normally on ports `8728` and `8729`; changing their ports does not make them REST endpoints. See MikroTik's [REST API](https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST%2BAPI) and [Services](https://help.mikrotik.com/docs/spaces/ROS/pages/103841820/Services) documentation.

The web services also serve WebFig, so their port and source-address settings affect WebFig access too.

HTTPS requires a server certificate with its private key, explicitly assigned to `www-ssl`. The examples below assume you have already created or imported a certificate named `rest-cert`; replace that name with your own. See [TLS Configuration](#tls-configuration) for certificate options.

### Using Winbox

1. Open **Winbox** and connect to your router.
2. Go to **IP → Services**.
3. Find the `www-ssl` row and double-click it.
4. Set **Port** to `443` (or your preferred port).
5. Select your server certificate (`rest-cert` in these examples) in **Certificate**.
6. Enable the service, then click **OK**.

To restrict which addresses can connect, set the **Available From** field to your MikroMCP host IP or subnet.

### Using the CLI

```
/ip service set www-ssl certificate=rest-cert port=443 disabled=no
```

To restrict access by source address:

```
/ip service set www-ssl address=192.168.1.0/24
```

Confirm the service configuration:

```
/ip service print detail where name=www-ssl
```

You should see `www-ssl` with `disabled=no`, your chosen port, and `certificate=rest-cert` (or your certificate's name). Set the same port in MikroMCP's `routers.yaml`.

---

## Create a Dedicated API User

Never use the `admin` account for automation. Create a named user so you can revoke access independently, audit which account made changes, and apply the minimum required policy.

### Read-only access (list and inspect tools)

```
/user add name=mcp-api group=read password=choose-a-strong-password
```

### Full tool access (all 132 tools including write, diagnostics, and reboot)

```
/user add name=mcp-api group=full password=choose-a-strong-password
```

### Least-privilege custom group

If you want fine-grained control, create a custom group with exactly the policies you need:

```
/user group add name=mcp-group policy=read,write,api,rest-api,test,ssh,sniff,ftp
/user add name=mcp-api group=mcp-group password=choose-a-strong-password
```

See the required policies table below to decide which policies to include.

---

## Required Policies by Tool Category

| Tool category | Required RouterOS policies |
|---|---|
| All read/list tools (`get_system_status`, `list_interfaces`, `list_routes`, etc.) | `read`, `rest-api` |
| Write tools (`manage_firewall_rule`, `manage_route`, `manage_dns_entry`, `manage_ip_address`, etc.) | `read`, `write`, `rest-api` |
| `ping` | `read`, `write`, `test`, `ssh` |
| `traceroute` | `read`, `write`, `test`, `rest-api` |
| `run_command` (guarded SSH execution) | `read`, `write`, `test`, `ssh` |
| `torch` (traffic monitoring) | `read`, `write`, `test`, `rest-api`, `sniff` |
| `upload_file` | `read`, `write`, `ssh` (SFTP, preferred) — or `ftp` for the plaintext fallback |
| `reboot` | `read`, `write`, `reboot`, `rest-api` |
| `manage_package` (install/uninstall) | `read`, `write`, `rest-api` |

`traceroute` and `torch` run through the REST user. Earlier releases ran them through the SSH user; if you granted `test`/`sniff` only to a separate SSH user, add them to the REST user's group.

The simplest all-in-one policy set for full coverage:

```
read, write, api, rest-api, test, ssh, sniff, ftp
```

Note: `reboot` policy must be added explicitly if you want the `reboot` tool — it is not included in the `full` group's default policy set on all ROS versions.

---

## TLS Configuration

### Option A: No TLS (port 80, plaintext — lab/local only)

On RouterOS `7.9` or newer, enable the plain `www` service for HTTP REST access:

```
/ip service set www port=80 disabled=no
```

In `routers.yaml`, set:

```yaml
tls:
  enabled: false
port: 80
```

Do not use this on any network you do not fully control. Router credentials travel in cleartext.

### Option B: Self-signed certificate

Create or import a server certificate and its private key, then assign it to `www-ssl` as shown above. Enabling the service does not generate a certificate automatically. MikroTik's [WebFig HTTPS guide](https://help.mikrotik.com/docs/spaces/ROS/pages/328131/WebFig#WebFig-EnableHTTPS) explains certificate setup for this same web service.

Trust your CA with `tls.ca` and `rejectUnauthorized: true`, or set `rejectUnauthorized: false` and pin the certificate's verified fingerprint:

```yaml
tls:
  enabled: true
  rejectUnauthorized: false
  fingerprint: "AA:BB:CC:..."    # replace with the verified SHA-256 fingerprint — see below
```

### Option C: Let's Encrypt certificate

RouterOS 7.x supports Let's Encrypt via the `/certificate` menu if your router has a public hostname. Once a valid cert is installed, assign it to `www-ssl` using its certificate name and set `rejectUnauthorized: true` — no fingerprint needed. Set `host` in `routers.yaml` to a hostname covered by that certificate.

### Fingerprint pinning (recommended with self-signed certs)

Pinning the TLS fingerprint prevents a man-in-the-middle from presenting a different certificate. Get the fingerprint with:

```bash
openssl s_client -connect 10.0.0.1:443 -showcerts </dev/null 2>/dev/null \
  | openssl x509 -fingerprint -sha256 -noout
```

This prints something like:

```
SHA256 Fingerprint=AA:BB:CC:DD:...
```

Add it to `routers.yaml`:

```yaml
tls:
  enabled: true
  rejectUnauthorized: false
  fingerprint: "AA:BB:CC:DD:..."
```

MikroMCP will reject any connection where the server certificate does not match this fingerprint.

---

## Firewall — Allow API Access

If your RouterOS firewall has a default-deny input policy (common on production gear), you must explicitly allow the MikroMCP host to reach the API port.

```
/ip firewall filter add \
  chain=input \
  protocol=tcp \
  dst-port=443 \
  src-address=192.168.1.100 \
  action=accept \
  comment="MikroMCP API access" \
  place-before=0
```

Replace `192.168.1.100` with the IP of the machine running MikroMCP. If MikroMCP runs on a subnet (e.g. Docker or a management VLAN), use a `/24` prefix:

```
src-address=192.168.10.0/24
```

Confirm the rule is in place:

```
/ip firewall filter print where comment="MikroMCP API access"
```

---

## Testing the Connection

Once the API is enabled and a user is created, verify the connection from the MikroMCP host before configuring any AI client:

```bash
curl -sk https://10.0.0.1/rest/system/resource \
  --user mcp-api:your-password | python3 -m json.tool
```

A successful response looks like:

```json
{
  "architecture-name": "arm64",
  "board-name": "RB5009UG+S+",
  "cpu": "ARM",
  "cpu-frequency": "1400",
  "cpu-load": "3",
  "free-memory": "512000000",
  "uptime": "1d2h30m",
  "version": "7.14.1 (stable)"
}
```

If you get a `401`, the username or password is wrong. If you get a `403`, the user lacks `rest-api` policy. If the connection is refused, the service is not running or the firewall is blocking the port.

---

## Next Step

Return to [Getting-Started.md](Getting-Started.md) to configure MikroMCP and connect it to your AI assistant.
