"""
object_based_model_trainer.py
==============================
Role
----
Train a One-Class SVM (OCSVM) model for **object-count-based anomaly detection**
on a per-camera basis.  The model learns what a "normal" distribution of detected
object counts looks like for a given camera and later flags frames whose count
vector falls outside that distribution.

Architecture / data-flow
------------------------
1.  A 7-day lookback window ending at ``current_time`` is constructed.
2.  For each day in that window, all ``meta_<camera>`` MongoDB documents whose
    ``Timestamp`` falls between 00:00:00 and 23:59:59 are fetched.
3.  Each document's ``Results`` array is unpacked: for every tracked object class
    the number of detections in that frame is counted and stored as a feature
    column.
4.  Non-feature columns (``Frame_Anomaly``, ``Object_Anomaly``, ``Results``,
    ``_id``, ``Alerts``, ``No_Object_Status``, ``Timestamp``) are dropped, leaving
    a purely numeric feature matrix.
5.  If the dataset has at least **2 000 rows**, a ``OneClassSVM`` is fitted on
    the feature matrix and serialised to disk with ``pickle``.

Tracked object classes (``object_classes`` list, 13 entries)
-------------------------------------------------------------
- person         – upright human body
- supine person  – person lying flat (e.g. fallen worker)
- helmet         – hard-hat detected (PPE compliance)
- no helmet      – person without hard-hat
- car            – passenger vehicle
- bicycle        – pedal cycle
- truck          – heavy vehicle
- motorbike      – two-wheeled motorised vehicle
- backpack       – carried backpack
- handbag        – carried handbag / bag
- gate open      – gate/door detected in open state
- gate closed    – gate/door detected in closed state
- fork lift      – industrial forklift vehicle

Minimum training data requirement
----------------------------------
At least **2 000 rows** (one row = one processed video frame) must be present in
the collected dataset.  Training is skipped and ``None`` is returned otherwise.

Model hyperparameters
----------------------
``OneClassSVM`` is initialised with:
  - ``nu=0.0005``     – upper bound on the fraction of training errors / support
                        vectors; a very small value means the model expects almost
                        no anomalies in training data.
  - ``kernel="rbf"``  – Radial Basis Function (Gaussian) kernel; captures
                        non-linear boundaries in feature space.
  - ``gamma=0.0005``  – RBF kernel coefficient; small value → wide, smooth
                        decision boundary.

Output artefact
---------------
Serialised ``OneClassSVM`` pickle file written to::

    <AKSHA_PATH>/<camera_name>/anomaly_models/objectbase/ocsvm_model.pkl

The directory is created automatically if it does not yet exist.

Logging
-------
Log messages are written to ``<AKSHA_PATH>/<camera_name>/log/model_loader.log``
at INFO level (append mode).
"""

import time
from datetime import date, timedelta
import datetime
import pandas as pd
import pymongo
from sklearn.svm import OneClassSVM
import pickle
import os
import logging

# ---------------------------------------------------------------------------
# Environment-variable configuration
# CAMERA_NAME – name/ID of the camera this process is responsible for.
# AKSHA_PATH  – root directory under which per-camera artefacts are stored.
# ---------------------------------------------------------------------------
camera_name = os.getenv("CAMERA_NAME")
main_dir = os.getenv("AKSHA_PATH")

# Derive the log directory from the resolved camera name and AKSHA root path,
# then create it (including any missing parent directories) before configuring
# the file logger so that the first log write does not fail with FileNotFoundError.
logger_path = f"{main_dir}/{camera_name}/log"
os.makedirs(logger_path, exist_ok=True)

# Configure a file-based logger that appends to model_loader.log.
# All log records include a timestamp, severity level, and message.
logging.basicConfig(
    filename=f"{logger_path}/model_loader.log",
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    filemode="a",
)
logger = logging.getLogger("model_loader")

# Ordered list of object classes whose per-frame detection counts form the
# feature vector fed into the OCSVM.  The order is fixed so that the feature
# columns in training and inference DataFrames always align.
object_classes = ["person", "supine person", "helmet", "no helmet", "car", "bicycle", "truck", "motorbike", "backpack",
                  "handbag", "gate open", "gate closed", "fork lift"]


def get_count(lst, obj):
    """Count how many detections in *lst* match the given object label.

    Each element of *lst* is a detection dictionary produced by the inference
    pipeline.  Only the ``'label'`` field is examined.

    Parameters
    ----------
    lst : list[dict]
        The ``Results`` array from a single ``meta_<camera>`` document.  Each
        dict must contain at least the key ``'label'`` with a string value.
    obj : str
        The object class label to search for (e.g. ``"person"``).

    Returns
    -------
    int
        Number of elements in *lst* whose ``'label'`` value equals *obj*.

    Examples
    --------
    >>> get_count([{'label': 'person'}, {'label': 'car'}], 'person')
    1
    >>> get_count([], 'helmet')
    0
    """
    # List-comprehension filter: keep only detections where the label matches
    # the requested object class, then return the length of that filtered list.
    return len([x for x in lst if x['label'] == obj])


