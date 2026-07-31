import asyncio
import os
import websockets
from google import genai
from google.genai import types

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
PORT = int(os.environ.get("PORT", 10000))

if not GEMINI_API_KEY:
    raise ValueError("GEMINI_API_KEY environment variable is not set!")

client = genai.Client(
    api_key=GEMINI_API_KEY, 
    http_options={'api_version': 'v1alpha'}
)

MODEL = "gemini-2.0-flash"

async def process_request(connection, request):
    """
    Intercepts HTTP requests (like Render/UptimeRobot health checks)
    before the WebSocket handshake takes place.
    """
    # 1. Handle HTTP HEAD or non-WebSocket requests cleanly with 200 OK
    if request.headers.get("Upgrade", "").lower() != "websocket":
        # Return a 200 OK HTTP response for pings/health-checks
        return connection.respond(
            200, 
            [("Content-Type", "text/plain")], 
            b"OK - Gemini Live Bridge Active\n"
        )
    
    # 2. Returning None lets websockets proceed with the WSS handshake
    return None

async def handle_esp32(websocket):
    print("\n[Render] ESP32 Connected via WebSocket!")
    
    config = types.LiveConnectConfig(
        response_modalities=[types.LiveClientContentModality.TEXT]
    )

    try:
        async with client.aio.live.connect(model=MODEL, config=config) as session:
            print("[Render] Gemini Live API Session active!")

            async def receive_from_gemini():
                try:
                    async for response in session.receive():
                        server_content = response.server_content
                        if server_content and server_content.model_turn:
                            for part in server_content.model_turn.parts:
                                if part.text:
                                    print(part.text, end="", flush=True)
                                    await websocket.send(part.text)
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"\n[Gemini Error]: {e}")

            async def send_mic_to_gemini():
                try:
                    async for message in websocket:
                        if isinstance(message, bytes):
                            await session.send(
                                input={"data": message, "mime_type": "audio/pcm"}, 
                                end_of_turn=False
                            )
                        elif isinstance(message, str):
                            await session.send(input=message, end_of_turn=True)
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"\n[ESP32 Error]: {e}")

            await asyncio.gather(receive_from_gemini(), send_mic_to_gemini())

    except websockets.exceptions.ConnectionClosed:
        print("[Render] ESP32 connection closed.")
    except Exception as e:
        print(f"[Render Error]: {e}")

async def main():
    async with websockets.serve(
        handle_esp32, 
        "0.0.0.0", 
        PORT, 
        process_request=process_request
    ):
        print(f"Gemini Live API Bridge running on port {PORT}...")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
