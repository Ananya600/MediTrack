#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Stepper.h>
#include <ESP32Servo.h>
#include <WiFiManager.h>  // https://github.com/tzapu/WiFiManager
#include <Preferences.h>  // ESP32 Non-Volatile Flash Storage
#include <time.h>         // Built-in ESP32 Time Library
#include <Audio.h>        // ESP32-audioI2S by schreibfaul1
#include <LittleFS.h>     
#include <set>

// ================= CONFIGURATION & CONSTANTS =================
const char* SERVER_BASE_URL = "https://meditrack-6m2m.onrender.com"; 

const int DISPENSE_WINDOW_MINUTES = 30; // Active window set to 30 mins

// Hardware Pins
const int StepsPerRevolution = 2048;
static const int SERVO_PIN   = 13;
static const int IR_PIN      = 27;

#define IN1 19
#define IN2 18
#define IN3 5
#define IN4 17

// I2S pins for TTS audio
#define I2S_DOUT 32
#define I2S_BCLK 33
#define I2S_LRC  25

const int TTS_CHUNK_LIMIT = 180;

// ================= GLOBALS & STORAGE =================
Stepper myStepper(StepsPerRevolution, IN1, IN3, IN2, IN4);
Servo myServo;
Preferences preferences; 
Audio audio;             

char deviceApiKey[64] = ""; 

const int degreeOfRotation[9] = {0, 0, 45, 90, 135, 180, -135, -90, -45};

unsigned long lastPollTime = 0;
const unsigned long POLL_INTERVAL = 15000; 

bool shouldSaveConfig = false;

std::set<String> dispensedIds;
String lastResetDate = "";

void saveConfigCallback() {
  Serial.println("Should save config triggered");
  shouldSaveConfig = true;
}

// ================= TIME UTILITIES =================

void syncTimeIST() {
  configTzTime("IST-5:30", "pool.ntp.org", "time.nist.gov");
  
  struct tm timeinfo;
  Serial.print("Syncing internal clock with NTP (IST)");
  int attempts = 0;
  while (!getLocalTime(&timeinfo) && attempts < 20) {
    Serial.print(".");
    delay(500);
    attempts++;
  }
  Serial.println();

  if (attempts < 20) {
    Serial.println(&timeinfo, "Time synchronized successfully! Current IST: %H:%M:%S");
  } else {
    Serial.println("Failed to obtain NTP time.");
  }
}

int timeStringToMinutes(String timeStr) {
  int colonIndex = timeStr.indexOf(':');
  if (colonIndex == -1) return -1;
  int hours = timeStr.substring(0, colonIndex).toInt();
  int minutes = timeStr.substring(colonIndex + 1).toInt();
  return (hours * 60) + minutes;
}

int getCurrentTimeInMinutes() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    return -1;
  }
  return (timeinfo.tm_hour * 60) + timeinfo.tm_min;
}

String formatMinutesToClock(int totalMinutes) {
  if (totalMinutes < 0) return "an unknown time";
  int hours24 = (totalMinutes / 60) % 24;
  int minutes = totalMinutes % 60;
  String ampm = (hours24 >= 12) ? "PM" : "AM";
  int hours12 = hours24 % 12;
  if (hours12 == 0) hours12 = 12;

  char buf[16];
  snprintf(buf, sizeof(buf), "%d:%02d %s", hours12, minutes, ampm.c_str());
  return String(buf);
}

// ================= SETUP & PROVISIONING =================

