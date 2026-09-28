# Jewelry Store AI Surveillance System
## Computer Vision Design Document (Aksha Platform)

---

# Overview

This document describes how the existing **Aksha AI Video Analytics Platform** can be extended to support **Jewelry Store Security, Operations, and Business Analytics** without creating an entirely new architecture.

The goal is to reuse the existing DeepStream, Kafka, Alert Engine, Dashboard, and Notification infrastructure while adding only the minimum components required for jewelry-store-specific intelligence.

---

# Objectives

Build an enterprise-grade AI surveillance solution capable of

- Detecting suspicious activities
- Monitoring valuable assets
- Protecting employees and customers
- Generating real-time alerts
- Providing business intelligence
- Reusing existing Aksha infrastructure

---

# Existing Aksha Components (Reuse)

| Component | Status |
|------------|--------|
| RTSP Camera Pipeline | ✅ Reuse |
| DeepStream Inference | ✅ Reuse |
| Kafka Event Bus | ✅ Reuse |
| MongoDB | ✅ Reuse |
| Alert Identification Engine | ✅ Reuse |
| Notification Service | ✅ Reuse |
| Dashboard Backend | ✅ Reuse |
| React Dashboard | ✅ Reuse |
| Face Recognition | ✅ Reuse |
| ANPR | ✅ Reuse |
| PDF Reporting | ✅ Reuse |
| Heatmap Generation | ✅ Reuse |

---

# Existing Pipeline

```
RTSP Cameras
      │
      ▼
DeepStream / frame_reader
      │
YOLO Detection
      │
      ▼
Kafka
      │
      ▼
Alert Identification
      │
      ▼
Kafka Alerts
      │
      ▼
Post Processor
      │
      ▼
Notifications
      │
      ▼
MongoDB
      │
      ▼
Dashboard
```

---

# New Components Required

| Component | Purpose |
|------------|---------|
| Jewelry Detection Model | Detect showcases, counters, vaults |
| Object Tracker | Track customer movement |
| New Alert Rules | Loitering, Counter Jumping |
| Business Analytics | Footfall, Queue, Dwell Time |

No new microservices are required.

---

# AI Models

## Detection Model

Train a custom YOLOv11 model.

Classes

- Person
- Staff
- Customer
- Showcase Closed
- Showcase Open
- Counter
- Cash Drawer
- Vault Door
- Safe Door

Future

- Jewelry Tray
- Ring Display
- Necklace Display
- Bracelet Display
- Bag
- Weapon
- Fire
- Smoke

---

## Tracking

Recommended

- ByteTrack
- NvDCF
- DeepSORT

Tracking enables

- Person ID
- Dwell Time
- Queue Detection
- Footfall
- Counter Crossing
- Zone Occupancy

---

## Existing Models

### Face Recognition

Reuse

- RetinaFace
- ArcFace
- FAISS

Applications

- Staff recognition
- Unauthorized staff detection
- Vault access
- Attendance

---

### ANPR

Reuse

Applications

- VIP customer arrival
- Blacklisted vehicle
- Employee parking

---

# Phase 1 Use Cases

---

## 1. After Hours Intrusion

Description

Detect any person entering restricted areas after business hours.

Detection

Person

Rule

Person inside zone outside configured business hours.

Alert

Critical

---

## 2. Counter Jump Detection

Description

Detect a customer crossing into employee-only space.

Detection

Person

Tracking

Required

Rule

Track crosses counter boundary.

Alert

Critical

---

## 3. Showcase Left Open

Description

Employee forgets to close jewelry showcase.

Detection

Showcase Open

Tracking

Timer

Rule

Showcase remains open longer than configured duration.

Alert

High

---

## 4. Loitering

Description

Customer remains near valuable showcase.

Detection

Person

Tracking

Required

Rule

Track remains inside zone longer than threshold.

Alert

Medium

---

## 5. Camera Tampering

Description

Camera blocked or moved.

Existing Feature

Reuse

Methods

- Blur detection
- Black frame detection
- Scene change detection

Alert

Critical

---

## 6. Staff in Vault

Description

Recognize authorized staff entering vault.

Detection

Face Recognition

Rule

Recognized employee enters vault.

Alert

Information

---

## 7. Unauthorized Vault Entry

Description

Unknown person enters vault.

Detection

Face Recognition

Rule

Unknown face detected.

Alert

Critical

---

## 8. Cash Drawer Open

Description

Cash drawer remains open.

Detection

Cash Drawer

Rule

Open longer than configured duration.

Alert

High

---

## 9. Queue Detection

Description

Count waiting customers.

Detection

Tracking

Rule

More than N people waiting.

Analytics

Queue length

Average waiting time

---

## 10. Footfall Analytics

Description

Count visitors.

Tracking

Track IDs entering entrance.

Reports

Visitors per

- Hour
- Day
- Week
- Month

---

## 11. Dwell Time Analytics

Description

Average time customers spend.

Tracking

Track lifetime.

Reports

Average dwell time

Zone dwell time

---

## 12. Occupancy

Description

Current customers inside store.

Tracking

Live count.

---

## 13. Restricted Area Entry

Description

Customer enters employee area.

Detection

Person

Rule

Person inside restricted polygon.

---

## 14. Safe Door Monitoring

Description

Safe left open.

Detection

Safe Door

Rule

Door open longer than threshold.

---

## 15. Employee Attendance

Description

Automatic attendance.

Detection

Face Recognition

Reports

First Entry

Last Exit

Working Hours

---

## 16. Camera Offline

