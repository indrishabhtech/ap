
# Private Media Site (updated)

This repo contains:
- server.js : backend (Express) to upload to Cloudinary and save metadata to MongoDB Atlas
- public/ : frontend (index.html and admin.html)

## Local setup
1. Place repo at e.g. C:\Users\traya\Desktop\Project's-Rishabh
2. cd into project folder (use quotes because folder has apostrophe):
   cd "C:\Users\traya\Desktop\Project's-Rishabh"
3. Copy .env.example to .env and fill values
4. npm install
5. npm run dev
6. Open http://localhost:3000/admin.html and http://localhost:3000/

If admin.html shows 'Cannot GET /admin.html' ensure you started the server from the project root where server.js and public/ are located.

