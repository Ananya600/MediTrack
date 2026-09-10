#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Stepper.h>
#include <ESP32Servo.h>
#include <WiFiManager.h>
#include <Preferences.h>
#include <time.h>
#include <Audio.h>
#include <LittleFS.h>
#include <set>

// ================= CONFIGURATION & CONSTANTS =================
const char* SERVER_BASE_URL = "https://meditrack-6m2m.onrender.com"; 
const int DISPENSE_WINDOW_MINUTES = 30;

// Hardware Pins
const int StepsPerRevolution = 2048;
static const int SERVO_PIN   = 13;
static const int IR_PIN      = 27;

#define IN1 19
#define IN2 18
#define IN3 5
#define IN4 17

#define I2S_DOUT 32
#define I2S_BCLK 33
#define I2S_LRC  25

const int TTS_CHUNK_LIMIT = 180;

// ================= GLOBALS & STORAGE =================
Stepper myStepper(StepsPerRevolution, IN1, IN3, IN2, IN4);
Servo myServo;
Preferences preferences; 

char deviceApiKey[64] = ""; 
const int degreeOfRotation[9] = {0, 0, 45, 90, 135, 180, -135, -90, -45};

unsigned long lastPollTime = 0;
const unsigned long POLL_INTERVAL = 15000; 

unsigned long lastManualPollTime = 0;
const unsigned long MANUAL_POLL_INTERVAL = 3000; // Reduced to 3s for fast UI response

const unsigned long HAND_WAIT_REMINDER_INTERVAL = 20000; 
const unsigned long HAND_WAIT_TIMEOUT           = 180000;

bool shouldSaveConfig = false;
volatile bool g_handDetectedDuringCycle = false;

std::set<String> dispensedIds;
String lastResetDate = "";

bool manualDoorOpen = false;
int manualOpenCompartmentNum = 0;
int manualOpenSteps = 0;

void IRAM_ATTR irSensorISR() {
  g_handDetectedDuringCycle = true;
}

void saveConfigCallback() {
  shouldSaveConfig = true;
}

// ================= NVS PERSISTENCE =================

void loadDispensedIdsFromNVS() {
  preferences.begin("meditrack_doses", true);
  String storedCsv = preferences.getString("dispensed", "");
  lastResetDate = preferences.getString("reset_date", "");
  preferences.end();

  dispensedIds.clear();
  int start = 0;
  int end = storedCsv.indexOf(',');
  while (end != -1) {
    String id = storedCsv.substring(start, end);
    if (id.length() > 0) dispensedIds.insert(id);
    start = end + 1;
    end = storedCsv.indexOf(',', start);
  }
  if (start < (int)storedCsv.length()) {
    String id = storedCsv.substring(start);
    if (id.length() > 0) dispensedIds.insert(id);
  }
}

