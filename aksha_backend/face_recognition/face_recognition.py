# import torch
# import cv2 
# import numpy as np
# import os
# import pickle
# from typing import  List, Any, Dict

# # --- UNIFACE DEPENDENCIES ---
# import uniface
# from uniface import FaceAnalyzer
# from uniface.detection import RetinaFace
# from uniface.recognition import ArcFace

# # --- CONFIGURATION ---
# DEVICE = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
# REFERENCE_DIR = './data'
# DB_PATH = './face_embeddings_db.pkl'
# SIMILARITY_THRESHOLD = 0.6 
# IMG_SIZE = (112, 112) # Uniface/ArcFace standard size

# # --- HELPER FUNCTIONS ---

# def get_similarity(v1, v2):
#     """Calculates cosine similarity between two 1D vectors."""
#     v1 = v1.flatten()
#     v2 = v2.flatten()
#     return np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2))

# def load_or_create_embeddings(analyzer, reference_dir, db_path):
#     """Loads database from pickle or scans directory to create it."""
#     if os.path.exists(db_path):
#         print(f"--- Loading existing embeddings from {db_path} ---")
#         with open(db_path, 'rb') as f:
#             return pickle.load(f)
    
#     print(f"--- No database found. Scanning images in {reference_dir} ---")
#     known_faces = {}
#     for person_name in os.listdir(reference_dir):
#         person_path = os.path.join(reference_dir, person_name)
#         if not os.path.isdir(person_path): continue
#         known_faces[person_name] = []
#         images = [f for f in os.listdir(person_path) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
        
#         for img_name in images:
#             img = cv2.imread(os.path.join(person_path, img_name))
#             if img is None: continue
#             faces = analyzer.analyze(img)
#             if faces:
#                 known_faces[person_name].append(faces[0].embedding)
#         print(f" [SUCCESS] Enrolled {person_name}")
    
#     with open(db_path, 'wb') as f:
#         pickle.dump(known_faces, f)
#     return known_faces

# # --- INITIALIZATION ---

# print("--- Initializing Face Recognition System ---")
# # Initialize the Uniface Analyzer (Detector + Recognizer)
# ANALYZER = FaceAnalyzer(
#     detector=RetinaFace(confidence_threshold=0.5),
#     recognizer=ArcFace()
# )

# # Load the vector database
# KNOWN_FACES = load_or_create_embeddings(ANALYZER, REFERENCE_DIR, DB_PATH)
# print("--- Setup Complete. Ready to process frames. ---")

# # --- FRAME PROCESSING FUNCTION ---

# DetectionResult = List[Dict[str, Any]]

# def process_single_frame_for_api(frame: np.ndarray) -> DetectionResult:
#     """
#     Processes a single frame for face detection and recognition using 
#     Vector Similarity (ArcFace).
#     """
#     if frame is None:
#         return []
#     # 1. Detection & Recognition via Analyzer
#     # This finds faces and generates embeddings in one go
#     current_faces = ANALYZER.analyze(frame)
#     results: DetectionResult = []

#     if not current_faces:
#         return results

#     # 2. Process all detected faces
#     for i, face in enumerate(current_faces):
#         best_name = "Unknown"
#         max_sim = -1.0
#         temp_best_name = "Unknown"

#         try:
#             # Vector Comparison Logic (Replacing the Hybrid logic)
#             query_embedding = face.embedding
            
#             for name, embeddings_list in KNOWN_FACES.items():
#                 for ref_vector in embeddings_list:
#                     sim = get_similarity(query_embedding, ref_vector)
#                     if sim > max_sim:
#                         max_sim = sim
#                         temp_best_name = name
            
#             # Apply Threshold
#             if max_sim >= SIMILARITY_THRESHOLD:
#                 best_name = temp_best_name
#             else:
#                 best_name = "Unknown"

#             # Get box coordinates
#             x_min, y_min, x_max, y_max = face.bbox.astype(int)

#             results.append({
#                 "box": [int(x_min), int(y_min), int(x_max), int(y_max)],
#                 "label": best_name,
#                 "Score": round(float(max_sim), 2)
#             })

#         except Exception as e:
#             print(f"Error processing face {i}: {e}")
#             bbox = face.bbox.astype(int)
#             results.append({
#                 "box": [int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])],
#                 "label": "ERROR",
#                 "Score": 0.0
#             })

#     return results

import torch
import cv2 
import numpy as np
import os
import pickle
import faiss  
from typing import List, Any, Dict

