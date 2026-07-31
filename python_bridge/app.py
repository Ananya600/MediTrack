import os
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from google import genai

app = FastAPI()

# Retrieve API key from Render Environment Variables
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

if not GEMINI_API_KEY:
    print("WARNING: GEMINI_API_KEY environment variable is not set!")

client = genai.Client(api_key=GEMINI_API_KEY)

class TextPrompt(BaseModel):
    prompt: str

@app.get("/")
def home():
    """Health check endpoint for UptimeRobot to ping."""
    return {"status": "ok", "message": "Gemini ESP32 Bridge is running!"}

@app.post("/")
@app.post("/generate")
def generate_text(data: TextPrompt):
    """Generates a text response from Gemini 2.0 Flash."""
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail="API Key not configured on server")
    
    try:
        response = client.models.generate_content(
            model='gemini-2.0-flash',
            contents=data.prompt,
        )
        return {"response": response.text}
    except Exception as e:
        print(f"Error processing text prompt: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    uvicorn.run(app, host="0.0.0.0", port=port)
