/*
  MediTrack ESP32 example
  ------------------------
  Minimal starting point for the pillbox firmware. It does three things:

    1. Connects to WiFi.
    2. Fetches the full schedule once at boot (GET /api/device/schedule)
       and again periodically, so the device keeps working even through a
       brief WiFi drop — it isn't polling the server before every decision.
    3. Reports a dose as taken (POST /api/device/doses/:id/taken) once
       your dispensing logic (stepper + servo) has actually run.

  What this sketch does NOT do (left for you to add):
    - Reading the ESP32's RTC and matching it against each schedule row's
      "time" and "days" to know when to actually dispense — that's the
      state machine that would call dispenseDose() below.
    - Compartment rotation / servo release itself.
    - The I2S mic / Gemini voice assistant piece.

  Libraries needed (install via Arduino Library Manager):
    - WiFi.h            (bundled with the ESP32 board package)
    - HTTPClient.h       (bundled with the ESP32 board package)
    - ArduinoJson         (search "ArduinoJson" by Benoit Blanchon, v6.x)
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ---- fill these in ----
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_HOST   = "http://192.168.1.50:4000"; // your backend's LAN IP + port
const char* DEVICE_KEY    = "PASTE_THE_DEVICE_API_KEY_FROM_SEED_OUTPUT_HERE";

// How often to re-fetch the schedule from the server (milliseconds).
// Doesn't need to be frequent — the device runs off its local copy
// between refreshes.
const unsigned long SCHEDULE_REFRESH_MS = 15UL * 60UL * 1000UL; // 15 minutes

// ---- in-memory schedule copy ----
struct DoseEntry {
  int scheduleId;
  String medicineName;
  String compartment;
  String time;      // "HH:MM"
  String dosage;
  int pillsLeft;
  int threshold;
  // days: for simplicity this example only stores whether it's "daily";
  // extending to custom weekday arrays just means storing a small bool[7]
  // per entry and checking it the same way the backend does.
  bool daily;
};

const int MAX_DOSES = 16;
DoseEntry schedule[MAX_DOSES];
int scheduleCount = 0;
unsigned long lastScheduleFetch = 0;

void connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected, IP: ");
  Serial.println(WiFi.localIP());
}

// Confirms the server is reachable and the device key is valid.
// Call this once at boot before trusting anything else.
bool pingServer() {
  HTTPClient http;
  http.begin(String(SERVER_HOST) + "/api/device/ping");
  http.addHeader("x-device-key", DEVICE_KEY);
  int code = http.GET();

  bool ok = (code == 200);
  Serial.printf("Ping -> HTTP %d\n", code);
  if (ok) Serial.println(http.getString());
  http.end();
  return ok;
}

// Fetches /api/device/schedule and fills the local `schedule` array.
bool fetchSchedule() {
  HTTPClient http;
  http.begin(String(SERVER_HOST) + "/api/device/schedule");
  http.addHeader("x-device-key", DEVICE_KEY);
  int code = http.GET();

  if (code != 200) {
    Serial.printf("Schedule fetch failed, HTTP %d\n", code);
    http.end();
    return false;
  }

  String body = http.getString();
  http.end();

  // Size this generously — ArduinoJson needs to know the buffer size up
  // front. 4096 bytes comfortably covers a dozen or so schedule entries;
  // bump it up if you add many more medicines.
  DynamicJsonDocument doc(4096);
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.print("JSON parse failed: ");
    Serial.println(err.c_str());
    return false;
  }

  JsonArray arr = doc.as<JsonArray>();
  scheduleCount = 0;
  for (JsonObject row : arr) {
    if (scheduleCount >= MAX_DOSES) break;
    DoseEntry& e = schedule[scheduleCount];
    e.scheduleId    = row["scheduleId"].as<int>();
    e.medicineName  = row["medicineName"].as<String>();
    e.compartment   = row["compartment"].as<String>();
    e.time          = row["time"].as<String>();
    e.dosage        = row["dosage"].as<String>();
    e.pillsLeft     = row["pillsLeft"].as<int>();
    e.threshold     = row["threshold"].as<int>();

    // days is either the string "daily" or a JSON array like [1,3,5].
    // ArduinoJson lets you check the type directly:
    e.daily = row["days"].is<const char*>(); // true when it's "daily"

    scheduleCount++;
  }

  Serial.printf("Loaded %d schedule entries\n", scheduleCount);
  return true;
}

// Call this once your hardware has actually dispensed a dose.
bool reportTaken(int scheduleId) {
  HTTPClient http;
  String url = String(SERVER_HOST) + "/api/device/doses/" + String(scheduleId) + "/taken";
  http.begin(url);
  http.addHeader("x-device-key", DEVICE_KEY);
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(""); // no body needed
  Serial.printf("Report taken (schedule %d) -> HTTP %d\n", scheduleId, code);
  if (code == 200) Serial.println(http.getString());
  http.end();
  return code == 200;
}

// Placeholder for the actual hardware action: rotate to the compartment,
// run the servo/stepper to release one dose, then confirm to the server.
void dispenseDose(const DoseEntry& e) {
  Serial.printf("Dispensing %s (%s) from compartment %s\n",
                e.medicineName.c_str(), e.dosage.c_str(), e.compartment.c_str());

  // TODO: rotate carousel to e.compartment, actuate servo, verify release.

  reportTaken(e.scheduleId);
}

void setup() {
  Serial.begin(115200);
  connectWiFi();

  if (pingServer()) {
    fetchSchedule();
    lastScheduleFetch = millis();
  }
}

void loop() {
  // Refresh the schedule periodically so new/edited medicines show up
  // without needing a reboot.
  if (millis() - lastScheduleFetch > SCHEDULE_REFRESH_MS) {
    fetchSchedule();
    lastScheduleFetch = millis();
  }

  // TODO: read RTC, compare against each schedule[i].time (+ .daily / your
  // weekday check), and call dispenseDose(schedule[i]) at the right
  // moment. This is the piece specific to your RTC/stepper/servo setup,
  // left out of this example on purpose.

  delay(1000);
}
