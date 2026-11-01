import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { poseFromLandmarks } from "./pose";

let detector: FaceLandmarker | undefined;
self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      const files = await FilesetResolver.forVisionTasks(message.wasm);
      detector = await FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: message.model, delegate: "CPU" },
        runningMode: "VIDEO", numFaces: 2,
        minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      self.postMessage({ type: "ready" });
    } else if (message.type === "frame") {
      const bitmap = message.bitmap as ImageBitmap;
      try {
        if (!detector) throw new Error("MediaPipe not initialized");
        const result = detector.detectForVideo(bitmap, message.timestamp);
        const faces = result.faceLandmarks.length;
        const candidates = result.faceLandmarks.map(poseFromLandmarks).filter(pose => pose !== null);
        self.postMessage({ type: "pose", captured: message.captured, faces, candidates, yaw: 0, pitch: 0 });
      } finally { bitmap.close(); }
    } else if (message.type === "stop") { detector?.close(); detector = undefined; self.close(); }
  } catch (error) { self.postMessage({ type: "error", error: String(error) }); }
};