void saveDispensedIdsToNVS() {
  String csv = "";
  for (const auto& id : dispensedIds) {
    if (csv.length() > 0) csv += ",";
    csv += id;
  }
  preferences.begin("meditrack_doses", false);
  preferences.putString("dispensed", csv);
  preferences.putString("reset_date", lastResetDate);
  preferences.end();
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
    Serial.println(&timeinfo, "Time synchronized! Current IST: %H:%M:%S");
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
  if (!getLocalTime(&timeinfo)) return -1;
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

// ================= PROVISIONING =================

void setupWiFiAndPortal() {
  preferences.begin("meditrack", false);
  String savedKey = preferences.getString("apiKey", "");
  savedKey.toCharArray(deviceApiKey, 64);

  WiFiManager wm;
  wm.setSaveConfigCallback(saveConfigCallback);
  WiFiManagerParameter customApiKey("api_key", "MediTrack Device API Key", deviceApiKey, 64);
  wm.addParameter(&customApiKey);
  wm.setConfigPortalTimeout(180);

  if (!wm.autoConnect("MediTrack-Setup")) {
    Serial.println("Failed to connect or timeout. Restarting...");
    delay(3000);
    ESP.restart();
  }

  if (shouldSaveConfig) {
    strcpy(deviceApiKey, customApiKey.getValue());
    preferences.putString("apiKey", deviceApiKey);
  }
  preferences.end();

  Serial.println("Connected to Wi-Fi!");
  syncTimeIST();
}

// ================= TTS AUDIO WITH TIMEOUT GUARD =================

void waitForAudioToFinish() {
  unsigned long started = millis();
  while (millis() - started < 300) { 
    audio.loop(); 
    yield();
  }
  unsigned long ttsStart = millis();
  while (audio.isRunning()) {
    audio.loop();
    yield();
    if (millis() - ttsStart > 8000) { 
      Serial.println("TTS timeout — skipping audio to avoid hardware hang.");
      audio.stopSong();
      break;
    }
  }
  audio.stopSong();
}

bool fetchTTSToFile(String text, const char* path) {
  text.trim();
  if (text.length() == 0) return false;

  if (LittleFS.exists(path)) LittleFS.remove(path);

  String encoded = "";
  char buf[4];
  for (size_t i = 0; i < text.length(); i++) {
    char c = text.charAt(i);
    if (isalnum((unsigned char)c)) encoded += c;
    else if (c == ' ') encoded += "%20";
    else {
      snprintf(buf, sizeof(buf), "%%%02X", (unsigned char)c);
      encoded += buf;
    }
  }

  String url = "https://translate.google.com/translate_tts?ie=UTF-8&q=" + encoded + "&tl=en&client=tw-ob";

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(5); 

  HTTPClient http;
  http.begin(client, url);
  http.addHeader("User-Agent", "Mozilla/5.0");
  http.setTimeout(5000);

  int httpCode = http.GET();
  if (httpCode != HTTP_CODE_OK) {
    http.end();
    client.stop();
    return false;
  }

  File f = LittleFS.open(path, "w");
  if (!f) {
    http.end();
    client.stop();
    return false;
  }

  int totalWritten = http.writeToStream(&f);
  f.flush();
  f.close();
  http.end();
  client.stop();   

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
        Serial.println("TTS fetch failed, falling back to silent operation.");
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

  if (bestMin == -1) return "no more medicines scheduled for today";
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
    saveDispensedIdsToNVS();
  }
}

// ================= HARDWARE DRIVERS =================

int parseCompartment(String label) {
  label.trim();
  label.toUpperCase();
  if (label == "A1" || label == "A") return 1;
  if (label == "A2" || label == "B") return 2;
  if (label == "A3" || label == "C") return 3;
  if (label == "A4" || label == "D") return 4;
  if (label == "A5") return 5;
  if (label == "A6") return 6;
  if (label == "A7") return 7;
  if (label == "A8") return 8;

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
  if (WiFi.status() != WL_CONNECTED || strlen(deviceApiKey) == 0 || scheduleId.length() == 0 || scheduleId == "null") return;

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(10); 

  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/doses/" + scheduleId + "/taken";
  
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", deviceApiKey);
  http.setTimeout(10000);

  int httpCode = http.POST("{}");
  http.end();
  client.stop();
  Serial.printf("Logged dose status to server (HTTP %d)\n", httpCode);
}

// ================= COMPARTMENT LOCK HELPERS =================

bool requestAutoOpen(String compartmentLabel) {
  if (WiFi.status() != WL_CONNECTED || strlen(deviceApiKey) == 0) return false;
  Serial.printf("[HEAP] before auto-open: %d free, %d max alloc\n",
              ESP.getFreeHeap(), ESP.getMaxAllocHeap());

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(10);

  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/compartments/" + compartmentLabel + "/auto-open";
  http.begin(client, url);
  http.addHeader("x-api-key", deviceApiKey);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);

  int httpCode = http.POST("{}");
  if (httpCode != 200) {
    String body = http.getString();
    Serial.printf("auto-open rejected (HTTP %d): %s\n", httpCode, body.c_str());
  }
  http.end();
  client.stop();

  return httpCode == 200;
}

void ackManualCommand(long commandId, bool success) {
  if (WiFi.status() != WL_CONNECTED || strlen(deviceApiKey) == 0) return;

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(10);

  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/compartments/commands/" + String(commandId) + "/ack";
  http.begin(client, url);
  http.addHeader("x-api-key", deviceApiKey);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);

  String body = String("{\"success\":") + (success ? "true" : "false") + "}";
  http.POST(body);
  http.end();
  client.stop();
}