def get_objects_data(camera_name, start_time, end_time, database):
    """Fetch all ``meta_<camera>`` documents within a given time range.

    Performs a MongoDB range query on the ``Timestamp`` field to retrieve every
    document that was recorded strictly between *start_time* and *end_time*.

    Parameters
    ----------
    camera_name : str
        Name/ID of the camera; used to derive the collection name
        (``meta_<camera_name>``).
    start_time : datetime.datetime
        Lower bound for the ``Timestamp`` query (exclusive, ``$gt``).
    end_time : datetime.datetime
        Upper bound for the ``Timestamp`` query (exclusive, ``$lt``).
    database : pymongo.database.Database
        An active PyMongo database handle pointing to the correct database.

    Returns
    -------
    list[dict]
        A list of raw MongoDB documents (Python dicts) satisfying the time
        constraint.  The list may be empty if no matching documents exist.
    """
    # Access the camera-specific collection; collection name follows the
    # convention "meta_<camera_name>" used throughout the Aksha platform.
    posts = database["meta_" + str(camera_name)]

    objects = []  # Accumulator for all matched documents.

    # Iterate over every document in the time window and collect it.
    # $lt / $gt make the boundary exclusive on both ends.
    for post in posts.find({"Timestamp": {"$lt": end_time, "$gt": start_time}}):
        objects.append(post)
    return objects


def get_training_data(days_list, camera_name, database):
    """Build a feature DataFrame from multiple days of ``meta_<camera>`` records.

    For each calendar date in *days_list* the function:

    1. Constructs a midnight-to-23:59:59 time window for that date.
    2. Calls :func:`get_objects_data` to retrieve all documents in that window.
    3. After all days are processed, assembles all collected documents into a
       single :class:`pandas.DataFrame`.
    4. Adds one numeric feature column per entry in ``object_classes`` by
       calling :func:`get_count` on the ``Results`` array of each document.
    5. Drops all columns that are not features (identifiers, labels, arrays)
       so that only the object-count columns remain.

    Parameters
    ----------
    days_list : list[datetime.date | datetime.datetime]
        Ordered list of calendar dates to include in the training corpus.
        Typically the 7 days immediately preceding the current date.
    camera_name : str
        Name/ID of the camera whose collection is queried.
    database : pymongo.database.Database
        Active PyMongo database handle.

    Returns
    -------
    pandas.DataFrame
        A numeric DataFrame where each row corresponds to one processed video
        frame and each column is the detection count for one object class.
        Returns an **empty** DataFrame if no documents were found across all
        requested days.

    Notes
    -----
    Columns removed before returning (non-feature metadata):
      - ``Frame_Anomaly``    – pre-existing anomaly flag for the frame
      - ``Object_Anomaly``   – pre-existing object-level anomaly flag
      - ``Results``          – raw detection list (already expanded into columns)
      - ``_id``              – MongoDB ObjectId
      - ``Alerts``           – triggered alert names
      - ``No_Object_Status`` – flag for "no object" alert logic
      - ``Timestamp``        – wall-clock time (not a numeric feature)
    """
    output_list = []        # Flat list of all raw documents across all days.
    filtered_df = pd.DataFrame()  # Will hold the final feature matrix.

    for target_date in days_list:
        logger.info(f"Processing target date: {target_date}")

        # Build the start-of-day boundary: midnight (00:00:00.000000) on target_date.
        start_time = datetime.datetime(
            year=target_date.year,
            month=target_date.month,
            day=target_date.day,
            hour=0,
            minute=0,
            second=0,
            microsecond=0,
        )
        # Build the end-of-day boundary: last second of target_date (23:59:59).
        end_time = start_time.replace(hour=23, minute=59, second=59)

        try:
            # Append all documents for this day to the running list.
            output_list += get_objects_data(camera_name, start_time, end_time, database)
        except Exception as e:
            # Log the error but continue so that other days can still be processed.
            logger.exception(f"Failed to get objects data for {target_date}: {e}")
            continue

    # Convert the flat list of documents into a DataFrame; one row per document.
    filtered_df = pd.DataFrame(output_list)

    # Guard: if the DataFrame is empty there is nothing to expand or train on.
    if len(filtered_df) == 0:
        return filtered_df

    # For each tracked object class, compute the per-frame detection count by
    # applying get_count over the 'Results' column (list of detection dicts).
    # Each call creates a new numeric column named after the object class.
    for obj in object_classes:
        filtered_df[obj] = filtered_df['Results'].apply(get_count, obj=obj)

    # Remove all columns that are not numeric features.  These columns carry
    # metadata, raw arrays, or MongoDB internals that must not enter the model.
    filtered_df.drop(["Frame_Anomaly", "Object_Anomaly", "Results", "_id", "Alerts", "No_Object_Status", "Timestamp"],
                     axis=1, inplace=True)

    return filtered_df


