import asyncio
import http
import os
import websockets
from google import genai

# 1. Initialize Gemini Client
# Reads GEMINI_API_KEY directly from environment variables
api_key = os.environ.get("GEMINI_API_KEY")
if not api_key:
    print("WARNING: GEMINI_API_KEY environment variable is not set!")

client = genai.Client()

# 2. WebSocket handler with Gemini integration
async def chat_handler(websocket):
    print(f"Client connected from {websocket.remote_address}")
    try:
        async for message in websocket:
            print(f"Received user prompt: {message}")
            
            try:
                # Send the incoming message to Gemini
                # (Running in an executor so it doesn't block the asyncio event loop)
                loop = asyncio.get_running_loop()
                response = await loop.run_in_executor(
                    None,
                    lambda: client.models.generate_content(
                        model="gemini-2.5-flash",
                        contents=message
                    )
                )
                
                # Send Gemini's response back to the WebSocket client
                await websocket.send(response.text)
                
            except Exception as e:
                print(f"Gemini API Error: {e}")
                await websocket.send(f"Error processing prompt: {str(e)}")

    except websockets.exceptions.ConnectionClosedOK:
        print("Client disconnected cleanly")
    except websockets.exceptions.ConnectionClosedError as e:
        print(f"Client disconnected with error: {e}")

# 3. Intercept HTTP requests (like HEAD/GET from Render health checks)
async def process_request(connection, request):
    if request.method == "HEAD" or (request.method == "GET" and request.path in ["/", "/health", "/healthz"]):
        return connection.respond(
            http.HTTPStatus.OK,
            "OK\n",
            headers={"Content-Type": "text/plain"}
        )
    return None

# 4. Main server entrypoint
async def main():
    port = int(os.environ.get("PORT", 8765))
    host = "0.0.0.0"

    print(f"Starting Gemini WebSocket server on {host}:{port}...")

    async with websockets.serve(
        chat_handler,
        host,
        port,
        process_request=process_request
    ):
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServer stopped.")
