# Attendance WhatsApp Gateway (Free Self-Hosted)

A lightweight Node.js service using `@whiskeysockets/baileys` that allows your Attendance system to automatically send WhatsApp messages (such as Late Arrival Notices) to groups and management from a single linked WhatsApp number.

---

## 🚀 3-Minute Deployment on Render.com (100% Free)

1. **Create a GitHub Repository**:
   - Create a new repository on [GitHub](https://github.com/new) (e.g. `attendance-whatsapp-gateway`).
   - Push this `whatsapp-gateway` folder contents to that repository.

2. **Deploy on Render**:
   - Log in to [Render.com](https://render.com) (free).
   - Click **New +** -> **Web Service**.
   - Select your GitHub repository `attendance-whatsapp-gateway`.
   - Settings:
     - **Name**: `attendance-whatsapp-gateway`
     - **Region**: Singapore or closest to you
     - **Runtime**: `Node`
     - **Build Command**: `npm install`
     - **Start Command**: `node server.js`
     - **Instance Type**: `Free`
   - **Environment Variables**:
     - `API_KEY` = `attendance_wa_secret_key_2026` (or your chosen secret key)
   - Click **Create Web Service**.

3. **Copy your Render URL**:
   - Example: `https://attendance-whatsapp-gateway.onrender.com`
   - Paste this URL and your `API_KEY` into your Attendance **Admin Settings > WhatsApp Gateway**.

4. **Link WhatsApp Number**:
   - In your Attendance Admin Portal, open the WhatsApp QR tab.
   - On your Main Phone: Open WhatsApp > **Linked Devices** > **Link a Device** > Scan the QR.
   - Done! All late requests will now automatically post into your selected WhatsApp group.