def train_OCSVM_object_based_model(aksha_path, camera_name, database, current_time):
    """Train and persist an OCSVM anomaly model for object-count features.

    End-to-end orchestration function that:

    1. Builds a 7-day lookback window (``current_time`` inclusive minus 6 days).
    2. Retrieves and featurises the training corpus via :func:`get_training_data`.
    3. Enforces the 2 000-row minimum; aborts gracefully if not met.
    4. Fits a :class:`sklearn.svm.OneClassSVM` on the feature matrix.
    5. Serialises the fitted model to ``ocsvm_model.pkl`` under the camera's
       ``anomaly_models/objectbase/`` directory inside *aksha_path*.

    Parameters
    ----------
    aksha_path : str
        Root filesystem path for Aksha artefacts (typically from the
        ``AKSHA_PATH`` environment variable).
    camera_name : str
        Name/ID of the camera for which the model is being trained.
    database : pymongo.database.Database
        Active PyMongo database handle pointing to the correct database.
    current_time : datetime.date | datetime.datetime
        Reference date from which the 7-day window is computed.  Day 0 is
        *current_time* itself; day 6 is six days earlier.

    Returns
    -------
    None
        The function returns ``None`` in all branches: on success (after writing
        the pickle file) and on any early-exit condition (insufficient data,
        query failure, or fit failure).

    Side-effects
    ------------
    - Creates ``<aksha_path>/<camera_name>/anomaly_models/objectbase/`` if absent.
    - Writes / overwrites ``ocsvm_model.pkl`` in that directory on success.
    - Appends INFO / ERROR entries to the camera's ``model_loader.log``.

    Notes
    -----
    OCSVM hyperparameters used:
      - ``nu=0.0005``    – expected fraction of anomalous training samples.
      - ``kernel="rbf"`` – Radial Basis Function (Gaussian) kernel.
      - ``gamma=0.0005`` – RBF bandwidth parameter (inverse of influence radius).
    """
    # Construct the list of 7 dates: [current_time, current_time-1, ..., current_time-6].
    # timedelta subtracts whole days so that dates are always calendar-aligned.
    days_list = [current_time - timedelta(days=i) for i in range(7)]
    logger.info(f"Days list: {days_list}")

    try:
        # Fetch and featurise all meta documents for the 7-day window.
        training_data = get_training_data(days_list, camera_name, database)
        logger.info("Got training data")
    except Exception as e:
        # If data retrieval itself raises an unexpected exception, log and bail.
        logger.exception(f"Get training data issue: {e}")
        return None

    # Guard: completely empty dataset – nothing to train on.
    if len(training_data) == 0:
        return None
    # Guard: insufficient data – OCSVM requires enough samples to build a reliable
    # decision boundary.  Below 2 000 rows the model would likely over-fit or
    # produce an unstable boundary.
    if len(training_data) < 2000:
        logger.info(f"Object-based anomaly model for {camera_name} not trained as training data len is less than 2k")
        return None

    logger.info(f"Training data shape: {training_data.shape}")

    # Instantiate the One-Class SVM with carefully chosen hyperparameters.
    # nu=0.0005  → very tight boundary; almost no training point is treated as an outlier.
    # kernel="rbf" → Gaussian kernel for smooth non-linear decision surface.
    # gamma=0.0005 → wide kernel; each support vector influences a large region.
    clf = OneClassSVM(nu=0.0005, kernel="rbf", gamma=0.0005)
    try:
        # Fit the model on the raw numpy array extracted from the DataFrame.
        # .values converts the DataFrame to a 2-D numpy float array.
        clf.fit(training_data.values)
    except Exception as e:
        # Classifier fit can fail if data contains NaNs or has zero variance columns.
        logger.exception(f"Classifier error: {e}")
        return None

    # Resolve the output directory and create it (with all missing parents) if needed.
    dir_path = f"{aksha_path}/{camera_name}/anomaly_models/objectbase"
    os.makedirs(dir_path, exist_ok=True)

    # Fixed filename for the object-based OCSVM model; downstream inference
    # code locates the model by this exact name.
    file_name = 'ocsvm_model.pkl'
    try:
        # Serialise the fitted sklearn estimator to a binary pickle file.
        # 'wb' opens (or overwrites) the file in binary-write mode.
        pickle.dump(clf, open(os.path.join(dir_path, file_name), 'wb'))
        logger.info(f"Object-based anomaly model for {camera_name} stored successfully!!!")
    except Exception as e:
        logger.exception(f"Object-based anomaly model for {camera_name} failed to store with exception: {e}")
