import asyncio
import websockets
import json
import os
import base64

WEBSOCKET_URI = "ws://localhost:8765"

# ---------------------------------------------------------------------------
# Image utilities
# ---------------------------------------------------------------------------

def image_to_base64(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

def get_mime_type(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return {
        ".jpg":  "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png":  "image/png",
        ".gif":  "image/gif",
        ".webp": "image/webp",
    }.get(ext, "image/jpeg")

def encode_images(img_paths: list[str]) -> list[dict]:
    result = []
    for path in img_paths:
        if not os.path.exists(path):
            print(f"  [skip] not found: {path}")
            continue
        try:
            result.append({"mime_type": get_mime_type(path), "data": image_to_base64(path)})
            print(f"  [ok] {os.path.basename(path)}")
        except Exception as e:
            print(f"  [error] {path}: {e}")
    return result

# ---------------------------------------------------------------------------
# WebSocket transport
# ---------------------------------------------------------------------------

async def _send(request_type: str, model: str, images_data: list[dict], prompt: str, timeout: float = 300.0):
    """Open a WebSocket connection, send a request, and return the parsed response."""
    async with websockets.connect(WEBSOCKET_URI, max_size=50 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"type": "python"}))
        await ws.send(json.dumps({"type": request_type, "model": model, "prompt": prompt, "images_base64": images_data}))
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        return json.loads(raw)

# ---------------------------------------------------------------------------
# Text requests
# ---------------------------------------------------------------------------

async def send_txt_request(prompt: str, model: str, img_paths: list[str] = []) -> str | None:
    images = encode_images(img_paths)
    data = await _send("txt_request", model, images, prompt, timeout=30_000.0)
    if not data:
        return None
    if data.get("type") == "txt_result":
        return data.get("text")
    print(f"  [error] {data.get('type')}: {data.get('message')}")
    return None

def send_txt_request_sync(prompt: str, model: str, images: list[str] = []) -> str | None:
    return asyncio.run(send_txt_request(prompt, model, images))

# ---------------------------------------------------------------------------
# Image generation requests
# ---------------------------------------------------------------------------

async def send_image_request(img_paths: list[str], prompt: str, out_path: str) -> None:
    
    images = encode_images(img_paths)
    if not images:
        print("  [error] No valid images to send.")
        return

    data = await _send("image_request", "gemini-2.5-flash-image", images, prompt, timeout=300.0)
    if not data:
        return

    if data.get("type") == "image_result":
        image_bytes = base64.b64decode(data["image_data"])
        out_dir = os.path.dirname(out_path)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(image_bytes)
        print(f"  [ok] saved to {os.path.abspath(out_path)}")
    else:
        print(f"  [error] unexpected response: {data.get('type')}")

def send_image_request_sync(imgs: list[str], prompt: str, out: str) -> None:
    asyncio.run(send_image_request(imgs, prompt, out))

# ---------------------------------------------------------------------------
# Entry point (quick manual test)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    prompt = "Output an image of her in red dress?"
    result = send_image_request_sync(["client/asd.png"],prompt, "o.png")
    print(result)