void setupWiFiAndPortal() {
  preferences.begin("meditrack", false);
  String savedKey = preferences.getString("apiKey", "");
  savedKey.toCharArray(deviceApiKey, 64);

  WiFiManager wm;
  wm.setSaveConfigCallback(saveConfigCallback);

  WiFiManagerParameter customApiKey("api_key", "MediTrack Device API Key", deviceApiKey, 64);
  wm.addParameter(&customApiKey);

  wm.setConfigPortalTimeout(180);

  Serial.println("Starting Wi-Fi / Provisioning Portal...");

  if (!wm.autoConnect("MediTrack-Setup")) {
    Serial.println("Failed to connect or hit portal timeout. Restarting...");
    delay(3000);
    ESP.restart();
  }

  if (shouldSaveConfig) {
    strcpy(deviceApiKey, customApiKey.getValue());
    preferences.putString("apiKey", deviceApiKey);
    Serial.println("New API Key saved to Flash Memory!");
  }

  preferences.end();

  Serial.println("\nSuccessfully Connected to Wi-Fi!");
  Serial.print("Local IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("Active Device API Key: ");
  Serial.println(deviceApiKey);

  syncTimeIST();
}

// ================= TEXT-TO-SPEECH (I2S + Google Translate TTS) =================

void waitForAudioToFinish() {
  unsigned long started = millis();
  while (millis() - started < 300) { 
    audio.loop(); 
    yield();
    delay(1); 
  }
  unsigned long ttsStart = millis();
  while (audio.isRunning()) {
    audio.loop();
    yield();
    delay(1);
    if (millis() - ttsStart > 20000) { 
      Serial.println("TTS timeout — aborting audio, continuing dispense");
      audio.stopSong();
      break;
    }
  }
  audio.stopSong();
}

bool fetchTTSToFile(String text, const char* path) {
  text.trim();
  if (text.length() == 0) return false;

  String encoded = "";
  char buf[4];
  for (size_t i = 0; i < text.length(); i++) {
    char c = text.charAt(i);
    if (isalnum((unsigned char)c)) {
      encoded += c;
    } else if (c == ' ') {
      encoded += "%20";
    } else {
      snprintf(buf, sizeof(buf), "%%%02X", (unsigned char)c);
      encoded += buf;
    }
  }

  String url = "https://translate.google.com/translate_tts?ie=UTF-8&q=" + encoded + "&tl=en&client=tw-ob";

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(60);

  HTTPClient http;
  http.begin(client, url);
  http.addHeader("User-Agent", "Mozilla/5.0");
  http.setTimeout(60000);

  int httpCode = http.GET();
  Serial.printf("TTS fetch HTTP code: %d, content-length: %d\n", httpCode, http.getSize());

  if (httpCode != HTTP_CODE_OK) {
    Serial.printf("TTS fetch failed, HTTP %d\n", httpCode);
    http.end();
    client.stop();
    return false;
  }

  if (LittleFS.exists(path)) LittleFS.remove(path);
  File f = LittleFS.open(path, "w");
  if (!f) {
    Serial.println("Failed to open file for writing");
    http.end();
    client.stop();
    return false;
  }

  size_t totalWritten = http.writeToStream(&f);

  f.close();
  http.end();
  client.stop();   

  Serial.printf("TTS file written: %u bytes\n", (unsigned)totalWritten);
  return totalWritten > 500;
}

void speakText(String text) {
  text.trim();
  if (text.length() == 0) return;

  Serial.print("Speaking: ");
  Serial.println(text);

  int start = 0;
  while (start < (int)text.length()) {
    int remaining = text.length() - start;
    int chunkLen = min(remaining, TTS_CHUNK_LIMIT);
    int end = start + chunkLen;

    if (end < (int)text.length()) {
      int lastSpace = text.lastIndexOf(' ', end);
      if (lastSpace > start) end = lastSpace;
    }

    String chunk = text.substring(start, end);
    chunk.trim();

    if (chunk.length() > 0) {
      const char* path = "/tts_chunk.mp3";
      if (fetchTTSToFile(chunk, path)) {
        audio.connecttoFS(LittleFS, path); 
        waitForAudioToFinish();
      } else {
        Serial.println("TTS chunk fetch failed, skipping.");
      }
    }
    start = end;
  }
}

String getNextDoseTimeAnnouncement(JsonArray doses, int afterMinutes, String excludeScheduleId) {
  int bestMin = -1;

  for (JsonObject item : doses) {
    bool isTaken = item["taken"] | false;
    if (isTaken) continue;

    String sid = "";
    if (item.containsKey("scheduleId") && !item["scheduleId"].isNull()) {
      sid = item["scheduleId"].as<String>();
    } else if (item.containsKey("_id") && !item["_id"].isNull()) {
      sid = item["_id"].as<String>();
    }
    if (sid.length() > 0 && sid == excludeScheduleId) continue;

    String tStr = item["time"] | "";
    int m = timeStringToMinutes(tStr);
    if (m == -1) continue;

    if (m > afterMinutes && (bestMin == -1 || m < bestMin)) {
      bestMin = m;
    }
  }

  if (bestMin == -1) {
    return "no more medicines scheduled for today";
  }
  return formatMinutesToClock(bestMin);
}

void resetDailyTrackingIfNewDay() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return;
  char dateBuf[11];
  strftime(dateBuf, sizeof(dateBuf), "%Y-%m-%d", &timeinfo);
  String today = String(dateBuf);
  if (today != lastResetDate) {
    dispensedIds.clear();
    lastResetDate = today;
  }
}