# --- UNIFACE DEPENDENCIES ---
import uniface
from uniface import FaceAnalyzer
from uniface.detection import RetinaFace
from uniface.recognition import ArcFace

# --- CONFIGURATION ---
DEVICE = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
REFERENCE_DIR = './data'
DB_PATH = './faiss_database.pkl'
SIMILARITY_THRESHOLD = 0.5
EMBEDDING_DIM = 512 # Standard for ArcFace

# --- INITIALIZATION LOGIC ---

def load_or_create_faiss_db(analyzer, reference_dir, db_path):
    """Loads FAISS index from disk or scans images to build a new one."""
    if os.path.exists(db_path):
        print(f"--- Loading FAISS Index from {db_path} ---")
        with open(db_path, 'rb') as f:
            data = pickle.load(f)
            # Reconstruct FAISS index from serialized data
            index = faiss.deserialize_index(data['index'])
            id_to_name = data['id_to_name']
        return index, id_to_name
    
    print(f"--- No FAISS Database found. Scanning {reference_dir} ---")
    embeddings_list = []
    id_to_name = []
    
    if not os.path.exists(reference_dir):
        print(f"ERROR: Reference directory {reference_dir} not found.")
        return None, []

    for person_name in os.listdir(reference_dir):
        person_path = os.path.join(reference_dir, person_name)
        if not os.path.isdir(person_path): continue
        
        images = [f for f in os.listdir(person_path) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
        for img_name in images:
            img = cv2.imread(os.path.join(person_path, img_name))
            if img is None: continue
            
            faces = analyzer.analyze(img)
            if faces:
                # Prepare vector for FAISS (Normalize for Cosine Similarity)
                emb = faces[0].embedding.flatten().astype('float32')
                faiss.normalize_L2(emb.reshape(1, -1))
                
                embeddings_list.append(emb)
                id_to_name.append(person_name)
        print(f"  [SUCCESS] Enrolled {person_name}")

    # Build FAISS Index (IndexFlatIP = Inner Product, used for Cosine Similarity on normalized vectors)
    embeddings_np = np.array(embeddings_list).astype('float32')
    index = faiss.IndexFlatIP(EMBEDDING_DIM)
    index.add(embeddings_np)
    
    # Save for next time
    with open(db_path, 'wb') as f:
        pickle.dump({
            'index': faiss.serialize_index(index), 
            'id_to_name': id_to_name
        }, f)
    
    print(f"--- FAISS Database Saved with {len(id_to_name)} vectors ---")
    return index, id_to_name

# Initialize the Analyzer and Database
print("--- Initializing Face Recognition System (FAISS Mode) ---")
ANALYZER = FaceAnalyzer(
    detector=RetinaFace(confidence_threshold=0.5),
    recognizer=ArcFace()
)

FAISS_INDEX, ID_TO_NAME = load_or_create_faiss_db(ANALYZER, REFERENCE_DIR, DB_PATH)
print("--- Setup Complete. Ready to process frames. ---")

# --- FRAME PROCESSING FUNCTION ---

DetectionResult = List[Dict[str, Any]]

def process_single_frame_for_api(frame: np.ndarray) -> DetectionResult:
    """
    Processes a single frame using FAISS for ultra-fast matching.
    """
    if frame is None or FAISS_INDEX is None:
        return []

    current_faces = ANALYZER.analyze(frame)
    results: DetectionResult = []

    if not current_faces:
        return results

    for i, face in enumerate(current_faces):
        try:
            # 1. Prepare the probe (current face) vector
            probe = face.embedding.flatten().astype('float32').reshape(1, -1)
            faiss.normalize_L2(probe) # Essential for Cosine Similarity
            
            # 2. FAISS Search (Find the single best match)
            # D = Similarity Score, I = Index/ID of the match
            D, I = FAISS_INDEX.search(probe, k=1)
            
            best_score = float(D[0][0])
            match_idx = I[0][0]
            
            # 3. Apply Threshold Logic
            if best_score >= SIMILARITY_THRESHOLD and match_idx != -1:
                label = ID_TO_NAME[match_idx]
            else:
                label = "Unknown"

            # 4. Format Output
            x_min, y_min, x_max, y_max = face.bbox.astype(int)
            results.append({
                "box": [int(x_min), int(y_min), int(x_max), int(y_max)],
                "label": label,
                "Score": round(best_score, 2)
            })

        except Exception as e:
            print(f"Error processing face {i}: {e}")
            bbox = face.bbox.astype(int)
            results.append({
                "box": [int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])],
                "label": "ERROR",
                "Score": 0.0
            })

    return results