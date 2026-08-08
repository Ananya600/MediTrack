#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Stepper.h>
#include <ESP32Servo.h>
#include <WiFiManager.h>  // https://github.com/tzapu/WiFiManager
#include <Preferences.h>  // ESP32 Non-Volatile Flash Storage
#include <time.h>         // Built-in ESP32 Time Library

// ================= CONFIGURATION & CONSTANTS =================
// Live Cloud Server URL
const char* SERVER_BASE_URL = "https://meditrack-6m2m.onrender.com"; 

// Window Thresholds
const int DISPENSE_WINDOW_MINUTES = 30; // Active window set to 30 mins

// Hardware Pins
const int StepsPerRevolution = 2048;
static const int SERVO_PIN   = 13;
static const int IR_PIN      = 27;

#define IN1 19
#define IN2 18
#define IN3 5
#define IN4 17

// ================= GLOBALS & STORAGE =================
Stepper myStepper(StepsPerRevolution, IN1, IN3, IN2, IN4);
Servo myServo;
Preferences preferences; // Flash memory manager

char deviceApiKey[64] = ""; // Storage buffer for user's API key

// Direct 1-to-1 Mapping (Index 0 is unused/home)
// Index 1 (Compartment 1 / A1) = 0 deg
// Index 2 (Compartment 2 / A2) = 45 deg
// Index 3 (Compartment 3 / A3) = 90 deg
// Index 4 (Compartment 4 / A4) = 135 deg
// Index 5 (Compartment 5 / B1) = 180 deg
// Index 6 (Compartment 6 / B2) = -135 deg
// Index 7 (Compartment 7 / B3) = -90 deg
// Index 8 (Compartment 8 / B4) = -45 deg
const int degreeOfRotation[9] = {0, 0, 45, 90, 135, 180, -135, -90, -45};

unsigned long lastPollTime = 0;
const unsigned long POLL_INTERVAL = 15000; // Poll every 15s

bool shouldSaveConfig = false;

void saveConfigCallback() {
  Serial.println("Should save config triggered");
  shouldSaveConfig = true;
}

// ================= TIME UTILITIES =================

void syncTimeIST() {
  // Configures timezone to IST (+05:30)
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

// Converts HH:MM string to total minutes from midnight (0 to 1439)
int timeStringToMinutes(String timeStr) {
  int colonIndex = timeStr.indexOf(':');
  if (colonIndex == -1) return -1;
  int hours = timeStr.substring(0, colonIndex).toInt();
  int minutes = timeStr.substring(colonIndex + 1).toInt();
  return (hours * 60) + minutes;
}

// Returns current local time in total minutes from midnight
int getCurrentTimeInMinutes() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    return -1;
  }
  return (timeinfo.tm_hour * 60) + timeinfo.tm_min;
}

// ================= SETUP & PROVISIONING =================

void setupWiFiAndPortal() {
  preferences.begin("meditrack", false);
  preferences.clear();
  String savedKey = preferences.getString("apiKey", "");
  savedKey.toCharArray(deviceApiKey, 64);

  WiFiManager wm;
  wm.setSaveConfigCallback(saveConfigCallback);
  wm.resetSettings();

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

// ================= HARDWARE & BACKEND LOGIC =================

// Returns 1-based index (1 to 8)
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
  return 0; // Return 0 if invalid
}

void releaseMotor() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}

void logDoseToBackend(String scheduleId, bool missed = false) {
  if (WiFi.status() != WL_CONNECTED || strlen(deviceApiKey) == 0 || scheduleId.length() == 0) return;

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(60);

  HTTPClient http;
  
  String actionEndpoint = missed ? "/missed" : "/taken";
  String url = String(SERVER_BASE_URL) + "/api/doses/" + scheduleId + actionEndpoint;
  Serial.printf("POSTing status [%s] to: %s\n", missed ? "MISSED" : "TAKEN", url.c_str());

  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", deviceApiKey);
  http.setTimeout(60000);

  int httpCode = http.POST("{}");
  if (httpCode > 0) {
    Serial.printf("Logged dose status to server (HTTP %d)\n", httpCode);
  } else {
    Serial.printf("HTTP POST Error: %s\n", http.errorToString(httpCode).c_str());
  }
  http.end();
}

void executeDispenseCycle(int compartmentNum, String scheduleId) {
  // Directly index into array using 1-based compartmentNum (1..8)
  int degree = degreeOfRotation[compartmentNum];
  int steps = (degree * StepsPerRevolution) / 360;

  Serial.printf("Rotating stepper to compartment %d (%d degrees)...\n", compartmentNum, degree);
  myStepper.step(steps);
  delay(1000);

  myServo.write(90);
  Serial.println("Servo opened, waiting for hand...");

  while (digitalRead(IR_PIN) == HIGH) {
    delay(50);
  }

  delay(300);
  if (digitalRead(IR_PIN) == LOW) {
    Serial.println("Hand detected, closing servo...");
    delay(5000);
    myServo.write(0);
    delay(1000);
  }

  myStepper.step(-steps);
  delay(1000);
  releaseMotor();

  logDoseToBackend(scheduleId, false);
}

void pollPendingDoses() {
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
  http.setTimeout(60000);

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
          
          String scheduleId = "";
          if (item.containsKey("scheduleId")) {
            scheduleId = item["scheduleId"].as<String>();
          } else if (item.containsKey("_id")) {
            scheduleId = item["_id"].as<String>();
          }

          int compartmentNum = parseCompartment(compStr);
          int timeDiff = currentMin - scheduledMin;

          // WINDOW 1: Valid Dispense Window (0 to 30 mins)
          if (timeDiff >= 0 && timeDiff <= DISPENSE_WINDOW_MINUTES) {
            if (compartmentNum >= 1 && compartmentNum <= 8 && scheduleId.length() > 0) {
              Serial.printf("Within %d-min window! Scheduled: %s, Current Mins: %d, Dispensing ID: %s\n", 
                            DISPENSE_WINDOW_MINUTES, scheduleTimeStr.c_str(), currentMin, scheduleId.c_str());
              executeDispenseCycle(compartmentNum, scheduleId);
              break; 
            }
          } 
          // WINDOW 2: Missed Dose Window (> 30 mins late)
          else if (timeDiff > DISPENSE_WINDOW_MINUTES) {
            Serial.printf("Dose missed (>%d mins past schedule: %s). Marking missed on backend...\n", 
                          DISPENSE_WINDOW_MINUTES, scheduleTimeStr.c_str());
            logDoseToBackend(scheduleId, true);
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
}

// ================= ARDUINO MAIN =================

void setup() {
  Serial.begin(115200);

  myStepper.setSpeed(10);
  myServo.attach(SERVO_PIN);
  myServo.write(0);
  pinMode(IR_PIN, INPUT);

  setupWiFiAndPortal();
}

void loop() {
  if (millis() - lastPollTime >= POLL_INTERVAL) {
    lastPollTime = millis();
    pollPendingDoses();
  }
}
