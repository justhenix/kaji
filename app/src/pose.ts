export type Landmark = { x: number; y: number; z: number };
export function poseFromLandmarks(landmarks: Landmark[]): { yaw: number; pitch: number; center_x: number; center_y: number; eye_span: number } | null {
  const left = landmarks[33], right = landmarks[263], nose = landmarks[1];
  if (!left || !right || !nose || ![left, right, nose].every(p => [p.x, p.y, p.z].every(Number.isFinite))) return null;
  // Use the eye-line basis so head roll does not become cursor pitch/yaw.
  const ex = right.x - left.x, ey = right.y - left.y;
  const span = Math.hypot(ex, ey);
  if (span < 0.04 || span > 0.65) return null;
  const nx = nose.x - (left.x + right.x) / 2;
  const ny = nose.y - (left.y + right.y) / 2;
  const pose = { yaw: (nx * ex + ny * ey) / (span * span), pitch: (-nx * ey + ny * ex) / (span * span), center_x: (left.x + right.x) / 2, center_y: (left.y + right.y) / 2, eye_span: span };
  if (Math.abs(pose.yaw) > 1.5 || Math.abs(pose.pitch) > 1.5 || pose.center_x < 0 || pose.center_x > 1 || pose.center_y < 0 || pose.center_y > 1) return null;
  return pose;
}
