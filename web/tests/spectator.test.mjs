import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { DemoScene } from '../src/viewer/scene.js';

test('spectator camera stops before the nearest CSGEO wall', () => {
  const geometry = new BoxGeometry(10, 10, 2).translate(0, 0, -20);
  const scene = Object.create(DemoScene.prototype);
  scene.mapCollision = new MeshBVH(geometry);
  const origin = new Vector3();
  const target = new Vector3(0, 0, -40);
  scene._clipSpectatorCamera(origin, target);
  assert.deepEqual(target.toArray(), [0, 0, -13]);
  target.set(0, 0, -12);
  scene._clipSpectatorCamera(origin, target);
  assert.deepEqual(target.toArray(), [0, 0, -12]);
  geometry.dispose();
});
