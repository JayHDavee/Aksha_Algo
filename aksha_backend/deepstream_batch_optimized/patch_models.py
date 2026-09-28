"""
patch_models — fix TopK axis in ONNX models before the Docker image is finalised.

Run once at image build time (see dockerfile RUN step) so nvinfer never sees
negative axis values:

  yolov10.onnx         ──→  TopK axis=-1 → axis=1 (patched in-place)
  yolov10_dynamic.onnx ──→  same patch

Why:
  Some YOLOv10 exporters emit axis=-1 on TopK nodes.  TensorRT rejects negative
  axis values and refuses to build the engine.  Patching to axis=1 is semantically
  equivalent for YOLOv10's [1, N, classes] output shape and makes the model
  load cleanly on TRT, CUDA, and CPU execution providers.

Note:
  Models are patched in-place (overwrite app/<name>.onnx) so the patched path is
  the same as the source path.  The script is removed from the image after running
  (see dockerfile: RUN python3 patch_models.py && rm patch_models.py).
"""

import onnx
import os

for name in ["yolov10_dynamic.onnx", "yolov10.onnx"]:
    path = os.path.join("app", name)
    if not os.path.exists(path):
        print(f"SKIP {name} — not found")
        continue
    model = onnx.load(path)
    patched = 0
    for node in model.graph.node:
        if node.op_type != "TopK":
            continue
        # Find existing axis attribute (may be absent on some exported models)
        axis_attr = next((a for a in node.attribute if a.name == "axis"), None)
        if axis_attr and axis_attr.i < 0:
            axis_attr.i = 1   # overwrite negative axis with the correct positive value
            patched += 1
        elif not axis_attr:
            # Attribute missing entirely — add it explicitly
            node.attribute.append(onnx.helper.make_attribute("axis", 1))
            patched += 1
    onnx.save(model, path)
    print(f"Patched {patched} TopK node(s) in {name}")

print("TopK patch complete")
