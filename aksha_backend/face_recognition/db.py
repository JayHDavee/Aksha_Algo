import numpy as np
import pymongo
import joblib
import datetime as dt
import json
import config

def load_database(camera_name):
    try:
        conn = pymongo.MongoClient(config.DATABASE_CONNECTION, directConnection=True)
        DATABASE = conn["Aksha"]
        COLLECTION_FaceMeta = DATABASE[f"facemeta_{camera_name}"]
        return COLLECTION_FaceMeta
    except Exception as e:
        print(f"Error connecting to MongoDB: {e}")
        return None
