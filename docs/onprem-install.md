# On-premise installation (no Docker)

Afyazuri runs on one modest server on the facility LAN, for example 4 vCPU, 8 GB RAM and an SSD. Clients on the LAN keep working when the internet link is down. PostgreSQL 16 is bundled through `embedded-postgres`, so nothing else needs installing apart from Node.js.

## 1. Prepare the server

|                 | Windows Server / Windows 10–11                                                                                       | Ubuntu 22.04 / 24.04                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Node.js         | Install Node.js 22 LTS from nodejs.org                                                                               | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt-get install -y nodejs` |
| Service account | Create a local **standard** (non-administrator) user, e.g. `afyazuri`. PostgreSQL refuses to run as an administrator | `sudo useradd --system --create-home --home-dir /opt/afyazuri afyazuri`                                |
| Folder          | `C:\Afyazuri` (give the service account Modify rights)                                                               | `/opt/afyazuri` (owned by `afyazuri`)                                                                  |
| Clock           | Time zone **(UTC+03:00) Nairobi**, with time sync enabled                                                            | `sudo timedatectl set-timezone Africa/Nairobi`                                                         |

Give the server a fixed LAN IP address (or a DHCP reservation) and a DNS name if you have one, e.g. `afyazuri.hospital.local`.

## 2. Install Afyazuri

Run these as the service account, inside the install folder:

```bash
git clone https://github.com/Jones-ops/AfyaZuri.git .     # or copy a release archive here
npm ci                       # on npm 11+, approve native packages if prompted: npm install-scripts approve
npm run build                # builds the web app into apps/web/dist
npm run secrets              # writes .env with strong random secrets
```

Then **copy `ENCRYPTION_KEY`, `BLIND_INDEX_KEY` and `BACKUP_KEY` from `.env` to safe offline storage**, kept away from the server and the backups.

Edit `.env` as needed:

```ini
NODE_ENV=production
PORT=4000
CORS_ORIGINS=https://afyazuri.hospital.local:4000
BACKUP_DIR=backups
BACKUP_OFFSITE_DIR=E:/afyazuri-backups        # Windows example: USB disk or network share
# BACKUP_OFFSITE_DIR=/mnt/nas/afyazuri         # Linux example
TLS_CERT_FILE=certs/afyazuri.crt
TLS_KEY_FILE=certs/afyazuri.key
```

## 3. HTTPS on the LAN

Use a certificate for the server's name, from your organisation's CA if it has one. Otherwise create a self-signed certificate valid for about 2 years and install it as trusted on the client machines and tablets:

```bash
mkdir certs
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/afyazuri.key -out certs/afyazuri.crt \
  -subj "/CN=afyazuri.hospital.local" \
  -addext "subjectAltName=DNS:afyazuri.hospital.local,IP:192.168.1.10"
```

(On Windows, OpenSSL comes with Git for Windows: `"C:\Program Files\Git\usr\bin\openssl.exe"`.)

The PWA's offline features (service worker) need HTTPS, or `localhost`.

## 4. First start and first administrator

```bash
npm start                                              # first run initialises the database in data/postgres
# in a second terminal:
npm run admin:create -- --username jdoe --name "Jane Doe"
```

`admin:create` prints a one-time temporary password. Sign in at `https://<server>:4000` and set a new password when asked. Then, under **Facility setup**, add your facility with its KMHFL code, departments, service points, wards and beds, and create staff accounts under **Staff**.

To evaluate with demo data instead, add `SEED_DEMO=true` to `.env` before the first start.

## 5. Start automatically on boot

**Linux (systemd):**

```bash
sudo cp deploy/linux/afyazuri.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now afyazuri
journalctl -u afyazuri -f            # logs
```

**Windows (Task Scheduler):** from an elevated PowerShell in the install folder:

```powershell
.\deploy\windows\install-service.ps1 -User afyazuri
```

This registers a startup task that runs as the `afyazuri` account and restarts on failure, and opens port 4000 on the Domain and Private firewall profiles. To remove it, run `.\deploy\windows\install-service.ps1 -Uninstall`.

## 6. Check it is healthy

- `https://<server>:4000/health` should return `{"status":"ok"}`.
- `https://<server>:4000/ready` should return `{"status":"ready"}` (the database is up and migrated).
- Sign in from a client PC and a tablet.
- After the first night, look in `backups/` for an `afyazuri-YYYYMMDD-HHMMSS.azb` file, then run `npm run backup -- verify <file>`.

## Upgrading

```bash
npm run backup                 # take and verify a backup first
git pull                       # or unpack the new release
npm ci && npm run build
# restart the service (systemctl restart afyazuri / restart the scheduled task)
```

Migrations run automatically at start-up.

## Using an existing PostgreSQL server

If the facility already runs PostgreSQL 16 (or a cloud host provides a managed one), set `EXTERNAL_DATABASE_URL=postgres://user:pass@host:5432/afyazuri` in `.env`. `npm start` will then skip the embedded server. Backups and restores work the same way. On a managed service without superuser access, restore into a database where you are the owner; see [backup-restore.md](backup-restore.md).

The database must use **UTF-8** so names such as _Wambũi Njĩrũ_ and clinical text are stored correctly. Afyazuri refuses to migrate a database with any other encoding. Create it with:

```sql
CREATE DATABASE afyazuri ENCODING 'UTF8' TEMPLATE template0;
```

The embedded server is always created as UTF-8, with ICU collation where the platform build supports it.

## Cloud hosting

Run the same `npm start` on a Linux VM. Put [`deploy/nginx/afyazuri.conf`](../deploy/nginx/afyazuri.conf) in front with a Let's Encrypt certificate (`certbot --nginx`), and keep port 4000 closed to the internet.
