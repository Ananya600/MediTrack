import asyncio
import os
import websockets
from google import genai
from google.genai import types

# Fetch port assigned by Render and Gemini API key from environment
PORT = int(os.environ.get("PORT", 10000))
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

if not GEMINI_API_KEY:
    raise ValueError("CRITICAL: GEMINI_API_KEY environment variable is not set!")

# Initialize Google Gen AI client
client = genai.Client(api_key=GEMINI_API_KEY)

# Gemini Live API model ID
MODEL_ID = "gemini-2.0-flash"


async def handle_request(path, request_headers):
    """
    HTTP request handler for Render / UptimeRobot health checks.
    Returns 200 OK for standard HTTP GET pings so Render doesn't sleep.
    """
    if request_headers.get("Upgrade", "").lower() != "websocket":
        return (
            200,
            [("Content-Type", "text/plain")],
            b"OK - Gemini Live Bridge Active\n",
        )
    return None  # Hand off connection to the WebSocket handler


async def handle_esp32(websocket):
    print("\n[Render Bridge] ESP32 Connected via WebSocket!")

    # Configure session to request text responses back from Live API
    config = types.LiveConnectConfig(
        response_modalities=[types.LiveClientContentModality.TEXT]
    )

    try:
        # Establish Live API session with Google
        async with client.aio.live.connect(
            model=MODEL_ID, config=config
        ) as session:
            print("[Render Bridge] Connected to Gemini Live API session.")

            async def receive_from_gemini():
                """Receive response stream from Gemini and forward text to ESP32."""
                try:
                    async for response in session.receive():
                        server_content = response.server_content
                        if server_content and server_content.model_turn:
                            for part in server_content.model_turn.parts:
                                if part.text:
                                    print(part.text, end="", flush=True)
                                    # Forward Gemini text back to ESP32 over WebSocket
                                    await websocket.send(part.text)
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"\n[Gemini Receive Error]: {e}")

            async def send_to_gemini():
                """Listen for incoming text messages from ESP32 and forward to Gemini."""
                try:
                    async for message in websocket:
                        if isinstance(message, str):
                            print(f"\n[ESP32 Prompt]: {message}")
                            # Send text prompt over the active Live API session
                            await session.send(input=message, end_of_turn=True)
                        elif isinstance(message, bytes):
                            # Reserved for future PCM audio streaming
                            await session.send(
                                input={
                                    "data": message,
                                    "mime_type": "audio/pcm",
                                },
                                end_of_turn=False,
                            )
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    print(f"\n[ESP32 Send Error]: {e}")

            # Run receive and send tasks concurrently
            await asyncio.gather(receive_from_gemini(), send_to_gemini())

    except websockets.exceptions.ConnectionClosed:
        print("[Render Bridge] ESP32 Connection closed.")
    except Exception as e:
        print(f"[Render Bridge Error]: {e}")


async def main():
    # Bind server to 0.0.0.0 and port assigned by Render
    async with websockets.serve(
        handle_esp32, "0.0.0.0", PORT, process_request=handle_request
    ):
        print(f"Gemini Live Bridge running on port {PORT}...")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