bool requestAutoClose(String compartmentLabel) {
  if (WiFi.status() != WL_CONNECTED || strlen(deviceApiKey) == 0) return false;

  for (int attempt = 0; attempt < 3; attempt++) {
    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(10);

    HTTPClient http;
    String url = String(SERVER_BASE_URL) + "/api/compartments/" + compartmentLabel + "/auto-close";
    http.begin(client, url);
    http.addHeader("x-api-key", deviceApiKey);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(10000);

    int httpCode = http.POST("{}");
    http.end();
    client.stop();

    if (httpCode == 200) return true;

    Serial.printf("auto-close failed (attempt %d, HTTP %d), retrying...\n", attempt + 1, httpCode);
    delay(1000);
  }
  Serial.println("auto-close FAILED after retries — door_status may be stuck until server auto-expire.");
  return false;
}


void checkManualCommands() {
  if (WiFi.status() != WL_CONNECTED || strlen(deviceApiKey) == 0) return;

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(10);

  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/compartments/pending-command";
  http.begin(client, url);
  http.addHeader("x-api-key", deviceApiKey);
  http.setTimeout(10000);

  int httpCode = http.GET();
  if (httpCode != HTTP_CODE_OK) {
    http.end();
    client.stop();
    return;
  }

  String payload = http.getString();
  http.end();
  client.stop();

  DynamicJsonDocument doc(512);
  DeserializationError error = deserializeJson(doc, payload);
  if (error || doc.isNull()) return; 

  long commandId = doc["id"] | -1;
  String action = doc["action"] | "";
  String compartmentLabel = doc["compartment"] | "";
  if (commandId == -1 || action.length() == 0 || compartmentLabel.length() == 0) return;

  int num = parseCompartment(compartmentLabel);
  if (num < 1 || num > 8) {
    ackManualCommand(commandId, false); // Fail gracefully on invalid input
    return;
  }

  if (action == "open") {
    if (manualDoorOpen) {
      ackManualCommand(commandId, false); // Guard against double open
      return;
    }

    int degree = degreeOfRotation[num];
    int steps = (degree * StepsPerRevolution) / 360;

    Serial.printf("[MANUAL OPEN] Rotating to compartment %d...\n", num);
    myStepper.step(steps);
    releaseMotor();
    delay(300);
    myServo.write(180);

    manualDoorOpen = true;
    manualOpenCompartmentNum = num;
    manualOpenSteps = steps;

    ackManualCommand(commandId, true);

  } else if (action == "close") {
    Serial.println("[MANUAL CLOSE] Closing door and returning home...");
    myServo.write(0);
    delay(1000);

    if (manualDoorOpen && manualOpenSteps != 0) {
      myStepper.step(-manualOpenSteps);
      releaseMotor();
    }

    manualDoorOpen = false;
    manualOpenCompartmentNum = 0;
    manualOpenSteps = 0;

    delay(1000);
    lastPollTime = millis();

    ackManualCommand(commandId, true);
  } else {
    ackManualCommand(commandId, false);
  }
}