// ================= HARDWARE & BACKEND LOGIC =================

int parseCompartment(String label) {
  label.trim();
  label.toUpperCase();

  if (label == "A1") return 1;
  if (label == "A2") return 2;
  if (label == "A3") return 3;
  if (label == "A4") return 4;
  if (label == "B1") return 5;
  if (label == "B2") return 6;
  if (label == "B3") return 7;
  if (label == "B4") return 8;

  int num = label.toInt();
  if (num >= 1 && num <= 8) return num;
  return 0; 
}

void releaseMotor() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}

void logDoseToBackend(String scheduleId) {
  if (WiFi.status() != WL_CONNECTED || strlen(deviceApiKey) == 0 || scheduleId.length() == 0 || scheduleId == "null") {
    Serial.println("Skipping logDoseToBackend due to invalid parameters or lack of WiFi.");
    return;
  }

  for (int attempt = 0; attempt < 3; attempt++) {
    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(60); 

    HTTPClient http;
    String url = String(SERVER_BASE_URL) + "/api/doses/" + scheduleId + "/taken";
    
    http.begin(client, url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-api-key", deviceApiKey);
    http.setTimeout(30000);

    int httpCode = http.POST("{}");
    http.end();
    client.stop();

    if (httpCode > 0) {
      Serial.printf("Logged dose status to server (HTTP %d)\n", httpCode);
      return;  
    }

    Serial.printf("Attempt %d failed (HTTP %d), retrying...\n", attempt + 1, httpCode);
    delay(1000);
  }
  Serial.println("All retries failed to log dose status.");
}

void executeDispenseCycle(int compartmentNum, String scheduleId, String medName, String dosage,
                          String compartmentLabel, int scheduledMin, String nextDoseAnnouncement) {
  int degree = degreeOfRotation[compartmentNum];
  int steps = (degree * StepsPerRevolution) / 360;
  myServo.write(0);

  Serial.printf("Rotating stepper to compartment %d (%d degrees)...\n", compartmentNum, degree);
  myStepper.step(steps);
  delay(1000);

  String currentTimeStr = formatMinutesToClock(getCurrentTimeInMinutes());
  String announcement = medName + " is available at compartment " + compartmentLabel +
                         ". Please take " + dosage + ". " +
                         "The current time is " + currentTimeStr + ", and the next medicine is at " +
                         nextDoseAnnouncement + ".";

  Serial.printf("Free heap before TTS: %d\n", ESP.getFreeHeap());
  speakText(announcement);
  
  Serial.println("TTS done, opening servo now");

  delay(50);
  myServo.write(90);
  Serial.println("Servo opened, waiting for hand...");

  while (digitalRead(IR_PIN) == HIGH) {
    yield();
    delay(50);
  }

  delay(300);
  if (digitalRead(IR_PIN) == LOW) {
    Serial.println("Hand detected, closing servo...");
    delay(5000);
    myServo.write(0);
    delay(5000);
  }

  myStepper.step(-steps);
  delay(1000);
  releaseMotor();

  logDoseToBackend(scheduleId);
}

void pollPendingDoses() {
  resetDailyTrackingIfNewDay();
  if (WiFi.status() != WL_CONNECTED || strlen(deviceApiKey) == 0) return;

  int currentMin = getCurrentTimeInMinutes();
  if (currentMin == -1) {
    Serial.println("System time not set via NTP. Skipping dose check...");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(60);

  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/doses/today";

  http.begin(client, url);
  http.addHeader("x-api-key", deviceApiKey);
  http.setTimeout(30000);

  int httpCode = http.GET();

  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();
    DynamicJsonDocument doc(2048);
    DeserializationError error = deserializeJson(doc, payload);

    if (!error && doc.is<JsonArray>()) {
      JsonArray array = doc.as<JsonArray>();
      for (JsonObject item : array) {
        bool isTaken = item["taken"] | false;
        
        if (!isTaken) {
          String scheduleTimeStr = item["time"] | "";
          int scheduledMin = timeStringToMinutes(scheduleTimeStr);
          if (scheduledMin == -1) continue;

          String compStr = item["compartment"].as<String>();
          String medName = item["medicineName"] | "Your medicine";
          String dosage = item["dosage"] | "1 pill";

          String scheduleId = "";
          if (item.containsKey("scheduleId") && !item["scheduleId"].isNull()) {
            scheduleId = item["scheduleId"].as<String>();
          } else if (item.containsKey("_id") && !item["_id"].isNull()) {
            scheduleId = item["_id"].as<String>();
          }

          if (scheduleId.length() == 0 || scheduleId == "null") {
            Serial.println("Warning: Dose item missing valid scheduleId. Skipping.");
            continue;
          }

          int compartmentNum = parseCompartment(compStr);
          int timeDiff = currentMin - scheduledMin;

          if (timeDiff >= 0 && timeDiff <= DISPENSE_WINDOW_MINUTES) {
            if (compartmentNum >= 1 && compartmentNum <= 8) {
              if (dispensedIds.count(scheduleId)) {
                continue; 
              }
              dispensedIds.insert(scheduleId); 

              Serial.printf("Dispensing compartment %d for scheduleId %s...\n", compartmentNum, scheduleId.c_str());

              String nextDoseAnnouncement = getNextDoseTimeAnnouncement(array, currentMin, scheduleId);

              http.end();
              client.stop();

              executeDispenseCycle(
                compartmentNum, 
                scheduleId, 
                medName, 
                dosage, 
                compStr, 
                scheduledMin, 
                nextDoseAnnouncement
              );

              return; 
            }
          }
        }
      }
    } else {
      Serial.printf("JSON parse error: %s\n", error.c_str());
    }
  } else {
    Serial.printf("HTTP GET request failed. Error code: %d\n", httpCode);
  }
  http.end();
  client.stop();
}

// ================= ARDUINO MAIN =================

void setup() {
  Serial.begin(115200);

  myStepper.setSpeed(10);
  pinMode(IR_PIN, INPUT_PULLUP);

  setupWiFiAndPortal();

  // Initialize I2S Audio FIRST
  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(18);

  // Initialize Servo AFTER Audio setup
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  
  myServo.setPeriodHertz(50);             
  myServo.attach(SERVO_PIN, 1000, 2000);   
  myServo.write(0);

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS Mount Failed. Formatted partition dynamically.");
  } else {
    Serial.println("LittleFS Mounted Successfully.");
  }
  myServo.write(0);
}

void loop() {
  if (millis() - lastPollTime >= POLL_INTERVAL) {
    lastPollTime = millis();
    pollPendingDoses();
  }
  yield();
}
