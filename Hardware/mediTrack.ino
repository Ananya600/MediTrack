#include <Stepper.h>
#include <ESP32Servo.h>

const int StepsPerRevolution = 2048;
static const int servoPin = 13;
static const int irSensorPin = 27;   // IR sensor digital output pin

#define IN1 19
#define IN2 18
#define IN3 5
#define IN4 17

Stepper myStepper(StepsPerRevolution, IN1, IN3, IN2, IN4);
Servo myServo;
const int degreeOfRotation[8] = {0, 45, 90, 135, 180, -135, -90, -45};

void setup() {
  myStepper.setSpeed(10);
  Serial.begin(115200);
  myServo.attach(servoPin);
  pinMode(irSensorPin, INPUT);
}

void loop() {
  rotateStepper();
  delay(5000);
}

void rotateStepper(){
  if (Serial.available() > 0){
    int compartment = Serial.parseInt();

    // flush leftover newline characters
    while (Serial.available() > 0) {
      Serial.read();
    }

    if (compartment >= 1 && compartment <= 8) {
      int degree = degreeOfRotation[compartment - 1];
      int steps = (degree * StepsPerRevolution) / 360;

      myStepper.step(steps);
      delay(1000);

      // open servo
      myServo.write(90);
      Serial.println("Servo opened, waiting for hand...");

      // wait for IR sensor trigger
      while (digitalRead(irSensorPin) == HIGH) {
        delay(50);
      }

      delay(300); // debounce
      if (digitalRead(irSensorPin) == LOW) {
        Serial.println("Hand detected, closing servo.");
        myServo.write(0);   // close
        delay(1000);
      }

      myStepper.step(-steps);
      delay(1000);
      releaseMotor();
    }
  }
}


void releaseMotor() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}