Reuse existing monitoring.

Alerts

RTSP disconnected

Low FPS

No frames

---

# Phase 2 Use Cases

- Weapon Detection
- Fire Detection
- Smoke Detection
- Glass Break Detection
- Suspicious Object
- Bag Left Behind
- Fall Detection
- Running Detection
- Crowd Density
- Customer Journey
- Product Pickup Detection
- Cross Camera Re-ID
- Digital Twin
- Customer Demographics
- Emotion Analysis
- Store Conversion Analytics

---

# Detection Classes

## Phase 1

- Person
- Staff
- Customer
- Showcase Closed
- Showcase Open
- Counter
- Cash Drawer
- Vault Door
- Safe Door

---

## Phase 2

- Jewelry Tray
- Ring Tray
- Necklace Display
- Bracelet Display
- Gold Chain
- Diamond Ring
- Cash
- Bag
- Mobile Phone
- Fire
- Smoke
- Weapon

---

# Alert Rules

| Alert | Detection | Tracking | Face | Existing |
|--------|-----------|-----------|------|-----------|
| Intrusion | ✓ | | | ✓ |
| Counter Jump | ✓ | ✓ | | |
| Loitering | ✓ | ✓ | | |
| Showcase Open | ✓ | ✓ | | |
| Safe Open | ✓ | ✓ | | |
| Camera Tampering | | | | ✓ |
| Staff Vault Access | | | ✓ | |
| Unauthorized Vault | | | ✓ | |
| Queue | ✓ | ✓ | | |
| Footfall | ✓ | ✓ | | |
| Dwell Time | ✓ | ✓ | | |
| Occupancy | ✓ | ✓ | | |
| Attendance | | | ✓ | |

---

# Integration Architecture

## Initial Deployment

```
RTSP Camera
        │
        ▼
frame_reader
(OpenCV + YOLOv11)
        │
ByteTrack
        │
        ▼
Kafka Detection Topic
        │
        ▼
Alert Identification
        │
        ▼
Kafka Alert Topic
        ▲
        │
Face Recognition
        │
ANPR
        │
        ▼
Post Processor
        │
        ▼
Notification Service
        │
        ▼
MongoDB
        │
        ▼
Dashboard
```

---

## Production Deployment

```
RTSP Cameras
       │
       ▼
DeepStream
YOLO TensorRT
       │
NvTracker
       │
Kafka
       │
Alert Engine
       │
MongoDB
       │
Dashboard
```

---

# Dashboard

## Home

Display

- Live Camera Status
- Current Customers
- Current Staff
- Critical Alerts
- Today's Visitors
- Today's Alerts
- Average Dwell Time
- Queue Status

---

## Live View

Display

- Video
- Bounding Boxes
- Track IDs
- Zone Overlay
- Current Alerts

---

## Alerts

Display

- Snapshot
- Camera
- Alert Type
- Confidence
- Timestamp
- Status

---

## Analytics

Charts

- Visitors Per Hour
- Visitors Per Day
- Queue Length
- Dwell Time
- Heatmap
- Peak Hours
- Camera Health

---

# Notifications

Supported Channels

- Email
- WhatsApp
- Telegram
- Slack
- Push Notification
- REST API

---

# Reports

Daily

- Visitors
- Alerts
- Occupancy
- Queue

Weekly

- Peak Hours
- Store Traffic
- Employee Attendance

Monthly

- Store Performance
- Camera Health
- Alert Summary

PDF reports reuse existing anomaly reporting framework.

---

# Dataset Sources

## Public

- COCO 2017
- MOT17
- MOT20
- VGGFace2
- LFW
- Roboflow Universe

Search Kaggle

- Jewelry Detection
- Jewelry Images
- Gemstones
- Diamond Dataset
- Retail Shelf
- CCTV Person Detection
- Cash Drawer
- Weapon Detection
- Fire Detection

---

## Custom Dataset

Capture videos from

- Entrance
- Billing Counter
- Gold Counter
- Diamond Counter
- Necklace Counter
- Ring Counter
- Bracelet Counter
- Cash Drawer
- Vault Room
- Staff Entry

Extract frames every 2–5 seconds and annotate using CVAT, Label Studio, or Roboflow.

---

# Recommended Technology Stack

| Layer | Technology |
|---------|------------|
| Detection | YOLOv11 |
| Tracking | ByteTrack |
| GPU Inference | NVIDIA DeepStream |
| Face Recognition | ArcFace |
| Face Detection | RetinaFace |
| Database | MongoDB |
| Streaming | Kafka |
| Notifications | Existing Aksha |
| Dashboard | React |
| Backend | Node.js |
| AI Services | Python |

---

# Rollout Plan

## Phase 1

1. Collect jewelry-store CCTV footage.
2. Annotate custom dataset.
3. Train YOLOv11.
4. Validate on sample stores.
5. Deploy using frame_reader.
6. Integrate ByteTrack.
7. Extend alert rules.
8. Connect Face Recognition and ANPR.
9. Deploy dashboard.
10. Pilot in one jewelry store.

---

## Phase 2

- TensorRT optimization
- DeepStream integration
- Multi-camera deployment
- Business analytics
- Advanced AI models
- Predictive analytics
- Cross-camera tracking

---

# Benefits

- Reuses over **90% of the existing Aksha platform**
- No new core microservices
- Scalable from a single camera to hundreds of cameras
- GPU-accelerated deployment using DeepStream
- Real-time alerts with existing notification channels
- Enterprise-grade analytics and reporting
- Extensible architecture for future AI capabilities