void executeDispenseCycle(int compartmentNum, String scheduleId, String medName, String dosage,
                          String compartmentLabel, int scheduledMin, String nextDoseAnnouncement) {
  
  int degree = degreeOfRotation[compartmentNum];
  int steps = (degree * StepsPerRevolution) / 360;

  Serial.println("[CYCLE START] Moving motor first...");
  myServo.write(0);

  // 1. Move stepper to compartment position
  Serial.printf("Rotating stepper to compartment %d (%d steps)...\n", compartmentNum, steps);
  myStepper.step(steps);
  releaseMotor(); 
  delay(300);

  // 2. Audio announcement
  String announcement = medName + " is available at compartment " + compartmentLabel +
                        ". Please take " + dosage + ".";
  //speakText(announcement);

  // 3. Open door
  Serial.println("Opening servo door...");
  myServo.write(180);
  delay(1000); 

  g_handDetectedDuringCycle = false; 
  Serial.println("Waiting for hand detection...");

  unsigned long waitStart = millis();
  unsigned long lastReminder = millis();
  bool handConfirmed = false;

  while (millis() - waitStart < HAND_WAIT_TIMEOUT) {
    yield();

    if (g_handDetectedDuringCycle || digitalRead(IR_PIN) == LOW) {
      unsigned long detectStart = millis();
      bool steadyHand = true;
      while (millis() - detectStart < 300) {
        if (digitalRead(IR_PIN) == HIGH) {
          steadyHand = false;
          break;
        }
        delay(10);
      }

      if (steadyHand) {
        handConfirmed = true;
        Serial.println("Hand confirmed in compartment!");
        break;
      } else {
        g_handDetectedDuringCycle = false;
      }
    }

    if (millis() - lastReminder >= HAND_WAIT_REMINDER_INTERVAL) {
      lastReminder = millis();
      //speakText("Still waiting. Please reach into compartment " + compartmentLabel + ".");
      g_handDetectedDuringCycle = false; 
    }

    delay(30);
  }

  // 4. Close door physically
  if (handConfirmed) {
    //speakText("Got it. Closing compartment.");
    delay(1000); 
    myServo.write(0);
    delay(1000);
  } else {
    Serial.println("Timed out waiting for hand.");
    myServo.write(0);
    delay(1000);
    //speakText("No hand detected. Door closed.");
  }

  // 5. Return stepper motor to HOME position
  Serial.println("Returning stepper to home position...");
  myStepper.step(-steps);
  releaseMotor(); 
  delay(500);

  // 6. Report dose status to backend
  if (handConfirmed) {
    logDoseToBackend(scheduleId);
  }

  // 7. ALWAYS release the door lock on the server
  requestAutoClose(compartmentLabel);

  // 8. Reset poll timer so next poll occurs after full interval
  lastPollTime = millis();

  Serial.println("[CYCLE COMPLETE]");
}

void pollPendingDoses() {
  resetDailyTrackingIfNewDay();
  if (WiFi.status() != WL_CONNECTED || strlen(deviceApiKey) == 0 || manualDoorOpen) return;

  int currentMin = getCurrentTimeInMinutes();
  if (currentMin == -1) {
    Serial.println("System time not synced via NTP.");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(10);

  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/doses/today";

  http.begin(client, url);
  http.addHeader("x-api-key", deviceApiKey);
  http.setTimeout(10000);

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

          if (scheduleId.length() == 0 || scheduleId == "null") continue;

          int compartmentNum = parseCompartment(compStr);
          int timeDiff = currentMin - scheduledMin;

          if (timeDiff >= 0 && timeDiff <= DISPENSE_WINDOW_MINUTES) {
            if (compartmentNum >= 1 && compartmentNum <= 8) {
              if (dispensedIds.count(scheduleId)) continue; 

              Serial.printf("\n>>> Match found! Target compartment: %d (%s)\n", compartmentNum, compStr.c_str());

              if (!requestAutoOpen(compStr)) {
                Serial.println("Door is busy — will retry this dose next poll.");
                http.end();
                client.stop();
                return;
              }

              dispensedIds.insert(scheduleId); 
              saveDispensedIdsToNVS();

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
    }
  } else {
    Serial.printf("HTTP GET Failed: %d\n", httpCode);
  }
  http.end();
  client.stop();
}

// ================= ARDUINO MAIN =================

void setup() {
  Serial.begin(115200);
  delay(1000);
  
  preferences.begin("meditrack_doses", false);
  preferences.clear();
  preferences.end();

  myStepper.setSpeed(10);
  releaseMotor();

  pinMode(IR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(IR_PIN), irSensorISR, FALLING);

  setupWiFiAndPortal();
  loadDispensedIdsFromNVS();

  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(18);

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  
  myServo.setPeriodHertz(50);             
  myServo.attach(SERVO_PIN, 1000, 2000);   
  myServo.write(0);

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS Mount Failed.");
  } else {
    Serial.println("LittleFS Mounted.");
  }
  
  Serial.println("Ready. Polling server...");
}

void loop() {
  if (millis() - lastPollTime >= POLL_INTERVAL) {
    lastPollTime = millis();
    pollPendingDoses();
  }
  if (millis() - lastManualPollTime >= MANUAL_POLL_INTERVAL) {
    lastManualPollTime = millis();
    checkManualCommands();
  }
  yield();
}
