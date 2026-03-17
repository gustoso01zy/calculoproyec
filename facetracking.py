import cv2
import requests
import numpy as np
import time

# ESP32 IP Address
ESP32_IP = "http://192.168.4.1"

# Camera setup
cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
ws, hs = 640, 480
cap.set(3, ws)
cap.set(4, hs)

if not cap.isOpened():
    print("Camera couldn't Access!!!")
    exit()

print("Loading Haar Cascade...")
face_cascade = cv2.CascadeClassifier('haarcascade_frontalface_default.xml')

# Servo configuration
servoPos = [90, 90]  # Current servo position
targetPos = [90, 90]  # Target position (from face detection)

# Smoothing parameters
smoothing_factor = 0.1  # Lower = smoother but slower response
movement_threshold = 0  # Only move if change > this value (degrees) — set to 0 to keep servos updated even when the face is still

# Rate limiting
last_servo_update = 0
servo_update_interval = 0.05  # Send commands every 50ms (20 times per second)

# Connection status
connected = False
last_successful_contact = 0

# Smoothing buffer (moving average)
smoothing_buffer_size = 5
smoothingX = []
smoothingY = []

def send_servo_command(x, y):
    """Send servo position to ESP32 with retry logic"""
    global connected, last_successful_contact
    
    try:
        # Try up to 3 retries
        for attempt in range(3):
            # Send as JSON for more reliable parsing
            response = requests.post(
                f'{ESP32_IP}/api/servo',
                json={'x': int(x), 'y': int(y)},
                headers={'Content-Type': 'application/json'},
                timeout=0.5
            )
            if response.status_code == 200:
                connected = True
                last_successful_contact = time.time()
                return True
            time.sleep(0.01)  # Small delay between retries
        
        print(f"Error: Server returned {response.status_code}")
        return False
        
    except requests.exceptions.ConnectionError:
        connected = False
        return False
    except Exception as e:
        print(f"Failed to send servo command: {e}")
        return False

def smooth_value(new_value, buffer):
    """Apply moving average smoothing"""
    buffer.append(new_value)
    if len(buffer) > smoothing_buffer_size:
        buffer.pop(0)
    return sum(buffer) / len(buffer)

def apply_smoothing(target_x, target_y):
    """Apply smoothing to target positions"""
    global smoothingX, smoothingY
    
    # Apply moving average
    smoothed_x = smooth_value(target_x, smoothingX)
    smoothed_y = smooth_value(target_y, smoothingY)
    
    return smoothed_x, smoothed_y

# Test connection on startup
print("Testing connection to ESP32...")
for i in range(5):
    try:
        response = requests.get(f'{ESP32_IP}/api/ping', timeout=2)
        if response.status_code == 200:
            print("✓ Connected to ESP32!")
            connected = True
            last_successful_contact = time.time()
            break
    except:
        pass
    time.sleep(0.5)
else:
    print("⚠ Could not connect to ESP32. Make sure you're connected to ESP32-Predictor WiFi")

print("\nStarting face tracking...")
print("Press 'q' to quit\n")

while True:
    success, img = cap.read()
    if not success or img is None:
        print("Failed to read frame from camera")
        continue
    
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = face_cascade.detectMultiScale(gray, 1.3, 5)
    
    current_time = time.time()
    face_detected = False
    
    if len(faces) > 0:
        face_detected = True
        x, y, w, h = faces[0]
        fx, fy = x + w//2, y + h//2
        pos = [fx, fy]
        
        # Convert coordinates to servo degrees (inverted for natural movement)
        targetX = np.interp(fx, [0, ws], [180, 0])  # Inverted X
        targetY = np.interp(fy, [0, hs], [0, 180])  # Y normal
        
        # Clamp values
        targetX = max(0, min(180, targetX))
        targetY = max(0, min(180, targetY))
        
        # Apply smoothing
        targetX, targetY = apply_smoothing(targetX, targetY)
        
        # Only update if change is significant
        if abs(targetX - servoPos[0]) > movement_threshold or abs(targetY - servoPos[1]) > movement_threshold:
            targetPos[0] = targetX
            targetPos[1] = targetY
        
        # Draw face detection visualization
        cv2.rectangle(img, (x, y), (x+w, y+h), (0, 255, 0), 2)
        cv2.circle(img, (fx, fy), 80, (0, 255, 0), 2)
        cv2.line(img, (0, fy), (ws, fy), (0, 255, 0), 1)
        cv2.line(img, (fx, 0), (fx, hs), (0, 255, 0), 1)
        cv2.circle(img, (fx, fy), 15, (0, 255, 0), cv2.FILLED)
        cv2.putText(img, "TARGET LOCKED", (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 
                   1, (0, 255, 0), 2)
        cv2.putText(img, f"Face at: {pos}", (10, 80), cv2.FONT_HERSHEY_SIMPLEX, 
                   0.7, (0, 255, 0), 1)
        
    else:
        # No face detected - show warning
        cv2.putText(img, "NO TARGET - Searching...", (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 
                   1, (0, 0, 255), 2)
        cv2.circle(img, (ws//2, hs//2), 80, (0, 0, 255), 2)
        cv2.circle(img, (ws//2, hs//2), 15, (0, 0, 255), cv2.FILLED)
        cv2.line(img, (0, hs//2), (ws, hs//2), (0, 0, 255), 1)
        cv2.line(img, (ws//2, 0), (ws//2, hs), (0, 0, 255), 1)
    
    # Rate-limited servo update
    if current_time - last_servo_update > servo_update_interval:
        # Only send if connected and face detected
        if connected and face_detected:
            servoPos[0] = targetPos[0]
            servoPos[1] = targetPos[1]
            
            success = send_servo_command(servoPos[0], servoPos[1])
            if success:
                print(f"→ Servo: X={int(servoPos[0])}° Y={int(servoPos[1])}°")
        
        last_servo_update = current_time
    
    # Connection status indicator
    status_color = (0, 255, 0) if connected else (0, 0, 255)
    status_text = "ESP32: Connected" if connected else "ESP32: Disconnected"
    cv2.putText(img, status_text, (ws-250, 30), cv2.FONT_HERSHEY_SIMPLEX, 
               0.7, status_color, 2)
    
    # Show servo positions
    cv2.putText(img, f'Servo X: {int(servoPos[0])}°', (10, hs-40), cv2.FONT_HERSHEY_SIMPLEX, 
               1, (255, 0, 0), 2)
    cv2.putText(img, f'Servo Y: {int(servoPos[1])}°', (10, hs-10), cv2.FONT_HERSHEY_SIMPLEX, 
               1, (255, 0, 0), 2)
    
    # Show instructions
    cv2.putText(img, "Press 'q' to quit", (ws-200, hs-10), cv2.FONT_HERSHEY_SIMPLEX, 
               0.6, (128, 128, 128), 1)
    
    cv2.imshow("Face Tracking", img)
    
    # Check for quit
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

# Cleanup
cap.release()
cv2.destroyAllWindows()
print("\nFace tracking stopped.")
