import { test, expect } from "bun:test";
import { poseFromLandmarks } from "./pose";

test("rejects absent, tiny and non-finite face geometry", () => {
  expect(poseFromLandmarks([])).toBeNull();
  const points = Array.from({length: 478}, () => ({ x: 0.5, y: 0.5, z: 0 }));
  expect(poseFromLandmarks(points)).toBeNull();
  points[263].x = Number.NaN;
  expect(poseFromLandmarks(points)).toBeNull();
});
test("normalization removes roll and camera distance", () => {
  const pose = (angle: number, scale: number) => {
    const points = Array.from({length: 478}, () => ({ x: 0, y: 0, z: 0 }));
    const rotate = (x: number, y: number) => ({ x: 0.5 + scale * (x * Math.cos(angle) - y * Math.sin(angle)), y: 0.5 + scale * (x * Math.sin(angle) + y * Math.cos(angle)), z: 0 });
    points[33] = rotate(-0.1, 0); points[263] = rotate(0.1, 0); points[1] = rotate(0.03, 0.07);
    return poseFromLandmarks(points)!;
  };
  expect(pose(0.4, 1).yaw).toBeCloseTo(pose(0, 0.7).yaw, 8);
  expect(pose(0.4, 1).pitch).toBeCloseTo(pose(0, 0.7).pitch, 8);
});
