import cv2
import numpy as np
import easyocr
import onnxruntime as ort
import re
import os

ALPHA_MAP = {'0': 'O', '1': 'I', '2': 'Z', '3': 'B', '4': 'A','5': 'S', '6': 'G', '7': 'T', '8': 'B', '9': 'G'}
DIGIT_MAP = {'O': '0', 'I': '1', 'Z': '2', 'B': '8','S': '5', 'G': '6', 'T': '7', 'A': '4', 'L':'4'}

class NumberPlateRecognizerONNX:
    def __init__(self, model_path, imgsz=640, conf=0.25):
        print(f"Initializing ANPR with model: {model_path}")
        
        # Check if model file exists
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Model file not found at: {model_path}")
        
        # Initialize EasyOCR with CPU only
        print("Initializing EasyOCR...")
        self.reader = easyocr.Reader(['en'], gpu=False)
        
        self.imgsz = imgsz
        self.conf = conf
        
        # Initialize ONNX Runtime with CPU only
        print("Initializing ONNX Runtime...")
        self.session = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
        
        # Debug: Print model info
        print("=== ONNX Model Info ===")
        print("Inputs:")
        for inp in self.session.get_inputs():
            print(f"  Name: {inp.name}, Shape: {inp.shape}, Type: {inp.type}")
        
        print("Outputs:")
        for out in self.session.get_outputs():
            print(f"  Name: {out.name}, Shape: {out.shape}, Type: {out.type}")
        
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        print("ANPR initialized successfully")

    def preprocess(self, frame):
        img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        h0, w0 = img.shape[:2]
        r = self.imgsz / max(h0, w0)
        new_size = (int(w0*r), int(h0*r))
        img_resized = cv2.resize(img, new_size)
        canvas = np.full((self.imgsz, self.imgsz,3), 114, dtype=np.uint8)
        canvas[:new_size[1], :new_size[0], :] = img_resized
        img_trans = canvas.transpose(2,0,1).astype(np.float32)/255.0
        img_trans = np.expand_dims(img_trans,0)
        return img_trans, r, canvas.shape[:2]

    def postprocess(self, outputs, ratio, pad, conf_threshold=0.25):
        """
        Handle different ONNX model output formats:
        Common formats:
        1. [batch, num_detections, 6]  - x1, y1, x2, y2, confidence, class_id
        2. [batch, num_detections, 7]  - x1, y1, x2, y2, confidence, class_confidence, class_id (YOLOv8)
        3. [batch, num_detections, 85] - x_center, y_center, width, height, conf, 80 class scores (YOLO)
        """
        results = []
        
        # Debug output shape
        print(f"Raw output shape: {outputs.shape}")
        
        # Remove batch dimension if present
        if len(outputs.shape) == 3:
            outputs = outputs[0]
        
        print(f"Processing {len(outputs)} detections")
        
        for i, detection in enumerate(outputs):
            if len(detection) < 6:
                continue
                
            # Print first few detections for debugging
            if i < 3:
                print(f"Detection {i}: {detection[:10]}...")
            
            # Try to extract values based on common formats
            try:
                # Format 1: Standard 6 values [x1, y1, x2, y2, conf, class_id]
                if len(detection) >= 6:
                    # Check if it's normalized YOLO format (x_center, y_center, w, h)
                    if detection[0] < 1 and detection[1] < 1 and detection[2] < 1 and detection[3] < 1:
                        # YOLO format: [x_center, y_center, width, height, confidence, ...]
                        x_center, y_center, width, height, conf = detection[:5]
                        
                        if conf < conf_threshold:
                            continue
                            
                        # Convert to corner coordinates
                        x1 = (x_center - width/2) * self.imgsz
                        y1 = (y_center - height/2) * self.imgsz
                        x2 = (x_center + width/2) * self.imgsz
                        y2 = (y_center + height/2) * self.imgsz
                        
                        # Find class
                        if len(detection) > 5:
                            class_scores = detection[5:]
                            class_id = np.argmax(class_scores)
                        else:
                            class_id = 0
                    else:
                        # Assume corner coordinates [x1, y1, x2, y2, ...]
                        x1, y1, x2, y2, conf = detection[:5]
                        
                        if conf < conf_threshold:
                            continue
                            
                        # Find class ID
                        if len(detection) > 5:
                            # Check if next value is class confidence or class id
                            if detection[5] <= 80:  # Likely class ID
                                class_id = int(detection[5])
                            else:
                                # Might be class confidence, look for class ID
                                if len(detection) > 6:
                                    class_id = int(detection[6])
                                else:
                                    class_id = 0
                        else:
                            class_id = 0
                    
                    # Apply ratio and pad adjustment
                    x1 = int((x1 - pad[1]) / ratio)
                    y1 = int((y1 - pad[0]) / ratio)
                    x2 = int((x2 - pad[1]) / ratio)
                    y2 = int((y2 - pad[0]) / ratio)
                    
                    # Ensure coordinates are within image bounds
                    x1 = max(0, x1)
                    y1 = max(0, y1)
                    x2 = min(x2, self.imgsz)
                    y2 = min(y2, self.imgsz)
                    
                    results.append([x1, y1, x2, y2, conf, class_id])
                    
            except Exception as e:
                print(f"Error processing detection {i}: {e}")
                continue
        
        print(f"Filtered to {len(results)} results after confidence threshold")
        return results

    def merge_multiline_text(self, ocr_results, y_threshold=15):
        lines = []
        for box, text, conf in ocr_results:
            y_center = sum(p[1] for p in box) / 4
            lines.append((y_center, text))
        lines.sort(key=lambda x:x[0])
        merged, current_line, last_y = [], [], None
        for y, text in lines:
            if last_y is None or abs(y-last_y) < y_threshold:
                current_line.append(text)
            else:
                merged.append(" ".join(current_line))
                current_line = [text]
            last_y = y
        if current_line: merged.append(" ".join(current_line))
        return " ".join(merged)

    def postprocessing_text(self, text):
        text = text.upper()
        text = text.replace("IND","")
        text = re.sub(r'[^A-Z0-9]','', text)
        if len(text)==10:
            corrected = list(text)
            alpha_idx = [0,1,4,5]
            for i in alpha_idx:
                if corrected[i].isdigit():
                    corrected[i] = ALPHA_MAP.get(corrected[i], corrected[i])
            digit_idx = [2,3,6,7,8,9]
            for i in digit_idx:
                if corrected[i].isalpha():
                    corrected[i] = DIGIT_MAP.get(corrected[i], corrected[i])
            text = "".join(corrected)
        return text

    def detect(self, frame):
        print("="*50)
        print("Starting detection...")
        img_trans, ratio, pad = self.preprocess(frame)
        print(f"Preprocessed: ratio={ratio}, pad={pad}")
        
        outputs = self.session.run([self.output_name], {self.input_name: img_trans})[0][0]
        results = self.postprocess(outputs, ratio, pad, self.conf)

        detections = []
        print(f"Found {len(results)} license plate(s)")
        
        for idx, box in enumerate(results):
            x1, y1, x2, y2, score, cls = box
            print(f"Plate {idx+1}: bbox=({x1},{y1},{x2},{y2}), score={score:.3f}")
            
            crop = frame[y1:y2, x1:x2]
            
            # Skip if crop is too small
            if crop.shape[0] == 0 or crop.shape[1] == 0:
                print(f"  Skipping empty crop")
                continue
                
            print(f"  Crop size: {crop.shape}")
            ocr_results = self.reader.readtext(crop)
            
            text_raw, text_processed = "", ""
            if ocr_results:
                print(f"  OCR found {len(ocr_results)} text regions")
                text_raw = self.merge_multiline_text(ocr_results)
                text_processed = self.postprocessing_text(text_raw)
                print(f"  Raw OCR: '{text_raw}'")
                print(f"  Processed: '{text_processed}'")
            else:
                print(f"  No text detected")
            
            detections.append({
                "bbox": [x1, y1, x2, y2],
                "score": float(score),
                "ocr_raw": text_raw,
                "ocr_post": text_processed
            })
        
        print("Detection completed")
        print("="*50)
        return detections
