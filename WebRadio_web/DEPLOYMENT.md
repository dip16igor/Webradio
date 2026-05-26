# WebRadio Deployment Guide

## Overview
This guide describes how to deploy the WebRadio application on a VPS server with nginx reverse proxy and Docker.

## Prerequisites

- VPS server with Ubuntu/Debian
- Docker and Docker Compose installed
- nginx web server with SSL certificates (Let's Encrypt recommended)
- MQTT broker running on the host (e.g., Mosquitto)
- Domain name pointed to the server IP

## Directory Structure

```
/home/dip16/apps/webradio/
├── public/           # Static files (HTML, CSS, JS, images)
├── server.js         # Node.js application
├── package.json
├── Dockerfile
└── .env              # Environment variables
```

## 1. Prepare the Application

### Clone/Copy the Application
```bash
mkdir -p /home/dip16/apps/webradio
cd /home/dip16/apps/webradio
# Copy application files to this directory
```

### Create Environment File (.env)
```bash
cat > /home/dip16/apps/webradio/.env << 'EOF'
SECRET_TOKEN=your_secure_token_here
MQTT_BROKER_URL=mqtt://127.0.0.1:1883
MQTT_USER=your_mqtt_user
MQTT_PASSWORD=your_mqtt_password
EOF
```

Generate a secure token:
```bash
openssl rand -hex 32
```

## 2. Build and Run Docker Container

### Build the Image
```bash
cd /home/dip16/apps/webradio
docker build -t webradio .
```

### Run the Container
```bash
docker run -d \
  --name webradio \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file /home/dip16/apps/webradio/.env \
  --add-host host.docker.internal:host-gateway \
  webradio
```

The container is accessible only on localhost (127.0.0.1) for security.

## 3. Configure nginx Reverse Proxy

### Create nginx Configuration
Add to your nginx configuration (typically `/etc/nginx/sites-available/your-site`):

```nginx
# WebSocket for WebRadio
location /webradio/ws {
    proxy_pass http://127.0.0.1:3000/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# WebRadio main application
location /webradio/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Reload nginx
```bash
nginx -t && nginx -s reload
```

## 4. HTML Path Configuration

The `public/index.html` must use **relative paths** for assets to work correctly under the `/webradio/` subpath:

```html
<!-- CORRECT - relative paths -->
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="favicon-16x16.png">
<link rel="manifest" href="site.webmanifest">
<link rel="stylesheet" href="style.css">

<!-- WRONG - absolute paths won't work -->
<link rel="icon" href="/favicon-32x32.png">
```

Also ensure `<base href="/webradio/">` is set in the HTML head.

## 5. Update Container Files (if needed)

If you modify files after container creation:

```bash
# Copy updated files into running container
docker cp /home/dip16/apps/webradio/public/. webradio:/usr/src/app/public/

# Or restart with updated image
docker restart webradio
```

## 6. Verification

### Check Container Status
```bash
docker ps -a | grep webradio
docker logs webradio
```

### Test Endpoints
```bash
# Main page
curl -k https://your-domain.com:8443/webradio/

# API (requires token)
curl -k https://your-domain.com:8443/webradio/api/radio/status \
  -H "X-Auth-Token: your_token"

# WebSocket (test with browser console)
# Look for "WebSocket connection established" in browser dev tools
```

## Troubleshooting

### WebSocket Connection Issues
- Ensure nginx `location /webradio/ws` block is configured before the main `/webradio/` block
- Check that the token matches `SECRET_TOKEN` in `.env`
- Verify MQTT broker connection in container logs

### 404 Errors for Static Assets
- Use relative paths in `index.html` (no leading `/`)
- Copy updated files into container: `docker cp <file> webradio:/usr/src/app/public/`

### MQTT Connection Failed
- Verify MQTT broker is running: `systemctl status mosquitto`
- Check credentials in `.env`
- Ensure container can reach host: `--add-host host.docker.internal:host-gateway`

## File Descriptions

| File | Purpose |
|------|---------|
| `server.js` | Main Node.js application with Express and WebSocket |
| `public/index.html` | Main HTML page with relative asset paths |
| `public/app.js` | Client-side JavaScript for WebSocket communication |
| `public/style.css` | Application styles |
| `.env` | Environment variables (SECRET_TOKEN, MQTT settings) |
| `Dockerfile` | Container build instructions |

## Security Notes

- Never expose port 3000 directly to the internet - always use nginx proxy
- Keep `.env` file secure and never commit to version control
- Use strong, unique SECRET_TOKEN
- Consider IP whitelisting for admin endpoints