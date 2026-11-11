# The model files, as tools/fetch_model.sh leaves them; SAT_MODEL_DIR overrides the directory.
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.abspath(os.environ.get("SAT_MODEL_DIR") or os.path.join(ROOT, "models", "sat-3l-sm"))
MODEL = os.path.join(MODEL_DIR, "model.onnx")
