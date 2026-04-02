This small project is a way to aggregate many free gemini models calls in one place and get couple free calls to gemini 3.1 models.

How it works:
Server.js creates websocket server on port 8765.
Then the browser connects to it and responds .
Server routes requests to FREE gemini api_keys or browser.
You can have multiple browser clients from multiple google accounts.
When servers sends a request for a specific model (eg.gemini-3-flash-preview) and browser or api_key sends back an error message "resource_exhausted the server sets is as unavailable for this particular model
and routes requests to other browser tabs or api_keys.

Setup
Python requirements:
pip install websockets asyncio

Node js requirements:
npm install GoogleGenerativeAI express cors WebSocket

Copy the server.js file.
Run command:
node server.js

Then run this ai studio app in your browser (browser tab with the app must stay open during use of the api calls) 
https://ai.studio/apps/7a3bde4f-8a00-4391-9160-06172dd6e363


Then you can use the send_image_request or send_txt_request from clinet.py

Optional:
You can get FREE tier api_keys from google at https://aistudio.google.com/app/api-keys
Then paste then to the API_KEYS table in server.js file.
