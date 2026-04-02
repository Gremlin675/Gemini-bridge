## Gemini-relay
Aggregate free Gemini API quota from multiple Google accounts and API keys into a single local endpoint — including access to Gemini 3.1 models.

## How it works

`server.js` runs a local WebSocket server. Browser tabs running the AI Studio app connect to it and process requests using their own free quota. Free-tier API keys can be added alongside for additional capacity. The server automatically routes each request to the best available resource and handles failover — if a browser tab or API key hits its quota for a specific model, it gets marked as unavailable and requests are rerouted to the next one.

```
client.py  ──►  server.js :8765  ──►  AI Studio browser tab (account 1)
                                  ──►  AI Studio browser tab (account 2)
                                  ──►  free API keys (optional)
```

You can open multiple tabs from different Google accounts to multiply your available quota.

## Setup

**Requirements**

```bash
# Python
pip install websockets asyncio

# Node.js
npm install @google/generative-ai express cors ws
```

**1. Start the server**
```bash
node server.js
```

**2. Setting up the app in your browser**

You can set up the project using one of the two methods below:

### Option 1: Remix the Shared App (Easiest)
Use the shared app: https://ai.studio/apps/7a3bde4f-8a00-4391-9160-06172dd6e363
Then **remix** it so changes from my app don't affect you.


### Option 2: Create a New Project from Scratch
Create a new project in AI studio (example prompt: "empty project").
<img width="1015" height="415" alt="image" src="https://github.com/user-attachments/assets/4d9c1615-9d5c-412d-9d95-ed58d9518406" />

Wait for the AI to initialize the project. 

Next, delete all files one by one (ugh I know it's so frustrating right? All the files one by one. Can't Google make a "delete all" button?).
<img width="1856" height="962" alt="image" src="https://github.com/user-attachments/assets/54285777-60fb-482a-9766-b986066fb455" />

Finally, upload the `browser_client.zip` file from the repo to your Google AI Studio code.
<img width="1856" height="962" alt="image" src="https://github.com/user-attachments/assets/2e1f8b94-0c53-40a3-9549-b3c2d9e90a57" />

> ⚠️ The browser tab must stay open while making API calls.  
> Open multiple tabs from different Google accounts for more quota.

**3. Use from Python**
```python
from client import send_txt_request_sync, send_image_request_sync

# Text
response = send_txt_request_sync("What is 2 + 2?", "gemini-3-flash-preview")
print(response)

# Image generation
send_image_request_sync(["input.png"], "Make the sky purple", "output.png")
```

## Optional: Add free API keys

Get free-tier API keys at https://aistudio.google.com/app/apikey and add them to `.env` file:
In .env.example is an example how to add keys.

The server load-balances across them automatically.



## Notes
I kinda dont understand websecurity so use this repo only for your responsibility.
- Server binds to `127.0.0.1` only — not exposed to your LAN or the internet
- `usage_data.json` is created automatically to track daily usage per key/model
- Do not commit your API keys — add `usage_data.json` to `.gitignore` and load keys from an `.env` file
