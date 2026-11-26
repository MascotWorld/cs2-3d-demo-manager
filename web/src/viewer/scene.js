import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { PlayerOutline } from './player-outline.js';
import {
  cs2ToThree,
  cs2LookDirThree,
  playerEyePosThree,
  playerBodyHeight,
  interpolateFrames,
  smokeEnvelope,
  parseCsmsh1,
  povCameraFov,
  cs2FovToVertical,
  roundTeamsBySlot,
  WORLD_FOV,
  VIEWMODEL_FOV,
  isSniperWeapon,
  weaponCategory,
  weaponNameToModelKey,
  grenadeTypeToModelKey,
  deoverlapScreenTags,
  detectGlbTransform,
  QUALITY_PRESETS,
  nextDowngradedQuality,
  computePlayerSpeed,
  resolveOperatorClipNames,
  findNextAliveTeammate,
  PLAYER_RADIUS,
  INCHES_PER_METER,
} from './math.js';

const CT_COLOR = 0x4ba3ff;
const T_COLOR = 0xf5a623;
const CT_XRAY = 0x6ec3ff;
const T_XRAY = 0xffbd4a;
const WORLD_FOV_VERTICAL = cs2FovToVertical(WORLD_FOV);

// Sun direction shared between DirectionalLight shadow casting and atmospheric sky lighting
const SUN_OFFSET = new THREE.Vector3(2100, 1950, 1450);
const SUN_DIR = SUN_OFFSET.clone().normalize();

// WeakMap cache so Source 2 ORM textures (R=Metal, G=Rough, B=AO) are R<->B swapped once per Image
const ormSwapCache = new WeakMap();
const ormDetectCache = new WeakMap();

function isSwappedSource2OrmImage(img) {
  if (!img) return false;
  if (ormDetectCache.has(img)) return ormDetectCache.get(img);
  let swapped = false;
  try {
    const w = img.width || img.naturalWidth || 0;
    const h = img.height || img.naturalHeight || 0;
    if (w > 0 && h > 0) {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 16;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 16, 16);
      const data = ctx.getImageData(0, 0, 16, 16).data;
      let rSum = 0;
      let bSum = 0;
      const n = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        rSum += data[i];
        bSum += data[i + 2];
      }
      const rAvg = rSum / n;
      const bAvg = bSum / n;
      // Source2Viewer-CLI packs R=Metalness (~0-25 on dielectrics), G=Roughness, B=AO (~160-255)
      swapped = rAvg < bAvg && (rAvg < 75 || bAvg > 155);
    }
  } catch {
    swapped = false;
  }
  ormDetectCache.set(img, swapped);
  return swapped;
}

function getFixedOrmTexture(tex) {
  if (!tex || !tex.image) return tex;
  const img = tex.image;
  if (ormSwapCache.has(img)) {
    return ormSwapCache.get(img);
  }
  if (!isSwappedSource2OrmImage(img)) {
    return tex;
  }
  try {
    const w = img.width || img.naturalWidth || 256;
    const h = img.height || img.naturalHeight || 256;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      d[i] = d[i + 2]; // glTF AO <- Source2 B
      d[i + 2] = r;    // glTF Metalness <- Source2 R
    }
    ctx.putImageData(imgData, 0, 0);
    const fixed = new THREE.CanvasTexture(c);
    fixed.flipY = tex.flipY;
    fixed.colorSpace = THREE.NoColorSpace;
    fixed.wrapS = tex.wrapS;
    fixed.wrapT = tex.wrapT;
    fixed.repeat.copy(tex.repeat);
    fixed.offset.copy(tex.offset);
    fixed.minFilter = tex.minFilter;
    fixed.magFilter = tex.magFilter;
    fixed.anisotropy = tex.anisotropy;
    fixed.needsUpdate = true;
    ormSwapCache.set(img, fixed);
    return fixed;
  } catch {
    return tex;
  }
}

function fixSource2OrmMaterial(m, { isOperatorOrWeapon = false, maxAnisotropy = 8 } = {}) {
  if (!m) return;
  const aniso = Math.max(1, Math.min(8, maxAnisotropy || 8));
  if (m.map) {
    m.map.colorSpace = THREE.SRGBColorSpace;
    m.map.anisotropy = Math.max(m.map.anisotropy || 1, aniso);
    m.map.needsUpdate = true;
  }
  if (m.emissiveMap) {
    m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
    m.emissiveMap.needsUpdate = true;
  }
  if (m.normalMap) {
    m.normalMap.colorSpace = THREE.NoColorSpace;
    m.normalMap.anisotropy = Math.max(m.normalMap.anisotropy || 1, aniso);
  }
  // Fix R<->B channel swap in Source2Viewer-CLI _orm_ textures
  const ormSourceTex = m.metalnessMap || m.roughnessMap || m.aoMap;
  if (ormSourceTex && (m.metalnessMap === m.aoMap || isSwappedSource2OrmImage(ormSourceTex.image))) {
    const fixed = getFixedOrmTexture(ormSourceTex);
    if (m.metalnessMap === ormSourceTex) m.metalnessMap = fixed;
    if (m.roughnessMap === ormSourceTex) m.roughnessMap = fixed;
    if (m.aoMap === ormSourceTex) m.aoMap = fixed;
  } else {
    if (m.metalnessMap) m.metalnessMap = getFixedOrmTexture(m.metalnessMap);
    if (m.roughnessMap) m.roughnessMap = getFixedOrmTexture(m.roughnessMap);
    if (m.aoMap) m.aoMap = getFixedOrmTexture(m.aoMap);
  }

  if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
      if (m.metalnessMap) {
      m.metalness = isOperatorOrWeapon ? 1.0 : 0.92;
    } else {
      m.metalness = Math.min(m.metalness ?? 0.04, 0.07);
    }
    if (isOperatorOrWeapon) {
      m.roughness = m.roughnessMap ? 0.78 : Math.max(0.24, m.roughness ?? 0.56);
      m.aoMapIntensity = m.aoMap ? 0.78 : 1.0;
      m.envMapIntensity = 1.25;
    } else {
      m.roughness = m.roughnessMap ? 0.96 : Math.max(0.38, m.roughness ?? 0.78);
      m.aoMapIntensity = m.aoMap ? 0.84 : 1.0;
      m.envMapIntensity = m.metalnessMap ? 0.72 : 0.42;
    }
    m.needsUpdate = true;
  }
}

// Reusable scratch math objects for 2-bone analytical IK (zero per-frame allocations)
const _ikA = new THREE.Vector3();
const _ikB = new THREE.Vector3();
const _ikC = new THREE.Vector3();
const _ikT = new THREE.Vector3();
const _ikDir = new THREE.Vector3();
const _ikPole = new THREE.Vector3();
const _ikSide = new THREE.Vector3();
const _ikBend = new THREE.Vector3();
const _ikBTarget = new THREE.Vector3();
const _ikCur = new THREE.Vector3();
const _ikDes = new THREE.Vector3();
const _ikQ = new THREE.Quaternion();
const _ikParentQ = new THREE.Quaternion();
const _ikParentInv = new THREE.Quaternion();
const _ikInvRoot = new THREE.Matrix4();
const _ikRootQ = new THREE.Quaternion();
const _ikRootInvQ = new THREE.Quaternion();
const _ikDeltaQ = new THREE.Quaternion();
const _handBasisM = new THREE.Matrix4();
const _handX = new THREE.Vector3();
const _handY = new THREE.Vector3();
const _handZ = new THREE.Vector3();

// Orient a hand bone so its local (xAxis, yAxis, zAxis) align with desired directions in rigRoot space
function orientBoneToRigAxes(rigRoot, bone, desiredX, desiredY, desiredZ) {
  if (!rigRoot || !bone || !bone.parent) return;
  rigRoot.updateWorldMatrix(true, true);
  _handX.copy(desiredX).normalize();
  _handY.copy(desiredY).normalize();
  _handZ.copy(desiredZ).normalize();
  _handBasisM.makeBasis(_handX, _handY, _handZ);
  _ikQ.setFromRotationMatrix(_handBasisM);
  rigRoot.getWorldQuaternion(_ikRootQ);
  bone.parent.getWorldQuaternion(_ikParentQ);
  _ikParentInv.copy(_ikParentQ).invert();
  bone.quaternion.copy(_ikParentInv).multiply(_ikRootQ).multiply(_ikQ);
}

// Curl Source 2 operator hand fingers into palm (+Z rotates -X->-Y on _R AND +X->+Y on _L)
function curlHandFingers(bones, side = 'R', amount = 1.0) {
  if (!bones) return;
  const s = side === 'R' ? 1 : -1;
  const reset = (n) => {
    const b = bones[n];
    if (b && b.userData.restQuat) b.quaternion.copy(b.userData.restQuat);
    return b;
  };
  for (const finger of ['index', 'middle', 'ring', 'pinky']) {
    const b0 = reset(`finger_${finger}_0_${side}`);
    const b1 = reset(`finger_${finger}_1_${side}`);
    const b2 = reset(`finger_${finger}_2_${side}`);
    const fScale = finger === 'index' ? 0.78 : finger === 'pinky' ? 1.08 : 1.0;
    if (b0) b0.rotation.z += 0.78 * amount * fScale;
    if (b1) b1.rotation.z += 1.02 * amount * fScale;
    if (b2) b2.rotation.z += 0.72 * amount * fScale;
  }
  const t0 = reset(`finger_thumb_0_${side}`);
  const t1 = reset(`finger_thumb_1_${side}`);
  if (t0) {
    t0.rotation.y -= s * 0.42 * amount;
    t0.rotation.z += 0.35 * amount;
  }
  if (t1) t1.rotation.z += 0.48 * amount;
}

// Solve 2-bone limb IK in rigRoot local space by rotating upperBone and lowerBone toward targetLocal
function solveTwoBoneIk(rigRoot, upperBone, lowerBone, endBone, targetLocal, poleDirLocal, bendSign = 1) {
  if (!rigRoot || !upperBone || !lowerBone || !endBone) return;
  rigRoot.updateWorldMatrix(true, true);
  _ikInvRoot.copy(rigRoot.matrixWorld).invert();
  rigRoot.getWorldQuaternion(_ikRootQ);
  _ikRootInvQ.copy(_ikRootQ).invert();

  upperBone.getWorldPosition(_ikA).applyMatrix4(_ikInvRoot);
  lowerBone.getWorldPosition(_ikB).applyMatrix4(_ikInvRoot);
  endBone.getWorldPosition(_ikC).applyMatrix4(_ikInvRoot);

  const l1 = _ikA.distanceTo(_ikB);
  const l2 = _ikB.distanceTo(_ikC);
  if (l1 < 1e-4 || l2 < 1e-4) return;

  _ikDir.subVectors(targetLocal, _ikA);
  const rawDist = _ikDir.length();
  if (rawDist < 1e-4) return;
  _ikDir.divideScalar(rawDist);

  const minD = Math.abs(l1 - l2) + 0.004;
  const maxD = l1 + l2 - 0.004;
  const d = Math.max(minD, Math.min(maxD, rawDist));

  const cosAlpha = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

  _ikPole.copy(poleDirLocal).addScaledVector(_ikDir, -poleDirLocal.dot(_ikDir));
  if (_ikPole.lengthSq() < 1e-6) {
    _ikPole.set(0, 1, 0).addScaledVector(_ikDir, -_ikDir.y);
  }
  _ikPole.normalize().multiplyScalar(bendSign);

  _ikBTarget
    .copy(_ikA)
    .addScaledVector(_ikDir, cosAlpha * l1)
    .addScaledVector(_ikPole, sinAlpha * l1);

  _ikCur.subVectors(_ikB, _ikA).normalize();
  _ikDes.subVectors(_ikBTarget, _ikA).normalize();
  if (_ikCur.dot(_ikDes) > -0.999) {
    _ikQ.setFromUnitVectors(_ikCur, _ikDes);
    if (upperBone.parent) {
      upperBone.parent.getWorldQuaternion(_ikParentQ);
      _ikParentInv.copy(_ikParentQ).invert();
      _ikDeltaQ
        .copy(_ikParentInv)
        .multiply(_ikRootQ)
        .multiply(_ikQ)
        .multiply(_ikRootInvQ)
        .multiply(_ikParentQ);
      upperBone.quaternion.premultiply(_ikDeltaQ);
    }
  }

  rigRoot.updateWorldMatrix(true, true);
  lowerBone.getWorldPosition(_ikB).applyMatrix4(_ikInvRoot);
  endBone.getWorldPosition(_ikC).applyMatrix4(_ikInvRoot);
  _ikT.copy(_ikA).addScaledVector(_ikDir, d);

  _ikCur.subVectors(_ikC, _ikB).normalize();
  _ikDes.subVectors(_ikT, _ikB).normalize();
  if (_ikCur.dot(_ikDes) > -0.999) {
    _ikQ.setFromUnitVectors(_ikCur, _ikDes);
    if (lowerBone.parent) {
      lowerBone.parent.getWorldQuaternion(_ikParentQ);
      _ikParentInv.copy(_ikParentQ).invert();
      _ikDeltaQ
        .copy(_ikParentInv)
        .multiply(_ikRootQ)
        .multiply(_ikQ)
        .multiply(_ikRootInvQ)
        .multiply(_ikParentQ);
      lowerBone.quaternion.premultiply(_ikDeltaQ);
    }
  }
}

function isPlaceholderCheckerboardTexture(tex) {
  const img = tex?.image;
  if (!img || !img.width || !img.height) return false;
  if (img.width > 64 || img.height > 64) return false;
  try {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4) {
      const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`;
      colors.add(key);
      if (colors.size > 6) return false;
    }
    return colors.size <= 6;
  } catch {
    return false;
  }
}

function makeContactShadowTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 3, 32, 32, 30);
  g.addColorStop(0, 'rgba(3, 6, 12, 0.88)');
  g.addColorStop(0.48, 'rgba(4, 8, 15, 0.48)');
  g.addColorStop(1, 'rgba(4, 8, 15, 0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSmokeNoiseTexture() {
  const size = 32;
  const data = new Uint8Array(size ** 3);
  let state = 0x4a596a79;
  for (let i = 0; i < data.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[i] = state & 255;
  }
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RedFormat;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function makeVolumetricSmokeMaterial(noiseTexture) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    uniforms: {
      uOpacity: { value: 0.94 },
      uSunLocal: { value: new THREE.Vector3() },
      uSeed: { value: 0.0 },
      uCameraLocal: { value: new THREE.Vector3() },
      uInside: { value: 0.0 },
      uNoise: { value: noiseTexture },
      uNoiseSize: { value: noiseTexture.image.width },
    },
    vertexShader: `
      varying vec3 vLocalPos;
      void main() {
        vLocalPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      uniform vec3 uSunLocal;
      uniform float uSeed;
      uniform vec3 uCameraLocal;
      uniform float uInside;
      uniform highp sampler3D uNoise;
      uniform float uNoiseSize;
      varying vec3 vLocalPos;

      float noise3(vec3 x) {
        vec3 i = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return texture(uNoise, (i + f + 0.5) / uNoiseSize).r;
      }

      float fbm(vec3 p) {
        float v = 0.0;
        float a = 0.55;
        for (int i = 0; i < 3; i++) {
          v += a * noise3(p);
          p = p * 2.04 + vec3(1.7, 9.2, 4.3);
          a *= 0.48;
        }
        return v;
      }

      void main() {
        vec3 camLocal = uCameraLocal;
        vec3 rd = normalize(vLocalPos - camLocal);

        float t0 = 0.0;
        float t1 = 0.0;
        vec3 ro = vLocalPos;
        if (uInside > 0.5) {
          ro = camLocal;
          t0 = 0.0;
          t1 = min(2.0, length(vLocalPos - camLocal));
        } else {
          // Ray starts at front surface vLocalPos and exits back of unit sphere
          ro = vLocalPos;
          float b = dot(ro, rd);
          t0 = 0.0;
          t1 = max(0.0, -2.0 * b);
        }
        if (t1 <= 0.005) discard;

        vec3 seedVec = vec3(uSeed * 2.13, uSeed * 1.47, uSeed * 3.09);

        float accumAlpha = 0.0;
        vec3 accumColor = vec3(0.0);
        const int STEPS = 8;
        float dt = t1 / float(STEPS);

        for (int i = 0; i < STEPS; i++) {
          float t = (float(i) + 0.5) * dt;
          vec3 p = ro + rd * t;

          // Subtle ground-hugging squash + soft organic silhouette without spherical lobes
          vec3 q = p;
          q.y = (q.y + 0.08) * 1.06;
          float n = fbm(p * 2.35 + seedVec) - 0.5;
          float dist = length(q) + n * 0.19;

          // Dense opaque CS2 smoke core with smooth outer feather
          float density = 1.0 - smoothstep(0.30, 0.95, dist);
          if (density > 0.005) {
            float sunSample = clamp(dot(normalize(p + vec3(0.0, 0.01, 0.0)), uSunLocal) * 0.5 + 0.5, 0.0, 1.0);
            float heightGrad = clamp(p.y * 0.5 + 0.55, 0.0, 1.0);
            vec3 shadowGrey = vec3(0.47, 0.50, 0.55);
            vec3 litGrey = vec3(0.84, 0.87, 0.90);
            vec3 sampleCol = mix(shadowGrey, litGrey, clamp(sunSample * 0.62 + heightGrad * 0.38 + n * 0.14, 0.0, 1.0));

            float stepA = (1.0 - exp(-density * dt * 2.95)) * uOpacity;
            accumColor += (1.0 - accumAlpha) * stepA * sampleCol;
            accumAlpha += (1.0 - accumAlpha) * stepA;
            if (accumAlpha > 0.97) break;
          }
        }

        if (accumAlpha < 0.01) discard;
        gl_FragColor = vec4(accumColor / max(accumAlpha, 0.001), min(0.97, accumAlpha));
      }
    `,
  });
}

function makeAtmosphericSky() {
  const sky = new Sky();
  sky.scale.setScalar(48000);
  const u = sky.material.uniforms;
  u.turbidity.value = 4.2;
  u.rayleigh.value = 1.55;
  u.mieCoefficient.value = 0.0045;
  u.mieDirectionalG.value = 0.82;
  u.sunPosition.value.copy(SUN_DIR).multiplyScalar(10000);
  sky.material.depthWrite = false;
  sky.renderOrder = -20;
  return sky;
}

function bakeSpatialMapAO(aoTargets) {
  if (!aoTargets.length) return;
  const cellSize = 48;
  const occupied = new Set();
  const keyOf = (x, y, z) =>
    `${Math.round(x / cellSize)},${Math.round(y / cellSize)},${Math.round(z / cellSize)}`;

  // Populate coarse 3D spatial occupancy hash from map surface vertices
  for (const { geo } of aoTargets) {
    const pos = geo.attributes.position;
    if (!pos) continue;
    const step = pos.count > 12000 ? 3 : 1;
    for (let i = 0; i < pos.count; i += step) {
      occupied.add(keyOf(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
  }

  // Sample 5 hemisphere offsets along normal to compute Source 2 crevice/corner AO
  for (const { geo, mats } of aoTargets) {
    const pos = geo.attributes.position;
    const norm = geo.attributes.normal;
    if (!pos || !norm) continue;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      const nx = norm.getX(i);
      const ny = norm.getY(i);
      const nz = norm.getZ(i);

      // Build tangent basis around normal
      const tx = Math.abs(nx) < 0.8 ? 1 : 0;
      const ty = Math.abs(nx) < 0.8 ? 0 : 1;
      const tz = 0;
      let bx = ny * tz - nz * ty;
      let by = nz * tx - nx * tz;
      let bz = nx * ty - ny * tx;
      const bl = Math.hypot(bx, by, bz) || 1;
      bx /= bl;
      by /= bl;
      bz /= bl;
      const cx = ny * bz - nz * by;
      const cy = nz * bx - nx * bz;
      const cz = nx * by - ny * bx;

      let occ = 0;
      const r1 = 52;
      const r2 = 104;
      if (occupied.has(keyOf(vx + nx * r1, vy + ny * r1, vz + nz * r1))) occ += 0.25;
      if (occupied.has(keyOf(vx + nx * r2, vy + ny * r2, vz + nz * r2))) occ += 0.2;
      if (occupied.has(keyOf(vx + (nx + bx * 0.7) * r1, vy + (ny + by * 0.7) * r1, vz + (nz + bz * 0.7) * r1))) occ += 0.14;
      if (occupied.has(keyOf(vx + (nx - bx * 0.7) * r1, vy + (ny - by * 0.7) * r1, vz + (nz - bz * 0.7) * r1))) occ += 0.14;
      if (occupied.has(keyOf(vx + (nx + cx * 0.7) * r1, vy + (ny + cy * 0.7) * r1, vz + (nz + cz * 0.7) * r1))) occ += 0.14;
      if (occupied.has(keyOf(vx + (nx - cx * 0.7) * r1, vy + (ny - cy * 0.7) * r1, vz + (nz - cz * 0.7) * r1))) occ += 0.14;

      // Subtle downward-facing/indoor ceiling darkening + crisp Source 2 crevice AO
      const skyBias = ny > 0.3 ? 1.0 : ny < -0.4 ? 0.78 : 0.91;
      const ao = Math.max(0.46, Math.min(1.0, (1.0 - occ * 0.48) * skyBias));
      colors[i * 3] = ao;
      colors[i * 3 + 1] = ao;
      colors[i * 3 + 2] = ao;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    for (const m of mats) {
      m.vertexColors = true;
      m.needsUpdate = true;
    }
  }
}

function bakeSource2ArchitecturalColors(geo, minY, maxY) {
  const pos = geo.attributes?.position;
  if (!pos) return;
  if (!geo.attributes.normal) {
    geo.computeVertexNormals();
  }
  const norm = geo.attributes.normal;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const spanY = Math.max(100, maxY - minY);

  for (let i = 0; i < count; i++) {
    const y = pos.getY(i);
    const ny = norm ? norm.getY(i) : 0;
    const nx = norm ? Math.abs(norm.getX(i)) : 0;
    const hFrac = Math.max(0, Math.min(1, (y - minY) / spanY));

    let r, g, b;
    if (ny > 0.65) {
      // Walkable floor: clean warm Source 2 concrete gray
      const base = 0.44 + hFrac * 0.14;
      r = base * 0.98;
      g = base * 1.0;
      b = base * 1.04;
    } else if (ny < -0.65) {
      // Ceiling underside: darker cool slate
      r = 0.24;
      g = 0.28;
      b = 0.34;
    } else {
      // Vertical walls with subtle directional contrast
      const dirBias = nx * 0.06;
      const base = 0.32 + hFrac * 0.1 + dirBias;
      r = base * 0.88;
      g = base * 0.96;
      b = base * 1.1;
    }
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

export class DemoScene {
  constructor(container, overlayEl, options = {}) {
    this.container = container;
    this.overlayEl = overlayEl;
    this.onCameraStateChange = options.onCameraStateChange || (() => {});
    this.onFrameRender = options.onFrameRender || (() => {});
    this.onQualityChange = options.onQualityChange || (() => {});

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x7ea2c7);
    this.scene.fog = new THREE.FogExp2(0x8faac7, 0.000014);

    const w = Math.max(container.clientWidth || 1280, 320);
    const h = Math.max(container.clientHeight || 720, 240);

    this.camera = new THREE.PerspectiveCamera(75, w / h, 2, 38000);
    this.camera.position.set(0, 1200, 1200);
    this.scene.add(this.camera);

    this.vmCamera = new THREE.PerspectiveCamera(cs2FovToVertical(VIEWMODEL_FOV), w / h, 0.5, 220);
    this.vmScene = new THREE.Scene();

    this.qualitySetting = options.quality || 'auto'; // 'auto' | 'high' | 'medium' | 'low'
    this._frameSampleMs = 0;
    this._frameSampleCount = 0;
    this._fpsLowStreak = 0;
    this.currentFps = 0;
    this.frameMs = 0;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    const gl = this.renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    this.rendererName = (debugInfo && gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) ||
      gl.getParameter(gl.RENDERER) || 'Unknown WebGL renderer';
    this.softwareRenderer = /swiftshader|llvmpipe|softpipe|software (renderer|rasterizer)|microsoft basic render|\bwarp\b/i.test(this.rendererName);
    this.activeQuality = this.qualitySetting === 'auto' ? (this.softwareRenderer ? 'low' : 'high') : this.qualitySetting;
    const preset0 = QUALITY_PRESETS[this.activeQuality] || QUALITY_PRESETS.high;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset0.pixelRatioCap));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = preset0.shadowsEnabled;
    this.renderer.shadowMap.type = preset0.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.container.appendChild(this.renderer.domElement);
    this.playerOutline = new PlayerOutline(this.renderer, CT_XRAY, T_XRAY);

    // Real CS2 skybox texture (equirectangular from materials/skybox/) with Preetham Sky fallback
    this.skyDome = makeAtmosphericSky();
    this.scene.add(this.skyDome);
    this.skyboxTexture = null;
    this.skyboxName = null;
    this.textureLoader = new THREE.TextureLoader();

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const roomEnv = new RoomEnvironment();
    envScene.add(roomEnv);
    envScene.add(makeAtmosphericSky());
    this.envRenderTarget = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = this.envRenderTarget.texture;
    this.scene.environmentIntensity = 0.56;
    this.vmScene.environment = this.envRenderTarget.texture;
    this.vmScene.environmentIntensity = 0.72;
    roomEnv.dispose();
    pmrem.dispose();

    this.contactShadowTex = makeContactShadowTexture();

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxDistance = 11000;
    this.orbit.minDistance = 80;
    this.orbit.enabled = false;

    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    this._meshoptReady = MeshoptDecoder.ready;

    // Calibrated CS2 Source 2 daylight: warm sun key vs neutral-cool sky bounce & crisp GGX highlights
    const hemi = new THREE.HemisphereLight(0xe2edff, 0x4b4742, 0.56);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff1d6, 3.3);
    sun.position.copy(SUN_OFFSET);
    sun.castShadow = true;
    sun.shadow.mapSize.set(preset0.shadowMapSize || 512, preset0.shadowMapSize || 512);
    sun.shadow.camera.near = 200;
    sun.shadow.camera.far = 9600;
    sun.shadow.camera.left = -1600;
    sun.shadow.camera.right = 1600;
    sun.shadow.camera.top = 1600;
    sun.shadow.camera.bottom = -1600;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.42;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sunLight = sun;
    this._lastShadowFocus = new THREE.Vector3(1e9, 1e9, 1e9);
    this._lastShadowMode = null;
    this._lastShadowHalf = 0;
    this._lastShadowTick = -999999;

    const fill = new THREE.DirectionalLight(0xd9e4f2, 0.3);
    fill.position.set(-1800, 1400, -1600);
    this.scene.add(fill);

    const ambient = new THREE.AmbientLight(0x6e737b, 0.18);
    this.scene.add(ambient);

    // Viewmodel pass lighting synced to world sun direction in camera space
    this.vmHemiLight = new THREE.HemisphereLight(0xeaf2ff, 0x4b4742, 0.72);
    this.vmScene.add(this.vmHemiLight);
    this.vmSunLight = new THREE.DirectionalLight(0xfff1d6, 3.05);
    this.vmSunLight.position.set(10, 14, 6);
    this.vmScene.add(this.vmSunLight);
    this.povFillLight = new THREE.PointLight(0xfff7ec, 0.95, 72, 1.0);
    this.povFillLight.position.set(10, 12, 10);
    this.vmScene.add(this.povFillLight);

    // Grid shown only when no map geometry exists (prevents floating grid under maps)
    this.gridHelper = new THREE.GridHelper(6400, 64, 0x334155, 0x222e42);
    this.gridHelper.position.y = -200;
    this.gridHelper.visible = false;
    this.scene.add(this.gridHelper);

    // Ground backdrop plane shown only when CSGEO1/grid fallback is active (hidden under real skyboxes)
    this.groundBackdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(36000, 36000),
      new THREE.MeshBasicMaterial({ color: 0x364457, side: THREE.DoubleSide })
    );
    this.groundBackdrop.rotation.x = -Math.PI / 2;
    this.groundBackdrop.position.y = -1500;
    this.groundBackdrop.visible = false;
    this.scene.add(this.groundBackdrop);

    // Groups
    this.mapGroup = new THREE.Group();
    this.scene.add(this.mapGroup);

    this.playersGroup = new THREE.Group();
    this.scene.add(this.playersGroup);

    this.smokesGroup = new THREE.Group();
    this.scene.add(this.smokesGroup);

    this.grenadesGroup = new THREE.Group();
    this.scene.add(this.grenadesGroup);

    this.infernosGroup = new THREE.Group();
    this.scene.add(this.infernosGroup);

    this.tracersGroup = new THREE.Group();
    this.scene.add(this.tracersGroup);

    this.killMarkersGroup = new THREE.Group();
    this.scene.add(this.killMarkersGroup);

    this._initDynamicPools();

    // C4 Bomb mesh + pulsing beacon for planted state
    this.bombGroup = new THREE.Group();
    this.bombMesh = new THREE.Mesh(
      new THREE.BoxGeometry(15, 7, 11),
      new THREE.MeshStandardMaterial({
        color: 0x334155,
        emissive: 0x1e293b,
        roughness: 0.45,
      })
    );
    this.bombGroup.add(this.bombMesh);
    this.bombLed = new THREE.Mesh(
      new THREE.SphereGeometry(3.4, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2d20 })
    );
    this.bombLed.position.set(0, 4.5, 0);
    this.bombGroup.add(this.bombLed);
    this.bombPulseRing = new THREE.Mesh(
      new THREE.RingGeometry(12, 18, 24),
      new THREE.MeshBasicMaterial({
        color: 0xff3b30,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this.bombPulseRing.rotation.x = -Math.PI / 2;
    this.bombPulseRing.position.y = 1.5;
    this.bombGroup.add(this.bombPulseRing);
    this.bombGroup.visible = false;
    this.scene.add(this.bombGroup);

    // 1st-Person right-hand weapon view-model + first-person operator arms/gloves in depth-cleared vmScene
    this.viewModelGroup = new THREE.Group();
    this.viewModelGroup.visible = false;
    this.vmScene.add(this.viewModelGroup);
    this.povArmsContainer = new THREE.Group();
    this.viewModelGroup.add(this.povArmsContainer);
    this.povArmsRigs = { ct: null, t: null };
    this.activePovArmsTeam = null;
    this.vmRealContainer = new THREE.Group();
    this.viewModelGroup.add(this.vmRealContainer);
    this.currentRealVmKey = null;
    this._buildViewModelMeshes();
    this.currentViewCategory = null;
    this.viewRecoilOffset = 0;
    this.viewInspectPhase = 0;
    this.viewWalkBobPhase = 0;
    this.lastObservedWeaponKey = null;
    this.vmDrawTimer = 0;
    this.vmShotTimer = 0;

    // Official CS2 operator, animation bundle, & weapon GLB caches
    this.ctPlayerTemplate = null;
    this.tPlayerTemplate = null;
    this.operatorClips = new Map();
    this.weaponTemplates = new Map();
    this.weaponLoadsInFlight = new Map();
    this.availableWeaponKeys = new Set();
    this.bombRealModel = null;
    this._deathCam = null;

    // State
    this.cameraMode = 'tactical'; // 'pov' | 'free' | 'tactical'
    this.povSlot = 0;
    this.xray = true;
    this.showTracers = true;

    this.mapBounds = {
      min: [-1500, -200, -1500],
      max: [1500, 600, 1500],
      center: [0, 150, 0],
      triCount: 0,
      source: 'none',
    };

    // Free cam state
    this.freePos = new THREE.Vector3(0, 400, 600);
    this.freeYaw = 0;
    this.freePitch = -0.25;
    this.keysDown = new Set();
    this.dragging = false;
    this.lastPointer = { x: 0, y: 0 };

    // Replay state
    this.roundReplay = null;
    this.playersMeta = [];
    this.metaBySlot = new Map();
    this.roundTeams = new Map();
    this.currentTick = 0;
    this.playing = false;
    this.playbackSpeed = 1;
    this.lastRafTs = 0;

    // Player meshes & custom template
    this.playerRigs = [];
    this.rigBySlot = new Map();
    this.customPlayerTemplate = null;

    this._bindEvents();
    this._startLoop();
  }

  _buildViewModelMeshes() {
    this.vmMeshes = {};
    const gunMetal = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.34, metalness: 0.62 });
    const darkGrip = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.68, metalness: 0.22 });
    const woodStock = new THREE.MeshStandardMaterial({ color: 0x8a5229, roughness: 0.65, metalness: 0.05 });
    const polymer = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.5, metalness: 0.25 });
    const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x2b3648, roughness: 0.85 });
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.2, metalness: 0.9 });
    const scopeMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.28, metalness: 0.72 });

    const makeArm = (g) => {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2.1, 2.0, 8.5), sleeveMat);
      arm.position.set(1.2, -1.9, 3.4);
      g.add(arm);
    };

    // Rifle (AK/M4 silhouette: stock + receiver + handguard + angled curved mag + barrel + front sight)
    const rifle = new THREE.Group();
    makeArm(rifle);
    const rStock = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.8, 4.2), woodStock);
    rStock.position.set(0, -0.35, 3.6);
    const rRec = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.5, 6.2), gunMetal);
    rRec.position.set(0, 0.1, -1.4);
    const rGuard = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.25, 4.8), woodStock);
    rGuard.position.set(0, 0.12, -6.8);
    const rBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 5.2, 8), darkGrip);
    rBarrel.rotation.x = Math.PI / 2;
    rBarrel.position.set(0, 0.25, -11.4);
    const rSight = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 0.35), darkGrip);
    rSight.position.set(0, 0.7, -11.5);
    const rMag1 = new THREE.Mesh(new THREE.BoxGeometry(0.85, 2.4, 1.4), darkGrip);
    rMag1.position.set(0, -1.5, -3.2);
    rMag1.rotation.x = 0.22;
    const rMag2 = new THREE.Mesh(new THREE.BoxGeometry(0.82, 1.8, 1.35), darkGrip);
    rMag2.position.set(0, -3.1, -3.9);
    rMag2.rotation.x = 0.46;
    const rGrip = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.9, 1.1), woodStock);
    rGrip.position.set(0, -1.3, 0.5);
    rGrip.rotation.x = -0.3;
    rifle.add(rStock, rRec, rGuard, rBarrel, rSight, rMag1, rMag2, rGrip);
    this.vmMeshes.rifle = rifle;

    // SMG (compact receiver + vertical stick mag + stubby barrel)
    const smg = new THREE.Group();
    makeArm(smg);
    const smgRec = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.6, 7.0), polymer);
    smgRec.position.set(0, 0.1, -2.2);
    const smgBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 3.6, 8), darkGrip);
    smgBarrel.rotation.x = Math.PI / 2;
    smgBarrel.position.set(0, 0.2, -7.2);
    const smgMag = new THREE.Mesh(new THREE.BoxGeometry(0.75, 3.6, 1.0), darkGrip);
    smgMag.position.set(0, -2.0, -3.4);
    smg.add(smgRec, smgBarrel, smgMag);
    this.vmMeshes.smg = smg;

    // Heavy / Shotgun
    const heavy = new THREE.Group();
    makeArm(heavy);
    const hBody = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.7, 8.2), darkGrip);
    hBody.position.set(0, 0, -2.5);
    const hPump = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.3, 4.2), polymer);
    hPump.position.set(0, -0.35, -7.8);
    const hBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 8.5, 8), gunMetal);
    hBarrel.rotation.x = Math.PI / 2;
    hBarrel.position.set(0, 0.38, -9.8);
    heavy.add(hBody, hPump, hBarrel);
    this.vmMeshes.heavy = heavy;

    // Sniper (long barrel + scope + scope rings + cheek rest)
    const sniper = new THREE.Group();
    makeArm(sniper);
    const sStock = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.9, 10.5), polymer);
    sStock.position.set(0, -0.1, -1.8);
    const sBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 12.0, 10), darkGrip);
    sBarrel.rotation.x = Math.PI / 2;
    sBarrel.position.set(0, 0.35, -12.2);
    const sScope = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 6.8, 12), scopeMat);
    sScope.rotation.x = Math.PI / 2;
    sScope.position.set(0, 1.48, -2.6);
    const sBell = new THREE.Mesh(new THREE.CylinderGeometry(0.74, 0.58, 1.8, 12), scopeMat);
    sBell.rotation.x = Math.PI / 2;
    sBell.position.set(0, 1.48, -6.4);
    sniper.add(sStock, sBarrel, sScope, sBell);
    this.vmMeshes.sniper = sniper;

    // Pistol (slide + frame + trigger guard + angled grip)
    const pistol = new THREE.Group();
    makeArm(pistol);
    const pSlide = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.9, 5.4), gunMetal);
    pSlide.position.set(0, 0.45, -3.2);
    const pFrame = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.55, 4.8), polymer);
    pFrame.position.set(0, -0.18, -2.9);
    const pGrip = new THREE.Mesh(new THREE.BoxGeometry(0.86, 2.5, 1.3), darkGrip);
    pGrip.position.set(0, -1.4, -1.1);
    pGrip.rotation.x = 0.28;
    pistol.add(pSlide, pFrame, pGrip);
    this.vmMeshes.pistol = pistol;

    // Knife
    const knife = new THREE.Group();
    makeArm(knife);
    const kHandle = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.88, 3.2), darkGrip);
    kHandle.position.set(0, -0.45, -2.5);
    const kGuard = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.4, 0.35), darkGrip);
    kGuard.position.set(0, -0.35, -4.1);
    const kBlade = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.95, 5.2), bladeMat);
    kBlade.position.set(0, -0.15, -6.7);
    knife.add(kHandle, kGuard, kBlade);
    this.vmMeshes.knife = knife;

    // Grenade
    const grenade = new THREE.Group();
    makeArm(grenade);
    const gBody = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 2.8, 10),
      new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.45, metalness: 0.4 })
    );
    gBody.position.set(0, -0.4, -3.5);
    const gCap = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.7, 8), darkGrip);
    gCap.position.set(0, 1.25, -3.5);
    grenade.add(gBody, gCap);
    this.vmMeshes.grenade = grenade;

    // C4
    const c4 = new THREE.Group();
    makeArm(c4);
    const c4Box = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 1.6, 2.4),
      new THREE.MeshStandardMaterial({ color: 0x3f4c5e, roughness: 0.5 })
    );
    c4Box.position.set(0, -0.6, -4.0);
    const c4Screen = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.2, 1.0),
      new THREE.MeshBasicMaterial({ color: 0x4ade80 })
    );
    c4Screen.position.set(0, 0.25, -4.0);
    c4.add(c4Box, c4Screen);
    this.vmMeshes.c4 = c4;

    this.vmMuzzleFlash = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.4, 0),
      new THREE.MeshBasicMaterial({ color: 0xfde047, transparent: true, opacity: 0.9 })
    );
    this.vmMuzzleFlash.position.set(0, 0.4, -15);
    this.vmMuzzleFlash.visible = false;
    this.viewModelGroup.add(this.vmMuzzleFlash);

    for (const m of Object.values(this.vmMeshes)) {
      m.visible = false;
      this.viewModelGroup.add(m);
    }
  }

  _bindEvents() {
    this._onVisibilityChange = () => {
      this.lastRafTs = 0;
      this._frameSampleMs = 0;
      this._frameSampleCount = 0;
      this._fpsLowStreak = 0;
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    this._onResize = () => {
      const w = Math.max(this.container.clientWidth || 1, 1);
      const h = Math.max(this.container.clientHeight || 1, 1);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this.vmCamera) {
        this.vmCamera.aspect = w / h;
        this.vmCamera.updateProjectionMatrix();
      }
      this.renderer.setSize(w, h);
    };
    this._resizeObserver = new ResizeObserver(this._onResize);
    this._resizeObserver.observe(this.container);

    const dom = this.renderer.domElement;
    this._onMouseDown = (e) => {
      if (this.cameraMode !== 'free') return;
      this.dragging = true;
      this.lastPointer = { x: e.clientX, y: e.clientY };
    };
    this._onMouseMove = (e) => {
      if (this.cameraMode !== 'free') return;
      if (document.pointerLockElement === dom) {
        this.freeYaw -= e.movementX * 0.0024;
        this.freePitch = Math.max(-1.48, Math.min(1.48, this.freePitch - e.movementY * 0.0024));
      } else if (this.dragging) {
        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.lastPointer = { x: e.clientX, y: e.clientY };
        this.freeYaw -= dx * 0.004;
        this.freePitch = Math.max(-1.48, Math.min(1.48, this.freePitch - dy * 0.004));
      }
    };
    this._onMouseUp = () => {
      this.dragging = false;
    };
    this._onDblClick = () => {
      if (this.cameraMode === 'free' && dom.requestPointerLock) {
        try {
          dom.requestPointerLock();
        } catch {
          // ignore
        }
      }
    };
    this._onKeyDown = (e) => {
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      this.keysDown.add(e.code);
      if (e.code === 'KeyI' && this.cameraMode === 'pov') {
        this.viewInspectPhase = 1.0;
      }
    };
    this._onKeyUp = (e) => {
      this.keysDown.delete(e.code);
    };

    dom.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
    dom.addEventListener('dblclick', this._onDblClick);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  dispose() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this._resizeObserver.disconnect();
    const dom = this.renderer.domElement;
    dom.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    dom.removeEventListener('dblclick', this._onDblClick);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.orbit.dispose();
    if (this.skyboxTexture) this.skyboxTexture.dispose();
    if (this.envRenderTarget) this.envRenderTarget.dispose();
    this._smokeNoiseTexture?.dispose();
    this.playerOutline.dispose();
    this.renderer.dispose();
    if (dom.parentNode) dom.parentNode.removeChild(dom);
    if (typeof window !== 'undefined') {
      window.__CS2_VIEWER__ = null;
      if (window.__CS2_SCENE__ === this) window.__CS2_SCENE__ = null;
    }
  }

  async setMapSkybox(skyboxUrl) {
    if (!skyboxUrl) {
      if (this.skyboxTexture) {
        this.skyboxTexture.dispose();
        this.skyboxTexture = null;
      }
      this.skyboxName = null;
      this.scene.background = new THREE.Color(0x7ea2c7);
      if (this.skyDome) this.skyDome.visible = true;
      return false;
    }
    try {
      const tex = await this.textureLoader.loadAsync(skyboxUrl);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;

      if (this.skyboxTexture) this.skyboxTexture.dispose();
      this.skyboxTexture = tex;
      this.skyboxName = decodeURIComponent(skyboxUrl.split('/').pop() || '');
      this.scene.background = tex;
      if (this.skyDome) this.skyDome.visible = false;

      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const nextEnv = pmrem.fromEquirectangular(tex);
      if (this.envRenderTarget) this.envRenderTarget.dispose();
      this.envRenderTarget = nextEnv;
      this.scene.environment = nextEnv.texture;
      if (this.vmScene) this.vmScene.environment = nextEnv.texture;
      pmrem.dispose();
      return true;
    } catch (err) {
      console.warn('Failed to load CS2 skybox, falling back to procedural sky:', err);
      if (this.skyDome) this.skyDome.visible = true;
      return false;
    }
  }

  async _loadGlb(url) {
    if (this._meshoptReady) {
      await this._meshoptReady;
    }
    return this.gltfLoader.loadAsync(url);
  }

  _initDynamicPools() {
    // 1. Pooled single-mesh raymarched volumetric smokes (smooth grey-white CS2 cloud, <= 144u radius)
    this._smokeSphereGeo = new THREE.SphereGeometry(1, 32, 24);
    this._smokeRingGeo = new THREE.RingGeometry(0.96, 1.0, 32);
    this._smokePool = [];

    // 2. Instanced infernos (2 draw calls total for up to 256 molotov fire tiles)
    const MAX_FIRE = 256;
    this._infernoPatchGeo = new THREE.CircleGeometry(36, 10);
    this._infernoPatchGeo.rotateX(-Math.PI / 2);
    this._infernoPatchMat = new THREE.MeshBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this._infernoPatches = new THREE.InstancedMesh(this._infernoPatchGeo, this._infernoPatchMat, MAX_FIRE);
    this._infernoPatches.count = 0;
    this._infernoPatches.frustumCulled = false;
    this._infernoPatches.renderOrder = 17;
    this.infernosGroup.add(this._infernoPatches);

    this._infernoFlameGeo = new THREE.ConeGeometry(18, 42, 6);
    this._infernoFlameMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
      depthWrite: false,
    });
    this._infernoFlames = new THREE.InstancedMesh(this._infernoFlameGeo, this._infernoFlameMat, MAX_FIRE);
    this._infernoFlames.count = 0;
    this._infernoFlames.frustumCulled = false;
    this._infernoFlames.renderOrder = 17;
    this.infernosGroup.add(this._infernoFlames);

    // 3. Batched shot tracers (single LineSegments draw call, preallocated Float32 buffers)
    const MAX_TRACERS = 64;
    this._tracerPositions = new Float32Array(MAX_TRACERS * 6);
    this._tracerColors = new Float32Array(MAX_TRACERS * 6);
    this._tracerGeo = new THREE.BufferGeometry();
    this._tracerPosAttr = new THREE.BufferAttribute(this._tracerPositions, 3);
    this._tracerPosAttr.setUsage(THREE.DynamicDrawUsage);
    this._tracerColAttr = new THREE.BufferAttribute(this._tracerColors, 3);
    this._tracerColAttr.setUsage(THREE.DynamicDrawUsage);
    this._tracerGeo.setAttribute('position', this._tracerPosAttr);
    this._tracerGeo.setAttribute('color', this._tracerColAttr);
    this._tracerGeo.setDrawRange(0, 0);
    this._tracerLines = new THREE.LineSegments(
      this._tracerGeo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
      })
    );
    this._tracerLines.frustumCulled = false;
    this.tracersGroup.add(this._tracerLines);

    // 4. Pooled grenade trajectories, models, and blast/burst spheres
    this._grenadeSphereGeo = new THREE.SphereGeometry(1, 12, 10);
    this._grenadeRingGeo = new THREE.RingGeometry(12, 22, 16);
    this._grenadePool = [];
    this._grenadeModelCache = new Map();

    // 5. Pooled kill markers (shared OctahedronGeometry)
    this._killGeo = new THREE.OctahedronGeometry(12, 0);
    this._killPool = [];

    this._activeSmokeCount = 0;
    this._activeGrenadeCount = 0;
    this._activeInfernoCount = 0;
    this._activeTracerCount = 0;
  }

  _getSmokePoolItem(idx) {
    while (this._smokePool.length <= idx) {
      const cluster = new THREE.Group();
      this._smokeNoiseTexture ??= makeSmokeNoiseTexture();
      const smokeMat = makeVolumetricSmokeMaterial(this._smokeNoiseTexture);
      smokeMat.uniforms.uSeed.value = (idx + 1) * 1.37;
      const volumeMesh = new THREE.Mesh(this._smokeSphereGeo, smokeMat);
      volumeMesh.renderOrder = 8;
      volumeMesh.frustumCulled = false;
      cluster.add(volumeMesh);

      cluster.visible = false;
      this.smokesGroup.add(cluster);
      this._smokePool.push({ cluster, smokeMat, volumeMesh });
    }
    return this._smokePool[idx];
  }

  _getGrenadePoolItem(idx) {
    while (this._grenadePool.length <= idx) {
      const group = new THREE.Group();
      const maxPts = 256;
      const lineArr = new Float32Array(maxPts * 3);
      const lineGeo = new THREE.BufferGeometry();
      const lineAttr = new THREE.BufferAttribute(lineArr, 3);
      lineAttr.setUsage(THREE.DynamicDrawUsage);
      lineGeo.setAttribute('position', lineAttr);
      lineGeo.setDrawRange(0, 0);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xfef08a, transparent: true, opacity: 0.82 });
      const line = new THREE.Line(lineGeo, lineMat);
      line.frustumCulled = false;
      group.add(line);

      const orbMat = new THREE.MeshBasicMaterial({ color: 0xfef08a, transparent: true, opacity: 0.8 });
      const orb = new THREE.Mesh(this._grenadeSphereGeo, orbMat);
      group.add(orb);

      const blastMat = new THREE.MeshBasicMaterial({
        color: 0xf97316,
        transparent: true,
        opacity: 0.7,
        depthTest: true,
        depthWrite: false,
      });
      const blast = new THREE.Mesh(this._grenadeSphereGeo, blastMat);
      blast.renderOrder = 21;
      group.add(blast);

      const pulseMat = new THREE.MeshBasicMaterial({
        color: 0xc084fc,
        transparent: true,
        opacity: 0.78,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const pulse = new THREE.Mesh(this._grenadeRingGeo, pulseMat);
      pulse.rotation.x = -Math.PI / 2;
      group.add(pulse);

      const modelAnchor = new THREE.Group();
      group.add(modelAnchor);

      group.visible = false;
      this.grenadesGroup.add(group);
      this._grenadePool.push({
        group,
        line,
        lineArr,
        lineAttr,
        lineGeo,
        lineMat,
        maxPts,
        orb,
        orbMat,
        blast,
        blastMat,
        pulse,
        pulseMat,
        modelAnchor,
        attachedKey: null,
      });
    }
    return this._grenadePool[idx];
  }

  _getKillPoolItem(idx) {
    while (this._killPool.length <= idx) {
      const mat = new THREE.MeshBasicMaterial({
        color: CT_COLOR,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      });
      const mesh = new THREE.Mesh(this._killGeo, mat);
      mesh.renderOrder = 25;
      mesh.visible = false;
      this.killMarkersGroup.add(mesh);
      this._killPool.push({ mesh, mat });
    }
    return this._killPool[idx];
  }

  setQuality(mode = 'auto') {
    const valid = mode === 'auto' || QUALITY_PRESETS[mode] ? mode : 'auto';
    this.qualitySetting = valid;
    const target = valid === 'auto' ? (this.softwareRenderer ? 'low' : 'high') : valid;
    this._frameSampleMs = 0;
    this._frameSampleCount = 0;
    this._fpsLowStreak = 0;
    this._applyQualityPreset(target);
  }

  _applyQualityPreset(presetId) {
    const preset = QUALITY_PRESETS[presetId] || QUALITY_PRESETS.medium;
    this.activeQuality = preset.id;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.pixelRatioCap));
    const w = Math.max(this.container.clientWidth || 1, 1);
    const h = Math.max(this.container.clientHeight || 1, 1);
    this.renderer.setSize(w, h, false);

    this.renderer.shadowMap.enabled = !!preset.shadowsEnabled;
    this.renderer.shadowMap.type = preset.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (this.sunLight && preset.shadowMapSize > 0) {
      this.sunLight.castShadow = true;
      if (
        this.sunLight.shadow.mapSize.x !== preset.shadowMapSize ||
        this.sunLight.shadow.mapSize.y !== preset.shadowMapSize
      ) {
        this.sunLight.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
        if (this.sunLight.shadow.map) {
          this.sunLight.shadow.map.dispose();
          this.sunLight.shadow.map = null;
        }
      }
    } else if (this.sunLight) {
      this.sunLight.castShadow = false;
    }

    // Apply detail LOD + AO toggle across loaded map meshes
    this.mapGroup.traverse((obj) => {
      if (!obj.isMesh) return;
      const lvl = obj.userData.detailLevel ?? 0;
      obj.visible = lvl <= preset.maxDetailLevel;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.userData.hasBakedAo) {
          const wantVc = !!preset.aoEnabled;
          if (m.vertexColors !== wantVc) {
            m.vertexColors = wantVc;
            m.needsUpdate = true;
          }
        }
      }
    });

    this.sunLight.shadow.needsUpdate = true;
    this.renderer.shadowMap.needsUpdate = true;
    this.onQualityChange({
      setting: this.qualitySetting,
      active: this.activeQuality,
      fps: Math.round(this.currentFps),
    });
  }

  _configurePbrObject(
    root,
    {
      hideFirstPerson = false,
      onlyFirstPerson = false,
      showDefuser = false,
      castShadow = true,
      receiveShadow = true,
      isOperatorOrWeapon = true,
    } = {}
  ) {
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      const name = (obj.name || '').toLowerCase();
      if (onlyFirstPerson) {
        // Hide bare_arm_133 only on sleeved CT operators (SAS has full sleeves down to glove cuff);
        // keep bare forearms visible on sleeveless T operators (Phoenix) so wrists connect cleanly to cuffs.
        const isBareArm = name.includes('bare_arm') || (obj.material?.name || '').toLowerCase().includes('bare_arm');
        const hasFullSleeve = name.includes('ctm_sas') && isBareArm;
        obj.visible = name.includes('firstperson_') && !hasFullSleeve;
      } else if (hideFirstPerson && name.includes('firstperson_')) {
        obj.visible = false;
      }
      if (name.includes('defusekit')) {
        obj.visible = !!showDefuser && !onlyFirstPerson;
      }
      // SkinnedMesh bind-pose bounding boxes come from quantized unskinned coords, so disable frustum culling
      if (obj.isSkinnedMesh || onlyFirstPerson) {
        obj.frustumCulled = false;
      }
      obj.castShadow = !!castShadow;
      obj.receiveShadow = !!receiveShadow;
      const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
      for (const m of mats) {
        fixSource2OrmMaterial(m, { isOperatorOrWeapon });
      }
    });
  }

  async loadMapGeometry(mapName, { customGlbUrl = null, meshBuffer = null, skyboxUrl = null } = {}) {
    while (this.mapGroup.children.length > 0) {
      const child = this.mapGroup.children.pop();
      child.traverse?.((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    }

    const skyboxPromise = this.setMapSkybox(skyboxUrl);
    const parsedRef = meshBuffer ? parseCsmsh1(meshBuffer) : null;

    if (customGlbUrl) {
      try {
        const gltf = await this._loadGlb(customGlbUrl);
        const root = gltf.scene;
        const rawBox = new THREE.Box3().setFromObject(root);
        const t = detectGlbTransform(
          [rawBox.min.x, rawBox.min.y, rawBox.min.z],
          [rawBox.max.x, rawBox.max.y, rawBox.max.z],
          parsedRef?.minThree || null,
          parsedRef?.maxThree || null
        );

        const holder = new THREE.Group();
        holder.rotation.set(t.rotX, t.rotY, t.rotZ);
        holder.scale.setScalar(t.scale);
        holder.add(root);
        holder.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(holder);
        const center = new THREE.Vector3();
        box.getCenter(center);

        const localMinY = rawBox.min.y;
        const localMaxY = rawBox.max.y;

        let triCount = 0;
        let texturedCount = 0;
        let placeholderCount = 0;
        const bakedGroup = new THREE.Group();
        const aoTargets = [];
        const dedupedMatCache = new Map();
        const mergeBuckets = new Map();
        const unmergedEntries = [];

        const matSignature = (m, isArch) => {
          if (isArch) return 'arch_vertex_colors';
          const texSig = (t) => {
            if (!t) return '';
            const im = t.image;
            return t.name || (im && im.src) || t.uuid;
          };
          return [
            texSig(m.map),
            texSig(m.normalMap),
            texSig(m.metalnessMap),
            texSig(m.aoMap),
            m.transparent ? 'T' : 'O',
            m.alphaTest || 0,
            m.side,
            m.color ? m.color.getHexString() : 'ffffff',
          ].join('|');
        };

        const classifyDetailLevel = (meshName, matNames, diag, tris, anyTransparent, anySkyOrGlass) => {
          const joined = `${meshName} ${matNames.join(' ')}`.toLowerCase();
          if (anySkyOrGlass) return 0; // keep skybox vista & skylights visible at all presets
          if (
            /wire|chainlink|web_joist|dogwood|poplar|foliage|branch|leaf|leaves|shrub|grass|cable|decal|scuff|caustic|overlay|sign_sheet|display|extinguisher|btr_01_tires|ammo_artillery/.test(
              joined
            )
          ) {
            return 2;
          }
          if (/trim|vent|railing|pipe_kit|metal_pipe/.test(joined) && tris > 18000) {
            return 2;
          }
          if (diag < 180 && tris > 350) return 2;
          if (
            /pipe|airduct|hvac|railing|ladder|crate|barrel|barrier|bollard|btr|trim|vent|lamp|light|frame|prop_/.test(
              joined
            ) ||
            diag < 380
          ) {
            return 1;
          }
          if (anyTransparent && diag < 260) return 2;
          return 0;
        };

        root.traverse((obj) => {
          if (!obj.isMesh || !obj.geometry) return;
          obj.updateWorldMatrix(true, false);
          const oldGeo = obj.geometry;
          const idx = oldGeo.index;
          const pos = oldGeo.attributes?.position;
          if (!pos) return;
          const meshTris = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
          triCount += meshTris;

          // Deinterleave & bake world transform into clean Float32 BufferGeometry
          // so meshopt-quantized Int16 attributes + large node scales do not overflow normalMatrix/shaders.
          const newGeo = new THREE.BufferGeometry();
          if (idx) newGeo.setIndex(idx.clone());
          for (const attrName of ['position', 'normal', 'uv', 'uv1', 'uv2']) {
            const attr = oldGeo.attributes[attrName];
            if (!attr) continue;
            const arr = new Float32Array(attr.count * attr.itemSize);
            for (let i = 0; i < attr.count; i++) {
              arr[i * attr.itemSize] = attr.getX(i);
              if (attr.itemSize > 1) arr[i * attr.itemSize + 1] = attr.getY(i);
              if (attr.itemSize > 2) arr[i * attr.itemSize + 2] = attr.getZ(i);
            }
            newGeo.setAttribute(attrName, new THREE.BufferAttribute(arr, attr.itemSize, false));
          }
          newGeo.applyMatrix4(obj.matrixWorld);
          if (!newGeo.attributes.normal) {
            newGeo.computeVertexNormals();
          }
          newGeo.computeBoundingBox();
          newGeo.computeBoundingSphere();

          const bb = newGeo.boundingBox;
          const diag = bb
            ? Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z)
            : 500;

          const rawMats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
          const outMats = [];
          const matNames = [];
          let anyPlaceholder = false;
          let anyTransparent = false;
          let anySkyOrGlass = false;
          for (let mi = 0; mi < rawMats.length; mi++) {
            const m = rawMats[mi];
            const mName = (m.name || '').toLowerCase();
            if (/_additive$|steam_\d+/.test(mName)) {
              anySkyOrGlass = true;
            }
            matNames.push(mName);
            if (/sky|glass|window|water/.test(mName)) anySkyOrGlass = true;
            const hasTex = !!m.map;
            const isPlaceholder = hasTex && isPlaceholderCheckerboardTexture(m.map);
            if (hasTex && !isPlaceholder) texturedCount++;
            if (isPlaceholder) {
              anyPlaceholder = true;
              placeholderCount++;
              if (m.map) {
                m.map.dispose();
                m.map = null;
              }
              bakeSource2ArchitecturalColors(newGeo, box.min.y, box.max.y);
              const archKey = 'arch_vertex_colors';
              let archMat = dedupedMatCache.get(archKey);
              if (!archMat) {
                archMat = new THREE.MeshStandardMaterial({
                  vertexColors: true,
                  roughness: 0.82,
                  metalness: 0.06,
                  side: THREE.DoubleSide,
                });
                dedupedMatCache.set(archKey, archMat);
              }
              outMats.push(archMat);
              m.dispose();
            } else {
              const origDoubleSided = m.side === THREE.DoubleSide;
              fixSource2OrmMaterial(m, { isOperatorOrWeapon: false });
              if (m.transparent) anyTransparent = true;
              m.userData.origDoubleSided = origDoubleSided;
              m.side = origDoubleSided ? THREE.DoubleSide : THREE.FrontSide;
              m.vertexColors = false;
              m.needsUpdate = true;
              const sig = matSignature(m, false);
              let sharedMat = dedupedMatCache.get(sig);
              if (!sharedMat) {
                sharedMat = m;
                dedupedMatCache.set(sig, sharedMat);
              } else {
                m.dispose();
              }
              outMats.push(sharedMat);
            }
          }

          const detailLevel = classifyDetailLevel(
            obj.name || '',
            matNames,
            diag,
            meshTris,
            anyTransparent,
            anySkyOrGlass
          );
          if (matNames.some((n) => /_additive$|steam_\d+/.test(n))) {
            newGeo.dispose();
            return;
          }
          const canCastShadow =
            !anyTransparent && !anySkyOrGlass && detailLevel <= 1 && diag >= 85;
          const canReceiveShadow = !anySkyOrGlass;
          const canBakeAo = !anyPlaceholder && !anyTransparent && !anySkyOrGlass;

          // Merge single-material non-grouped meshes sharing identical material, shadow flags, and detail tier
          if (outMats.length === 1 && !oldGeo.groups?.length) {
            const mat = outMats[0];
            const attrSig = Object.keys(newGeo.attributes).sort().join(',');
            const bucketKey = `${mat.uuid}|${detailLevel}|${canCastShadow ? 1 : 0}|${canReceiveShadow ? 1 : 0}|${canBakeAo ? 1 : 0}|${attrSig}|${newGeo.index ? 'I' : 'N'}`;
            let bucket = mergeBuckets.get(bucketKey);
            if (!bucket) {
              bucket = {
                mat,
                detailLevel,
                canCastShadow,
                canReceiveShadow,
                canBakeAo,
                geos: [],
                name: obj.name || mat.name || 'merged_map',
              };
              mergeBuckets.set(bucketKey, bucket);
            }
            bucket.geos.push(newGeo);
          } else {
            unmergedEntries.push({
              geo: newGeo,
              mats: outMats,
              groups: oldGeo.groups ? oldGeo.groups.map((g) => ({ ...g })) : null,
              detailLevel,
              canCastShadow,
              canReceiveShadow,
              canBakeAo,
              name: obj.name,
            });
          }
          oldGeo.dispose();
        });

        for (const bucket of mergeBuckets.values()) {
          let mergedGeo;
          if (bucket.geos.length === 1) {
            mergedGeo = bucket.geos[0];
          } else {
            mergedGeo = mergeGeometries(bucket.geos, false);
            for (const g of bucket.geos) g.dispose();
            if (!mergedGeo) continue;
            mergedGeo.computeBoundingBox();
            mergedGeo.computeBoundingSphere();
          }
          if (bucket.canBakeAo) {
            aoTargets.push({ geo: mergedGeo, mats: [bucket.mat] });
          }
          const cleanMesh = new THREE.Mesh(mergedGeo, bucket.mat);
          cleanMesh.name = bucket.name;
          cleanMesh.castShadow = bucket.canCastShadow;
          cleanMesh.receiveShadow = bucket.canReceiveShadow;
          cleanMesh.userData.detailLevel = bucket.detailLevel;
          bakedGroup.add(cleanMesh);
        }

        for (const entry of unmergedEntries) {
          if (entry.groups?.length) {
            for (const g of entry.groups) {
              entry.geo.addGroup(g.start, g.count, g.materialIndex);
            }
          }
          if (entry.canBakeAo) {
            aoTargets.push({ geo: entry.geo, mats: entry.mats });
          }
          const finalMat = entry.mats.length === 1 ? entry.mats[0] : entry.mats;
          const cleanMesh = new THREE.Mesh(entry.geo, finalMat);
          cleanMesh.name = entry.name;
          cleanMesh.castShadow = entry.canCastShadow;
          cleanMesh.receiveShadow = entry.canReceiveShadow;
          cleanMesh.userData.detailLevel = entry.detailLevel;
          bakedGroup.add(cleanMesh);
        }

        bakeSpatialMapAO(aoTargets);
        for (const { mats } of aoTargets) {
          for (const m of mats) {
            if (m) m.userData.hasBakedAo = true;
          }
        }
        this.mapGroup.add(bakedGroup);
        this.mapBounds = {
          min: [box.min.x, box.min.y, box.min.z],
          max: [box.max.x, box.max.y, box.max.z],
          center: [center.x, center.y, center.z],
          triCount,
          source: 'custom_glb',
          glbTransform: t.name,
          glbShading: texturedCount > 0 ? 'textured' : placeholderCount > 0 ? 'source2_architectural' : 'pbr_untextured',
        };
        this.gridHelper.visible = false;
        this.groundBackdrop.visible = false;
        this._applyQualityPreset(this.activeQuality);
        this.resetTacticalCamera();
        this._updateSunShadowFrustum(true);
        await skyboxPromise;
        return this.mapBounds;
      } catch (err) {
        console.warn('Failed to load custom map GLB, falling back to CSGEO1:', err);
      }
    }

    if (parsedRef) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(parsedRef.positions, 3));
      geo.computeVertexNormals();
      geo.computeBoundingBox();

      const mat = new THREE.MeshStandardMaterial({
        color: 0x6b7f99,
        emissive: 0x162030,
        roughness: 0.78,
        metalness: 0.08,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geo, mat);
      this.mapGroup.add(mesh);

      const edgesGeo = new THREE.EdgesGeometry(geo, 28);
      const edgesMat = new THREE.LineBasicMaterial({
        color: 0xa2b9d4,
        transparent: true,
        opacity: 0.24,
      });
      this.mapGroup.add(new THREE.LineSegments(edgesGeo, edgesMat));

      this.mapBounds = {
        min: parsedRef.minThree,
        max: parsedRef.maxThree,
        center: parsedRef.centerThree,
        triCount: parsedRef.triCount,
        source: 'csgeo1',
      };
      this.gridHelper.visible = false;
      this.groundBackdrop.visible = !this.skyboxTexture;
      this.groundBackdrop.position.y = parsedRef.minThree[1] - 6;
      this.resetTacticalCamera();
      await skyboxPromise;
      return this.mapBounds;
    }

    this.mapBounds = {
      min: [-1500, -200, -1500],
      max: [1500, 600, 1500],
      center: [0, 120, 0],
      triCount: 0,
      source: 'grid_only',
    };
    this.gridHelper.visible = true;
    this.gridHelper.position.y = -200;
    this.groundBackdrop.visible = !this.skyboxTexture;
    this.groundBackdrop.position.y = -210;
    this.resetTacticalCamera();
    await skyboxPromise;
    return this.mapBounds;
  }

  async loadCustomPlayerModel(url) {
    if (!url) {
      this.customPlayerTemplate = null;
      this._rebuildPlayerRigs();
      return;
    }
    try {
      const gltf = await this._loadGlb(url);
      this.customPlayerTemplate = gltf.scene;
      this._rebuildPlayerRigs();
    } catch (err) {
      console.warn('Failed to load custom player GLB:', err);
      this.customPlayerTemplate = null;
    }
  }

  async _loadWeaponTemplate(key) {
    if (!key) return null;
    if (this.weaponTemplates.has(key)) return this.weaponTemplates.get(key);
    if (this.availableWeaponKeys.size > 0 && !this.availableWeaponKeys.has(key)) return null;
    if (this.weaponLoadsInFlight.has(key)) return this.weaponLoadsInFlight.get(key);

    const p = this._loadGlb(`/api/assets/weapons/${encodeURIComponent(key)}`)
      .then((gltf) => {
        this._configurePbrObject(gltf.scene);
        gltf.scene.updateMatrixWorld(true);
        let gripOffset = new THREE.Vector3(0, 0, 0);
        const handBone = gltf.scene.getObjectByName('ag1_hand_r') || gltf.scene.getObjectByName('weapon');
        if (handBone) {
          handBone.getWorldPosition(gripOffset);
          gltf.scene.worldToLocal(gripOffset);
        }
        gltf.scene.userData.handROffset = gripOffset;
        const wBone = gltf.scene.getObjectByName('weapon');
        if (wBone) {
          gltf.scene.userData.weaponBoneInverse = new THREE.Matrix4().copy(wBone.matrixWorld).invert();
        }
        this.weaponTemplates.set(key, gltf.scene);
        if (key === 'c4') {
          this._upgradeBombMeshToRealC4(gltf.scene);
        }
        return gltf.scene;
      })
      .catch((err) => {
        console.warn(`Failed to load weapon GLB ${key}:`, err);
        return null;
      })
      .finally(() => {
        this.weaponLoadsInFlight.delete(key);
      });
    this.weaponLoadsInFlight.set(key, p);
    return p;
  }

  _upgradeBombMeshToRealC4(c4Scene) {
    if (this.bombRealModel) return;
    const clone = SkeletonUtils.clone(c4Scene);
    clone.scale.setScalar(INCHES_PER_METER * 1.45);
    clone.rotation.set(0, Math.PI, 0);
    this.bombMesh.visible = false;
    this.bombRealModel = clone;
    this.bombGroup.add(clone);
    this.bombLed.position.set(0, 6.5, 0);
  }

  async loadOfficialAssets(health) {
    const pModels = new Set(health?.player_models || []);
    const wModels = new Set(health?.weapon_models || []);
    this.availableWeaponKeys = wModels;

    const loads = [];
    if (pModels.has('ct_sas') && !this.ctPlayerTemplate) {
      loads.push(
        this._loadGlb('/api/assets/players/ct_sas')
          .then((gltf) => {
            this.ctPlayerTemplate = gltf.scene;
          })
          .catch((e) => console.warn('Failed to load ct_sas.glb:', e))
      );
    }
    if (pModels.has('t_phoenix') && !this.tPlayerTemplate) {
      loads.push(
        this._loadGlb('/api/assets/players/t_phoenix')
          .then((gltf) => {
            this.tPlayerTemplate = gltf.scene;
          })
          .catch((e) => console.warn('Failed to load t_phoenix.glb:', e))
      );
    }
    if (health?.has_operator_anims !== false && this.operatorClips.size === 0) {
      loads.push(
        this._loadGlb('/api/assets/players/operator_anims')
          .then((gltf) => {
            for (const clip of gltf.animations || []) {
              if (clip.name.startsWith('world/') && clip.name.includes('/shoot_')) {
                THREE.AnimationUtils.makeClipAdditive(clip, 0);
                clip.userData = clip.userData || {};
                clip.userData.isAdditive = true;
              }
              this.operatorClips.set(clip.name, clip);
            }
          })
          .catch((e) => console.warn('Failed to load operator_anims.glb:', e))
      );
    }

    const priorityWeapons = [
      'ak47',
      'm4a1_silencer',
      'm4a4',
      'awp',
      'usp_silencer',
      'glock18',
      'deagle',
      'knife_ct',
      'knife_t',
      'c4',
      'hegrenade',
      'flashbang',
      'smokegrenade',
      'molotov',
      'incendiarygrenade',
      'decoy',
    ];
    for (const wk of priorityWeapons) {
      if (wModels.has(wk)) {
        loads.push(this._loadWeaponTemplate(wk));
      }
    }
    await Promise.all(loads);
    this._buildPovArmsRigs();
    this._rebuildPlayerRigs();
  }

  _posePovArmsForCategory(armsRig, cat = 'rifle') {
    if (!armsRig || !armsRig.bones || armsRig.posedCat === cat) return;
    const { clone, bones } = armsRig;
    const wasVisible = clone.visible;
    clone.visible = true;

    for (const name of ['arm_upper_R', 'arm_lower_R', 'hand_R', 'arm_upper_L', 'arm_lower_L', 'hand_L']) {
      const b = bones[name];
      if (b && b.userData.restQuat) b.quaternion.copy(b.userData.restQuat);
    }

    // Place wrist right behind the pistol grip so curled palm + fingers wrap tightly around the grip
    if (bones.arm_upper_R && bones.arm_lower_R && bones.hand_R) {
      const isRifleTwoHanded = cat === 'rifle' || cat === 'sniper' || cat === 'smg' || cat === 'heavy';
      const targetR = isRifleTwoHanded
        ? new THREE.Vector3(0.85, -1.25, 1.10)
        : new THREE.Vector3(1.30, -0.20, 2.20);
      solveTwoBoneIk(
        this.povArmsContainer,
        bones.arm_upper_R,
        bones.arm_lower_R,
        bones.hand_R,
        targetR,
        new THREE.Vector3(0.55, -0.85, 0.25),
        1
      );
      // Align hand_R: for rifles, orient palm steeply up-forward along pistol grip so wrist sits at heel and knuckles wrap front-left under trigger
      const gx = isRifleTwoHanded
        ? new THREE.Vector3(0.38, -0.58, 0.72).normalize()
        : new THREE.Vector3(0.36, 0.05, 0.93).normalize();
      const gy = isRifleTwoHanded
        ? new THREE.Vector3(0.86, 0.35, -0.37).normalize()
        : new THREE.Vector3(0.93, 0.0, -0.36).normalize();
      const gz = new THREE.Vector3().crossVectors(gx, gy).normalize();
      gy.crossVectors(gz, gx).normalize();
      orientBoneToRigAxes(this.povArmsContainer, bones.hand_R, gx, gy, gz);
      curlHandFingers(bones, 'R', isRifleTwoHanded ? 1.25 : 1.15);
    }

    if (bones.arm_upper_L && bones.arm_lower_L && bones.hand_L) {
      const isOneHanded = cat === 'knife' || cat === 'grenade' || cat === 'c4';
      const targetL =
        cat === 'pistol'
          ? new THREE.Vector3(-1.40, -0.75, 1.95)
          : isOneHanded
          ? new THREE.Vector3(-5.2, -5.0, -4.5)
          : new THREE.Vector3(-1.55, 1.55, -7.80);
      solveTwoBoneIk(
        this.povArmsContainer,
        bones.arm_upper_L,
        bones.arm_lower_L,
        bones.hand_L,
        targetL,
        new THREE.Vector3(-0.55, -0.85, 0.2),
        1
      );
      if (cat === 'pistol') {
        // Left hand (+X fingers, +Y palm) wraps tightly from left side over the right fingers & grip
        const lx = new THREE.Vector3(0.48, 0.18, -0.86).normalize();
        const ly = new THREE.Vector3(0.86, 0.12, 0.49).normalize();
        const lz = new THREE.Vector3().crossVectors(lx, ly).normalize();
        ly.crossVectors(lz, lx).normalize();
        orientBoneToRigAxes(this.povArmsContainer, bones.hand_L, lx, ly, lz);
        curlHandFingers(bones, 'L', 1.1);
      } else if (!isOneHanded) {
        // Cradle forward rifle handguard from underneath (+X fingers curl up-right, +Y palm presses up-left)
        const lx = new THREE.Vector3(0.76, 0.62, -0.19).normalize();
        const ly = new THREE.Vector3(-0.56, 0.76, 0.33).normalize();
        const lz = new THREE.Vector3().crossVectors(lx, ly).normalize();
        ly.crossVectors(lz, lx).normalize();
        orientBoneToRigAxes(this.povArmsContainer, bones.hand_L, lx, ly, lz);
        curlHandFingers(bones, 'L', 0.85);
      }
    }

    clone.visible = wasVisible;
    armsRig.posedCat = cat;
  }

  _buildPovArmsRigs() {
    while (this.povArmsContainer.children.length > 0) {
      this.povArmsContainer.children.pop();
    }
    this.povArmsRigs = { ct: null, t: null };

    const makeArmsRig = (tpl) => {
      if (!tpl) return null;
      const clone = SkeletonUtils.clone(tpl);
      this._configurePbrObject(clone, {
        onlyFirstPerson: true,
        castShadow: false,
        receiveShadow: false,
        isOperatorOrWeapon: true,
      });
      clone.scale.setScalar(INCHES_PER_METER);
      clone.rotation.y = Math.PI;
      clone.position.set(0, 0, 0);

      const bones = {};
      clone.traverse((obj) => {
        if (obj.isBone || obj.name) {
          if (!bones[obj.name]) {
            obj.userData.restQuat = obj.quaternion.clone();
            obj.userData.restPos = obj.position.clone();
            bones[obj.name] = obj;
          }
        }
      });

      this.povArmsContainer.add(clone);
      clone.visible = false;
      const mixer = new THREE.AnimationMixer(clone);
      const armsRig = {
        clone,
        bones,
        mixer,
        actions: new Map(),
        activeClipName: null,
        activeAction: null,
        posedCat: null,
      };
      if (!this._playClipOnRig(armsRig, 'viewmodel/rifle/rifle_ak/idle_ak', { timeSec: 0, loop: true })) {
        this._posePovArmsForCategory(armsRig, 'rifle');
      }
      return armsRig;
    };

    this.povArmsRigs.ct = makeArmsRig(this.ctPlayerTemplate);
    this.povArmsRigs.t = makeArmsRig(this.tPlayerTemplate);
  }

  _playClipOnRig(rig, clipName, { timeSec = 0, loop = true, crossFadeSec = 0.12, dt = 0, additiveClipName = null, additiveTimeSec = 0 } = {}) {
    if (!rig?.mixer || !clipName) return false;
    const clip = this.operatorClips.get(clipName);
    if (!clip) return false;
    let action = rig.actions.get(clipName);
    if (!action) {
      action = rig.mixer.clipAction(clip);
      rig.actions.set(clipName, action);
    }
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    const dur = Math.max(0.001, clip.duration || 0.001);
    const wrappedTime = loop ? ((timeSec % dur) + dur) % dur : Math.max(0, Math.min(dur, timeSec));

    if (rig.activeAction !== action) {
      const fade = this.playing && crossFadeSec > 0 ? crossFadeSec : 0;
      if (rig.activeAction && fade > 0) {
        action.reset();
        action.time = wrappedTime;
        action.setEffectiveWeight(1);
        action.play();
        rig.activeAction.crossFadeTo(action, fade, false);
        rig.mixer.update(Math.max(0.001, dt || 0.016));
      } else {
        for (const act of rig.actions.values()) {
          if (act !== action) act.stop();
        }
        action.reset();
        action.time = wrappedTime;
        action.setEffectiveWeight(1);
        action.play();
        rig.mixer.update(0);
      }
      rig.activeAction = action;
      rig.activeClipName = clipName;
    } else if (this.playing && dt > 0) {
      action.enabled = true;
      rig.mixer.update(dt);
      // Keep demo timeline synchronized within 0.08s so playback speed & scrubbing match ticks
      if (Math.abs(action.time - wrappedTime) > 0.08 && (!loop || Math.abs(action.time - wrappedTime) < dur - 0.08)) {
        action.time = wrappedTime;
        rig.mixer.update(0);
      }
    } else {
      // Stop & re-evaluate cleanly when paused/scrubbed so post-mixer bone pitch never accumulates across frames
      for (const act of rig.actions.values()) {
        if (act !== action) act.stop();
      }
      action.stop();
      action.reset();
      action.setEffectiveWeight(1);
      action.time = wrappedTime;
      action.play();
      rig.mixer.update(0);
    }

    // Optional additive overlay (e.g. world/*/shoot_* recoil deltas over base locomotion/idle)
    const addClip = additiveClipName ? this.operatorClips.get(additiveClipName) : null;
    if (addClip && addClip.userData?.isAdditive) {
      let addAct = rig.actions.get(additiveClipName);
      if (!addAct) {
        addAct = rig.mixer.clipAction(addClip);
        addAct.blendMode = THREE.AdditiveAnimationBlendMode;
        rig.actions.set(additiveClipName, addAct);
      }
      const addDur = Math.max(0.001, addClip.duration || 0.001);
      addAct.setLoop(THREE.LoopOnce, 1);
      addAct.clampWhenFinished = true;
      addAct.stop();
      addAct.reset();
      addAct.setEffectiveWeight(0.85);
      addAct.time = Math.max(0, Math.min(addDur, additiveTimeSec));
      addAct.play();
      rig.mixer.update(0);
      rig.activeAdditiveAction = addAct;
    } else if (rig.activeAdditiveAction) {
      rig.activeAdditiveAction.stop();
      rig.activeAdditiveAction = null;
      rig.mixer.update(0);
    }
    return true;
  }

  _applyWorldFingerGripIfMissing(rig, clipName, weaponCat) {
    if (!rig?.bones || !clipName) return;
    const clip = this.operatorClips.get(clipName);
    if (!clip) return;
    if (clip.tracks.some((t) => t.name.includes('finger_'))) return;
    if (weaponCat === 'pistol') {
      curlHandFingers(rig.bones, 'R', 0.95);
      curlHandFingers(rig.bones, 'L', 0.9);
    } else if (weaponCat === 'knife' || weaponCat === 'grenade' || weaponCat === 'c4') {
      curlHandFingers(rig.bones, 'R', 0.95);
      curlHandFingers(rig.bones, 'L', 0.35);
    } else {
      curlHandFingers(rig.bones, 'R', 0.95);
      curlHandFingers(rig.bones, 'L', 0.85);
    }
  }

  _updateSunShadowFrustum(force = false) {
    if (!this.sunLight || !this.renderer.shadowMap.enabled) return;
    let fx = this.orbit.target.x;
    let fy = this.orbit.target.y;
    let fz = this.orbit.target.z;
    let half = 1600;

    if (this.cameraMode === 'tactical') {
      const camDist = this.camera.position.distanceTo(this.orbit.target);
      half = Math.round(Math.min(2600, Math.max(850, camDist * 0.56)) / 50) * 50;
    } else if (this.cameraMode === 'pov') {
      half = 540;
      const fwd = new THREE.Vector3();
      this.camera.getWorldDirection(fwd);
      fx = this.camera.position.x + fwd.x * 300;
      fy = this.camera.position.y + fwd.y * 120 - 40;
      fz = this.camera.position.z + fwd.z * 300;
    } else {
      half = 950;
      const fwd = new THREE.Vector3();
      this.camera.getWorldDirection(fwd);
      fx = this.camera.position.x + fwd.x * 380;
      fy = this.camera.position.y + fwd.y * 220;
      fz = this.camera.position.z + fwd.z * 380;
    }

    const mapRes = Math.max(512, this.sunLight.shadow.mapSize.x || 512);
    const step = (half * 2) / Math.min(64, Math.max(16, mapRes / 32));
    const sx = Math.round(fx / step) * step;
    const sy = Math.round(fy / step) * step;
    const sz = Math.round(fz / step) * step;
    if (
      !force &&
      this._lastShadowMode === this.cameraMode &&
      this._lastShadowHalf === half &&
      Math.abs(sx - this._lastShadowFocus.x) < step &&
      Math.abs(sy - this._lastShadowFocus.y) < step &&
      Math.abs(sz - this._lastShadowFocus.z) < step
    ) {
      return;
    }
    this._lastShadowFocus.set(sx, sy, sz);
    this._lastShadowMode = this.cameraMode;
    this._lastShadowHalf = half;
    this.sunLight.target.position.set(sx, sy, sz);
    this.sunLight.position.set(sx + SUN_OFFSET.x, sy + SUN_OFFSET.y, sz + SUN_OFFSET.z);
    const cam = this.sunLight.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();
    this.sunLight.shadow.needsUpdate = true;
    this.renderer.shadowMap.needsUpdate = true;
  }

  setRoundData(roundReplay, playersMeta) {
    this.lastRafTs = 0;
    this._frameSampleMs = 0;
    this._frameSampleCount = 0;
    this._fpsLowStreak = 0;
    this.roundReplay = roundReplay;
    this.playersMeta = playersMeta || [];
    this.metaBySlot = new Map();
    for (const m of this.playersMeta) {
      this.metaBySlot.set(m.slot, m);
    }
    this.playableBounds = null;
    const frames = roundReplay?.frames || [];
    this.roundTeams = roundTeamsBySlot(frames);
    if (frames.length > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      const step = Math.max(1, Math.floor(frames.length / 80));
      for (let fi = 0; fi < frames.length; fi += step) {
        for (const p of frames[fi].p || []) {
          if (!p || p[0] !== 1) continue;
          const [tx, ty, tz] = cs2ToThree(p[2], p[3], p[4]);
          if (tx < minX) minX = tx;
          if (ty < minY) minY = ty;
          if (tz < minZ) minZ = tz;
          if (tx > maxX) maxX = tx;
          if (ty > maxY) maxY = ty;
          if (tz > maxZ) maxZ = tz;
        }
      }
      if (Number.isFinite(minX)) {
        const pad = 650;
        const mn = [minX - pad, minY - 120, minZ - pad];
        const mx = [maxX + pad, maxY + 320, maxZ + pad];
        this.playableBounds = {
          min: mn,
          max: mx,
          center: [(mn[0] + mx[0]) * 0.5, (mn[1] + mx[1]) * 0.5, (mn[2] + mx[2]) * 0.5],
        };
      }
    }
    this.currentTick = frames.length > 0 ? frames[0].t : 0;
    this._rebuildPlayerRigs();
    this._updateSceneAtTick(this.currentTick);
    if (this.cameraMode === 'tactical') {
      this.resetTacticalCamera();
    }
  }

  setCameraMode(mode, slot = this.povSlot) {
    const prevMode = this.cameraMode;
    const prevSlot = this.povSlot;
    this.cameraMode = mode;
    if (typeof slot === 'number' && slot >= 0) {
      this.povSlot = slot;
    }
    if (mode !== 'pov' || prevSlot !== this.povSlot || prevMode !== mode) {
      this._deathCam = null;
    }
    this.orbit.enabled = mode === 'tactical';
    if (this.povFillLight) this.povFillLight.visible = mode === 'pov';
    if (mode !== 'pov') {
      this.viewModelGroup.visible = false;
      this.camera.fov = mode === 'tactical' ? 72 : WORLD_FOV_VERTICAL;
      this.camera.updateProjectionMatrix();
    } else {
      this.camera.fov = WORLD_FOV_VERTICAL;
      this.camera.updateProjectionMatrix();
    }
    if (mode === 'free') {
      this.freePos.copy(this.camera.position);
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.freeYaw = Math.atan2(-dir.x, -dir.z);
      this.freePitch = Math.asin(Math.max(-0.99, Math.min(0.99, dir.y)));
    }
    if (mode === 'tactical') {
      this.resetTacticalCamera();
    }
    // Synchronously update scene visibility & camera/HUD transforms so zero frames overlap on switch
    if (this.roundReplay?.frames?.length) {
      const snap = this._updateSceneAtTick(this.currentTick, 0);
      this._update2DOverlays(snap);
    }
    this._updateSunShadowFrustum(true);
    this.onCameraStateChange({ cameraMode: this.cameraMode, povSlot: this.povSlot });
  }

  focusWorldPoint(cs2x, cs2y, cs2z, distance = 900) {
    const [tx, ty, tz] = cs2ToThree(cs2x, cs2y, cs2z);
    if (this.cameraMode === 'tactical') {
      this.orbit.target.set(tx, ty, tz);
      this.camera.position.set(tx + distance * 0.45, ty + distance * 0.72, tz + distance * 0.55);
      this.orbit.update();
    } else if (this.cameraMode === 'free') {
      this.freePos.set(tx + distance * 0.35, ty + distance * 0.35, tz + distance * 0.45);
      const dir = new THREE.Vector3(tx - this.freePos.x, ty - this.freePos.y, tz - this.freePos.z).normalize();
      this.freeYaw = Math.atan2(-dir.x, -dir.z);
      this.freePitch = Math.asin(Math.max(-0.99, Math.min(0.99, dir.y)));
    }
  }

  focusOperatorCloseUp(cs2x, cs2y, cs2z, yawDeg = 0, distance = 68) {
    this.setCameraMode('free');
    const [tx, ty, tz] = cs2ToThree(cs2x, cs2y, cs2z);
    const target = new THREE.Vector3(tx, ty + 40, tz);
    const baseYaw = (yawDeg * Math.PI) / 180;
    const rc = new THREE.Raycaster();
    // Probe front-right, front-left, side, and diagonal azimuths so foreground walls never clip the operator
    const offsets = [0.42, -0.42, 0.85, -0.85, 1.35, -1.35, 0.0, Math.PI];
    let bestPos = null;
    let bestClearance = -1;
    for (const off of offsets) {
      const a = baseYaw + off;
      const cand = new THREE.Vector3(
        tx + Math.cos(a) * distance,
        ty + 54,
        tz - Math.sin(a) * distance
      );
      const dir = new THREE.Vector3().subVectors(target, cand);
      const len = dir.length();
      dir.divideScalar(len);
      rc.set(cand, dir);
      rc.far = len - 14;
      const hits = rc.intersectObjects(this.mapGroup.children, true);
      if (hits.length === 0) {
        bestPos = cand;
        break;
      }
      const d = hits[0].distance;
      if (d > bestClearance) {
        bestClearance = d;
        bestPos = cand;
      }
    }
    if (bestPos) {
      this.freePos.copy(bestPos);
      const look = new THREE.Vector3().subVectors(target, bestPos).normalize();
      this.freeYaw = Math.atan2(-look.x, -look.z);
      this.freePitch = Math.asin(Math.max(-0.99, Math.min(0.99, look.y)));
    }
  }

  resetTacticalCamera() {
    const b = this.playableBounds || this.mapBounds;
    const [cx, cy, cz] = b.center;
    const spanX = Math.max(900, b.max[0] - b.min[0]);
    const spanZ = Math.max(900, b.max[2] - b.min[2]);
    const span = Math.min(6200, Math.max(spanX, spanZ));
    this.orbit.target.set(cx, cy, cz);
    this.camera.position.set(cx, cy + span * 0.68, cz + span * 0.56);
    this.orbit.update();
  }

  setXray(enabled) {
    this.xray = !!enabled;
  }

  setShowTracers(enabled) {
    this.showTracers = !!enabled;
    this.tracersGroup.visible = this.showTracers;
  }

  _poseOperatorSkeleton(
    rig,
    {
      duck = 0,
      pitchDeg = 0,
      yawDeg = 0,
      walkPhase = 0,
      speed = 0,
      vx = 0,
      vy = 0,
      vz = 0,
      dead = false,
      deadElapsedSec = 10,
      breathePhase = 0,
      weaponKey = 'ak47',
      weaponCat = 'rifle',
      team = 3,
      firing = false,
      shotAgeSec = 0,
      flashed = 0,
      planting = false,
      defusing = false,
      demoTimeSec = 0,
      dt = 0.016,
    } = {}
  ) {
    const b = rig.bones;
    if (!b) return;
    if (rig.aimPoseApplied) {
      for (const { bone, position, quaternion } of rig.baseAimPose) {
        bone.position.copy(position);
        bone.quaternion.copy(quaternion);
      }
      rig.aimPoseApplied = false;
    }
    const q = _ikQ;
    const e = (rig._tmpEuler || (rig._tmpEuler = new THREE.Euler()));

    // Try real CS2 skeletal AnimationMixer first when operator_anims.glb is loaded
    const hasClips = this.operatorClips && this.operatorClips.size > 0 && rig.mixer;
    if (hasClips && !dead) {
      const clips = resolveOperatorClipNames({
        weaponKey,
        weaponCat,
        team,
        duck,
        speed,
        vx,
        vy,
        vz,
        yawDeg,
        firing,
        flashed,
        planting,
        defusing,
      });

      let chosenClip = clips.worldBase;
      let chosenTime = demoTimeSec + rig.slot * 0.37;
      let chosenLoop = true;
      let additiveClipName = null;
      let additiveTimeSec = 0;

      if (clips.worldAction && this.operatorClips.has(clips.worldAction)) {
        const actClip = this.operatorClips.get(clips.worldAction);
        if (actClip?.userData?.isAdditive) {
          additiveClipName = clips.worldAction;
          additiveTimeSec = shotAgeSec;
        } else if (speed <= 35) {
          chosenClip = clips.worldAction;
          chosenTime = demoTimeSec;
          chosenLoop = true;
        }
      }

      if (
        this._playClipOnRig(rig, chosenClip, {
          timeSec: chosenTime,
          loop: chosenLoop,
          crossFadeSec: 0.1,
          dt,
          additiveClipName,
          additiveTimeSec,
        })
      ) {
        // Apply proportional CS2 aim pitch around bodyGroup +X axis so torso, head, arms, and wpn pitch in sync
        const pitchRad = Math.max(-1.05, Math.min(1.05, (pitchDeg * Math.PI) / 180));
        if (Math.abs(pitchRad) > 0.005) {
          rig.baseAimPose ??= [b.spine_1, b.spine_2, b.head_0, b.wpnPivot].filter(Boolean).map((bone) => ({
            bone, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
          }));
          for (const { bone, position, quaternion } of rig.baseAimPose) {
            position.copy(bone.position);
            quaternion.copy(bone.quaternion);
          }
          rig.aimPoseApplied = true;
          rig.bodyGroup.updateMatrixWorld(true);
          const rigQ = _ikRootQ;
          rig.bodyGroup.getWorldQuaternion(rigQ);
          const pitchAxis = _ikDir.set(1, 0, 0).applyQuaternion(rigQ).normalize();
          const applyBoneWorldPitch = (bone, ang) => {
            if (!bone?.parent) return;
            bone.parent.getWorldQuaternion(_ikParentQ);
            _ikParentInv.copy(_ikParentQ).invert();
            _ikQ.setFromAxisAngle(pitchAxis, ang);
            _ikDeltaQ.copy(_ikParentInv).multiply(_ikQ).multiply(_ikParentQ);
            bone.quaternion.premultiply(_ikDeltaQ);
          };
          const torsoPitch = -pitchRad * 0.58;
          let pivotOriginWorld = null;
          if (b.spine_2) {
            pivotOriginWorld = _ikA;
            b.spine_2.getWorldPosition(pivotOriginWorld);
          }
          applyBoneWorldPitch(b.spine_1, -pitchRad * 0.24);
          applyBoneWorldPitch(b.spine_2, -pitchRad * 0.34);
          applyBoneWorldPitch(b.head_0, -pitchRad * 0.42);
          if (b.wpnPivot && pivotOriginWorld) {
            rig.bodyGroup.updateMatrixWorld(true);
            b.wpnPivot.getWorldPosition(_ikB);
            _ikC.subVectors(_ikB, pivotOriginWorld);
            _ikQ.setFromAxisAngle(pitchAxis, torsoPitch);
            _ikC.applyQuaternion(_ikQ).add(pivotOriginWorld);
            if (b.wpnPivot.parent) {
              b.wpnPivot.parent.worldToLocal(_ikC);
              b.wpnPivot.position.copy(_ikC);
            }
            applyBoneWorldPitch(b.wpnPivot, torsoPitch);
          }
        }
        this._applyWorldFingerGripIfMissing(rig, chosenClip, weaponCat);
        rig.usedRealAnim = true;
        return;
      }
    }

    if (hasClips && dead) {
      for (const act of rig.actions.values()) act.stop();
      rig.activeAction = null;
      rig.activeAdditiveAction = null;
      rig.activeClipName = null;
    }

    rig.usedRealAnim = false;
    const resetBone = (name) => {
      const obj = b[name];
      if (!obj) return null;
      if (obj.userData.restQuat) obj.quaternion.copy(obj.userData.restQuat);
      if (obj.userData.restPos) obj.position.copy(obj.userData.restPos);
      return obj;
    };

    resetBone('root_motion');
    const pelvis = resetBone('pelvis');
    resetBone('spine_0');
    const spine1 = resetBone('spine_1');
    const spine2 = resetBone('spine_2');
    const head = resetBone('head_0');
    resetBone('clavicle_L');
    const armUpperL = resetBone('arm_upper_L');
    const armLowerL = resetBone('arm_lower_L');
    const handL = resetBone('hand_L');
    resetBone('clavicle_R');
    const armUpperR = resetBone('arm_upper_R');
    const armLowerR = resetBone('arm_lower_R');
    const handR = resetBone('hand_R');
    const legUpperL = resetBone('leg_upper_L');
    const legLowerL = resetBone('leg_lower_L');
    const ankleL = resetBone('ankle_L');
    const legUpperR = resetBone('leg_upper_R');
    const legLowerR = resetBone('leg_lower_R');
    const ankleR = resetBone('ankle_R');

    if (dead) {
      // CS2 deaths transition to ragdoll/DMX clips not exported by Source2Viewer-CLI;
      // collapse cleanly onto a grounded supine fall pose over 0.55s without kicking legs upward.
      const fallT = Math.min(1, Math.max(0, deadElapsedSec / 0.55));
      const smoothFall = 1 - Math.pow(1 - fallT, 3);
      const rotBodyAxis = (bone, ax, ay, az, ang) => {
        if (!bone?.parent || Math.abs(ang) < 1e-5) return;
        rig.bodyGroup.updateMatrixWorld(true);
        rig.bodyGroup.getWorldQuaternion(_ikRootQ);
        _ikRootInvQ.copy(_ikRootQ).invert();
        bone.parent.getWorldQuaternion(_ikParentQ);
        _ikParentInv.copy(_ikParentQ).invert();
        _ikDir.set(ax, ay, az).normalize().applyQuaternion(_ikRootQ);
        _ikQ.setFromAxisAngle(_ikDir, ang);
        _ikDeltaQ.copy(_ikParentInv).multiply(_ikQ).multiply(_ikParentQ);
        bone.quaternion.premultiply(_ikDeltaQ);
      };
      if (armUpperL) rotBodyAxis(armUpperL, 0, 0, 1, 1.24 * smoothFall);
      if (armUpperR) rotBodyAxis(armUpperR, 0, 0, 1, -1.24 * smoothFall);
      if (armLowerL) rotBodyAxis(armLowerL, 0, 1, 0, 0.32 * smoothFall);
      if (armLowerR) rotBodyAxis(armLowerR, 0, 1, 0, -0.32 * smoothFall);
      if (legUpperL) rotBodyAxis(legUpperL, 0, 0, 1, -0.14 * smoothFall);
      if (legUpperR) rotBodyAxis(legUpperR, 0, 0, 1, 0.14 * smoothFall);
      if (pelvis) {
        pelvis.position.y = pelvis.position.y * (1 - smoothFall) + 0.16 * smoothFall;
        rotBodyAxis(pelvis, 1, 0, 0, Math.PI * 0.47 * smoothFall);
      }
      return;
    }

    const clampedDuck = Math.max(0, Math.min(1, duck || 0));
    const moveBlend = Math.min(1, speed / 210);
    const airborneBlend = Math.min(1, Math.max(0, (Math.abs(vz) - 85) / 140));
    const breathe = Math.sin(breathePhase) * 0.018 * (1 - moveBlend * 0.5);

    // Athletic bladed stance turn + crouch drop + stride bounce
    if (pelvis) {
      const bounce = moveBlend * Math.abs(Math.cos(walkPhase)) * 0.036;
      const stanceDrop = 0.035;
      pelvis.position.y -= stanceDrop + clampedDuck * 0.39 + bounce;
      // Pelvis local X is UP in bind pose; slight bladed yaw + dynamic hip twist when running
      const stanceYaw = (1 - moveBlend * 0.55) * 0.2 + Math.sin(walkPhase) * 0.08 * moveBlend;
      e.set(stanceYaw, 0, 0.06 + moveBlend * 0.08);
      pelvis.quaternion.multiply(q.setFromEuler(e));
    }

    // Aim pitch distributed across torso + head (+Z pitches down toward ground)
    const pitchRad = Math.max(-1.05, Math.min(1.05, (pitchDeg * Math.PI) / 180));
    if (spine1) {
      e.set(-0.08 * (1 - moveBlend * 0.4), 0, pitchRad * 0.22 + breathe * 0.7);
      spine1.quaternion.multiply(q.setFromEuler(e));
    }
    if (spine2) {
      e.set(-0.08 * (1 - moveBlend * 0.4), 0, pitchRad * 0.35 + breathe * 0.5);
      spine2.quaternion.multiply(q.setFromEuler(e));
    }
    if (head) {
      e.set(0, 0, pitchRad * 0.43);
      head.quaternion.multiply(q.setFromEuler(e));
    }

    // Solve 2-bone IK for legs (grounded combat stance, crouch, run stride, or jump tuck)
    const kneePole = (rig._tmpPole || (rig._tmpPole = new THREE.Vector3())).set(0, 0.15, -1).normalize();
    const targetAnkleL = (rig._tmpTargetA || (rig._tmpTargetA = new THREE.Vector3()));
    const targetAnkleR = (rig._tmpTargetB || (rig._tmpTargetB = new THREE.Vector3()));

    const strideZ = Math.sin(walkPhase) * 14.5 * moveBlend;
    const liftL = (Math.max(0, Math.cos(walkPhase)) * 7.5 * moveBlend) + airborneBlend * 8.0;
    const liftR = (Math.max(0, -Math.cos(walkPhase)) * 7.5 * moveBlend) + airborneBlend * 6.0;
    const crouchFootZ = clampedDuck * 3.5;

    targetAnkleL.set(
      -5.6 + moveBlend * 0.8,
      4.3 + liftL,
      -4.2 * (1 - moveBlend * 0.7) + strideZ + crouchFootZ
    );
    targetAnkleR.set(
      5.6 - moveBlend * 0.8,
      4.3 + liftR,
      5.2 * (1 - moveBlend * 0.7) - strideZ + crouchFootZ
    );

    if (legUpperL && legLowerL && ankleL) {
      solveTwoBoneIk(rig.bodyGroup, legUpperL, legLowerL, ankleL, targetAnkleL, kneePole, 1);
    }
    if (legUpperR && legLowerR && ankleR) {
      solveTwoBoneIk(rig.bodyGroup, legUpperR, legLowerR, ankleR, targetAnkleR, kneePole, 1);
    }

    // Solve 2-bone IK for arms holding active weapon category cleanly at chest/shoulder height
    const fy = -Math.sin(pitchRad);
    const fz = -Math.cos(pitchRad);
    const armBob = Math.sin(walkPhase * 2) * 0.65 * moveBlend + breathe * 12;
    const duckY = -clampedDuck * 15.5;
    const targetHandR = targetAnkleL;
    const targetHandL = targetAnkleR;
    const elbowPoleR = kneePole;
    const elbowPoleL = (rig._tmpPoleL || (rig._tmpPoleL = new THREE.Vector3()));

    if (weaponCat === 'pistol') {
      // One-handed pistol grip: right arm extended forward on target, left arm counter-balanced at chest/hip
      targetHandR.set(4.2, 53.5 + duckY + fy * 13 + armBob, -17.0 * Math.abs(fz) - 2.0);
      targetHandL.set(-6.4, 42.5 + duckY + armBob * 0.5, -6.5);
      elbowPoleR.set(0.5, -0.85, 0.25).normalize();
      elbowPoleL.set(-0.65, -0.75, 0.25).normalize();
    } else if (weaponCat === 'knife' || weaponCat === 'grenade' || weaponCat === 'c4') {
      targetHandR.set(6.4, 49.5 + duckY + fy * 8 + armBob, -13.0);
      targetHandL.set(-6.0, 46.5 + duckY + armBob * 0.6, -9.5);
      elbowPoleR.set(0.65, -0.75, 0.25).normalize();
      elbowPoleL.set(-0.65, -0.75, 0.25).normalize();
    } else {
      // Rifle / Sniper / SMG / Heavy: two-handed grip (right hand on receiver grip, left hand forward on handguard)
      targetHandR.set(4.4, 52.5 + duckY + fy * 8 + armBob, -10.5);
      targetHandL.set(1.4, 52.5 + duckY + fy * 14 + armBob, -19.5);
      elbowPoleR.set(0.55, -0.85, 0.22).normalize();
      elbowPoleL.set(-0.55, -0.85, 0.22).normalize();
    }

    if (armUpperR && armLowerR && handR) {
      solveTwoBoneIk(rig.bodyGroup, armUpperR, armLowerR, handR, targetHandR, elbowPoleR, 1);
      const gx = (rig._tmpGx || (rig._tmpGx = new THREE.Vector3())).set(0.3, 0.18, 0.93).normalize();
      const gy = (rig._tmpGy || (rig._tmpGy = new THREE.Vector3())).set(0.93, 0.0, -0.3).normalize();
      const gz = (rig._tmpGz || (rig._tmpGz = new THREE.Vector3())).crossVectors(gx, gy).normalize();
      gy.crossVectors(gz, gx).normalize();
      orientBoneToRigAxes(rig.bodyGroup, handR, gx, gy, gz);
      curlHandFingers(b, 'R', 1.0);
    }
    if (armUpperL && armLowerL && handL) {
      solveTwoBoneIk(rig.bodyGroup, armUpperL, armLowerL, handL, targetHandL, elbowPoleL, 1);
      if (weaponCat === 'rifle' || weaponCat === 'sniper' || weaponCat === 'smg' || weaponCat === 'heavy') {
        const lx = (rig._tmpLx || (rig._tmpLx = new THREE.Vector3())).set(0.76, 0.62, -0.19).normalize();
        const ly = (rig._tmpLy || (rig._tmpLy = new THREE.Vector3())).set(-0.56, 0.76, 0.33).normalize();
        const lz = (rig._tmpLz || (rig._tmpLz = new THREE.Vector3())).crossVectors(lx, ly).normalize();
        ly.crossVectors(lz, lx).normalize();
        orientBoneToRigAxes(rig.bodyGroup, handL, lx, ly, lz);
        curlHandFingers(b, 'L', 0.85);
      } else {
        curlHandFingers(b, 'L', 0.45);
      }
    }
  }

  _rebuildPlayerRigs() {
    this.playerOutline.clear();
    while (this.playersGroup.children.length > 0) {
      this.playersGroup.children.pop();
    }
    if (this.overlayEl) {
      this.overlayEl.innerHTML = '';
    }
    this.playerRigs = [];
    this.rigBySlot = new Map();

    const maxSlot = this.playersMeta.reduce((acc, m) => Math.max(acc, m.slot), 9);
    for (let slot = 0; slot <= maxSlot; slot++) {
      const meta = this.metaBySlot.get(slot) || {
        slot,
        name: `Player ${slot + 1}`,
      };
      const team = this.roundTeams.get(slot) || meta.start_team || meta.team || (slot < 5 ? 3 : 2);
      const root = new THREE.Group();

      const solidMat = new THREE.MeshStandardMaterial({
        color: team === 3 ? CT_COLOR : T_COLOR,
        roughness: 0.42,
        metalness: 0.15,
      });

      const bodyGroup = new THREE.Group();
      const template =
        this.customPlayerTemplate || (team === 3 ? this.ctPlayerTemplate : this.tPlayerTemplate);
      let bones = null;
      let defuseKitMesh = null;
      let isRealOperator = false;

      if (template) {
        const clone = SkeletonUtils.clone(template);
        this._configurePbrObject(clone, { hideFirstPerson: true, showDefuser: false });

        if (!this.customPlayerTemplate) {
          isRealOperator = true;
          clone.scale.setScalar(INCHES_PER_METER);
          clone.rotation.y = Math.PI; // glTF +Z forward -> Three rig -Z forward
          bones = {};
          clone.traverse((obj) => {
            if (obj.isMesh && (obj.name || '').toLowerCase().includes('defusekit')) {
              defuseKitMesh = obj;
              obj.visible = false;
            }
            if (obj.isBone || obj.name) {
              if (!bones[obj.name]) {
                obj.userData.restQuat = obj.quaternion.clone();
                obj.userData.restPos = obj.position.clone();
                bones[obj.name] = obj;
              }
            }
          });
        }
        bodyGroup.add(clone);
      } else {
        const torso = new THREE.Mesh(
          new THREE.CylinderGeometry(PLAYER_RADIUS * 0.85, PLAYER_RADIUS * 0.95, 46, 12),
          solidMat
        );
        torso.position.y = 28;
        bodyGroup.add(torso);

        const headGroup = new THREE.Group();
        headGroup.position.y = 60;
        const head = new THREE.Mesh(new THREE.SphereGeometry(9.5, 12, 10), solidMat);
        headGroup.add(head);

        const barrel = new THREE.Mesh(
          new THREE.BoxGeometry(3.5, 3.5, 28),
          new THREE.MeshStandardMaterial({ color: 0x1e2533, roughness: 0.35 })
        );
        barrel.position.set(4, -5, -18);
        headGroup.add(barrel);

        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(5, 22, 8),
          new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.3,
            depthWrite: false,
          })
        );
        cone.rotation.x = Math.PI / 2;
        cone.position.set(0, 0, -22);
        headGroup.add(cone);

        bodyGroup.add(headGroup);
        root.userData.headGroup = headGroup;
      }
      this.playerOutline.add(root, bodyGroup, team, defuseKitMesh);

      // World weapon socket synced to operator's live right hand position
      const worldWeaponGroup = new THREE.Group();
      worldWeaponGroup.position.set(6.5, 52, -14);
      bodyGroup.add(worldWeaponGroup);

      // Ground contact AO shadow disc under boots
      const contactShadow = new THREE.Mesh(
        new THREE.PlaneGeometry(36, 36),
        new THREE.MeshBasicMaterial({
          map: this.contactShadowTex,
          transparent: true,
          opacity: 0.94,
          depthWrite: false,
        })
      );
      contactShadow.rotation.x = -Math.PI / 2;
      contactShadow.position.y = 0.45;
      root.add(contactShadow);

      // Subtle team foot ring for instant CT/T identification from Tactical view
      const footRingMat = new THREE.MeshBasicMaterial({
        color: team === 3 ? CT_COLOR : T_COLOR,
        transparent: true,
        opacity: 0.68,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const footRing = new THREE.Mesh(new THREE.RingGeometry(15.5, 18.2, 24), footRingMat);
      footRing.rotation.x = -Math.PI / 2;
      footRing.position.y = 1.4;
      root.add(footRing);

      // C4 on carrier's back (real c4.glb when loaded, else orange box fallback)
      const c4BackMesh = new THREE.Group();
      c4BackMesh.position.set(0, 40, 11);
      c4BackMesh.visible = false;
      const c4Tpl = this.weaponTemplates.get('c4');
      if (c4Tpl) {
        const c4Clone = SkeletonUtils.clone(c4Tpl);
        c4Clone.scale.setScalar(INCHES_PER_METER * 1.15);
        c4Clone.rotation.set(Math.PI / 2, 0, 0);
        c4BackMesh.add(c4Clone);
      } else {
        c4BackMesh.add(
          new THREE.Mesh(
            new THREE.BoxGeometry(10, 12, 5),
            new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x7c2d12, roughness: 0.4 })
          )
        );
      }
      bodyGroup.add(c4BackMesh);

      root.add(bodyGroup);

      this.playersGroup.add(root);

      let labelEl = null;
      if (this.overlayEl) {
        labelEl = document.createElement('div');
        labelEl.className = 'player-3d-tag';
        labelEl.innerHTML = `<span class="tag-slot">${(slot + 1) % 10}</span><span class="tag-name"></span><span class="tag-hp"></span>`;
        this.overlayEl.appendChild(labelEl);
      }

      const rig = {
        slot,
        meta,
        team,
        root,
        bodyGroup,
        worldWeaponGroup,
        worldWeaponPivot: null,
        currentWorldWeaponKey: null,
        c4BackMesh,
        defuseKitMesh,
        contactShadow,
        footRing,
        footRingMat,
        solidMat,
        labelEl,
        bones,
        isRealOperator,
        usedRealAnim: false,
        mixer: isRealOperator ? new THREE.AnimationMixer(bodyGroup.children[0]) : null,
        actions: new Map(),
        activeAction: null,
        activeClipName: null,
        lastPos: null,
        lastAlivePos: null,
        wasAlive: false,
        walkPhase: slot * 0.9,
      };
      if (rig.isRealOperator) {
        this._poseOperatorSkeleton(rig);
      }
      this.playerRigs.push(rig);
      this.rigBySlot.set(slot, rig);
    }
  }

  stepFreeCamera(dt) {
    if (this.cameraMode !== 'free') return;
    const speedBase = this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight') ? 1350 : 580;
    const step = speedBase * dt;

    const forward = new THREE.Vector3(
      -Math.sin(this.freeYaw) * Math.cos(this.freePitch),
      Math.sin(this.freePitch),
      -Math.cos(this.freeYaw) * Math.cos(this.freePitch)
    ).normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    if (this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp')) {
      this.freePos.addScaledVector(forward, step);
    }
    if (this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown')) {
      this.freePos.addScaledVector(forward, -step);
    }
    if (this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight')) {
      this.freePos.addScaledVector(right, step);
    }
    if (this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft')) {
      this.freePos.addScaledVector(right, -step);
    }
    if (this.keysDown.has('Space') || this.keysDown.has('KeyE')) {
      this.freePos.y += step;
    }
    if (this.keysDown.has('KeyC') || this.keysDown.has('KeyQ') || this.keysDown.has('ControlLeft')) {
      this.freePos.y -= step;
    }

    this.camera.position.copy(this.freePos);
    const lookTarget = this.freePos.clone().add(forward);
    this.camera.lookAt(lookTarget);
  }

  _startLoop() {
    const tickLoop = (now) => {
      this._rafId = requestAnimationFrame(tickLoop);
      const rawDtMs = this.lastRafTs ? now - this.lastRafTs : 0;
      const dt = rawDtMs ? Math.min(0.08, rawDtMs / 1000) : 0.016;
      this.lastRafTs = now;

      if (rawDtMs > 0 && !document.hidden) {
        this._frameSampleMs += rawDtMs;
        this._frameSampleCount++;
        if (this._frameSampleMs >= 600) {
          this.frameMs = this._frameSampleMs / this._frameSampleCount;
          this.currentFps = 1000 / this.frameMs;
          this._frameSampleMs = 0;
          this._frameSampleCount = 0;
          if (this.qualitySetting === 'auto' && this.roundReplay && this.currentFps < 50) {
            if (++this._fpsLowStreak === 3) {
              const next = nextDowngradedQuality(this.activeQuality);
              if (next) this._applyQualityPreset(next);
              this._fpsLowStreak = 0;
            }
          } else {
            this._fpsLowStreak = 0;
          }
        }
      }

      if (this.playing && this.roundReplay && this.roundReplay.frames?.length > 1) {
        const tickRate = this.roundReplay.tick_rate || 64;
        const frames = this.roundReplay.frames;
        const maxTick = frames[frames.length - 1].t;
        this.currentTick += tickRate * this.playbackSpeed * dt;
        if (this.currentTick >= maxTick) {
          this.currentTick = maxTick;
          this.playing = false;
        }
      }

      if (this.cameraMode === 'free') {
        this.stepFreeCamera(dt);
      } else if (this.cameraMode === 'tactical') {
        this.orbit.update();
      }

      const snapshot = this._updateSceneAtTick(this.currentTick, dt);
      if (this.skyDome) {
        this.skyDome.position.set(this.camera.position.x, (this.mapBounds?.min?.[1] ?? 0) - 400, this.camera.position.z);
      }
      if (Math.abs(this.currentTick - this._lastShadowTick) >= (this.playing ? 2 : 0.05)) {
        this._lastShadowTick = this.currentTick;
        this.sunLight.shadow.needsUpdate = true;
        this.renderer.shadowMap.needsUpdate = true;
      }
      this._updateSunShadowFrustum();
      this.renderer.info.reset();
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      if (this.xray) this.playerOutline.render(this.camera);
      if (this.cameraMode === 'pov' && this.viewModelGroup.visible) {
        if (this.vmSunLight) {
          const camInvQ = (this._tmpCamInvQ || (this._tmpCamInvQ = new THREE.Quaternion())).copy(this.camera.quaternion).invert();
          const localSun = (this._tmpLocalSun || (this._tmpLocalSun = new THREE.Vector3())).copy(SUN_DIR).applyQuaternion(camInvQ);
          this.vmSunLight.position.copy(localSun).multiplyScalar(20);
        }
        this.renderer.clearDepth();
        this.renderer.render(this.vmScene, this.vmCamera);
      }
      this._update2DOverlays(snapshot);

      window.__CS2_VIEWER__ = {
        cameraMode: this.cameraMode,
        povSlot: this.povSlot,
        xray: this.xray,
        qualitySetting: this.qualitySetting,
        activeQuality: this.activeQuality,
        fps: Math.round(this.currentFps),
        frameMs: this.frameMs,
        rendererName: this.rendererName,
        softwareRenderer: this.softwareRenderer,
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        currentTick: Math.round(this.currentTick),
        playing: this.playing,
        playbackSpeed: this.playbackSpeed,
        mapSource: this.mapBounds.source,
        mapTriCount: this.mapBounds.triCount,
        glbTransform: this.mapBounds.glbTransform || null,
        glbShading: this.mapBounds.glbShading || null,
        skyboxActive: !!this.skyboxTexture,
        skyboxName: this.skyboxName,
        hasRealOperators: !!(this.ctPlayerTemplate && this.tPlayerTemplate),
        loadedWeaponModels: this.weaponTemplates.size,
        activeViewModelKey: this.currentRealVmKey || this.currentViewCategory || null,
        cameraPos: [
          Math.round(this.camera.position.x),
          Math.round(this.camera.position.y),
          Math.round(this.camera.position.z),
        ],
        cameraFov: Math.round(this.camera.fov),
        viewModelFov: this.vmCamera.fov,
        alivePlayers: snapshot ? snapshot.players.filter((p) => p && p[0] === 1).length : 0,
        activeSmokes: this._activeSmokeCount,
        activeGrenades: this._activeGrenadeCount,
        activeInfernos: this._activeInfernoCount,
        activeTracers: this._activeTracerCount,
      };

      this.onFrameRender(snapshot, this.currentTick, this.playing);
    };
    this._rafId = requestAnimationFrame(tickLoop);
  }

  _clearGroup(group) {
    while (group.children.length > 0) {
      const c = group.children.pop();
      if (c.userData?.sharedAsset) continue;
      c.traverse?.((obj) => {
        if (obj.userData?.sharedAsset) return;
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    }
  }

  _setWeaponCloneOnGroup(
    group,
    key,
    {
      scale = INCHES_PER_METER,
      rotX = 0,
      rotY = Math.PI,
      rotZ = 0,
      pos = [0, 0, 0],
      alignToWeaponBone = false,
      castShadow = true,
      receiveShadow = true,
    } = {}
  ) {
    while (group.children.length > 0) {
      group.children.pop();
    }
    const tpl = this.weaponTemplates.get(key);
    if (!tpl) {
      this._loadWeaponTemplate(key);
      return false;
    }
    const pivot = new THREE.Group();
    pivot.userData.sharedAsset = true;
    pivot.scale.setScalar(scale);
    pivot.rotation.set(rotX, rotY, rotZ);
    pivot.position.set(pos[0], pos[1], pos[2]);

    const clone = SkeletonUtils.clone(tpl);
    clone.userData.sharedAsset = true;
    clone.traverse((o) => {
      o.userData.sharedAsset = true;
      if (o.isMesh) {
        o.castShadow = !!castShadow;
        o.receiveShadow = !!receiveShadow;
        if (o.isSkinnedMesh || !castShadow) o.frustumCulled = false;
      }
    });
    if (alignToWeaponBone && tpl.userData.weaponBoneInverse) {
      tpl.userData.weaponBoneInverse.decompose(clone.position, clone.quaternion, clone.scale);
    } else {
      const g = tpl.userData.handROffset;
      if (g) {
        clone.position.set(-g.x, -g.y, -g.z);
      }
    }
    pivot.add(clone);
    group.add(pivot);
    return true;
  }

  _updateSceneAtTick(tick, dt = 0.016) {
    if (!this.roundReplay || !this.roundReplay.frames?.length) {
      this.bombGroup.visible = false;
      this.viewModelGroup.visible = false;
      return null;
    }

    const snap = interpolateFrames(this.roundReplay.frames, tick);
    if (!snap) return null;

    const carrierSlot = snap.bomb && snap.bomb[4] === 1 ? Math.round(snap.bomb[3]) : -1;
    const weapons = this.roundReplay.weapons || [];
    const tickRate = this.roundReplay.tick_rate || 64;
    const nowSec = performance.now() * 0.001;
    const tmpHandPos = (this._tmpHandPos || (this._tmpHandPos = new THREE.Vector3()));
    const tmpHandLPos = (this._tmpHandLPos || (this._tmpHandLPos = new THREE.Vector3()));

    // Check which slots have died on or before this tick + active bomb plant/defuse slots
    const deathBySlot = new Map();
    for (const k of this.roundReplay.kills || []) {
      if (k.tick <= tick && typeof k.victim_slot === 'number') {
        deathBySlot.set(k.victim_slot, k);
      }
    }
    let plantingSlot = -1;
    let defusingSlot = -1;
    for (const ev of this.roundReplay.bomb_events || []) {
      if (ev.tick > tick) break;
      if (ev.type === 'plant_begin') plantingSlot = ev.player_slot ?? -1;
      else if (ev.type === 'plant_abort' || ev.type === 'planted') plantingSlot = -1;
      else if (ev.type === 'defuse_begin') defusingSlot = ev.player_slot ?? -1;
      else if (ev.type === 'defuse_abort' || ev.type === 'defused' || ev.type === 'exploded') defusingSlot = -1;
    }

    // Resolve observed POV slot & >=3.2s deathcam BEFORE setting rig visibility so 3rd-person body hides atomically
    let observedSlot = this.povSlot;
    let observedPlayer = snap.players[observedSlot] || null;
    let deathCamActive = false;
    let deathCamElapsed = 0;
    let deathCamPos = null;
    let povSlotChanged = false;

    if (this.cameraMode === 'pov') {
      if (observedPlayer && observedPlayer[0] === 1) {
        this._deathCam = null;
      } else {
        const dEv = deathBySlot.get(observedSlot);
        let deathTick = dEv ? dEv.tick : null;
        if (deathTick === null && this._deathCam?.slot === observedSlot) {
          deathTick = this._deathCam.deathTick;
        } else if (deathTick === null) {
          const frames = this.roundReplay.frames;
          const curIdx = Math.max(0, frames.findIndex((f) => f.t >= tick));
          for (let fi = curIdx; fi >= 0; fi--) {
            const fp = frames[fi]?.p?.[observedSlot];
            if (fp && fp[0] === 1) {
              deathTick = frames[Math.min(frames.length - 1, fi + 1)]?.t ?? tick;
              break;
            }
          }
          if (deathTick !== null) {
            this._deathCam = { slot: observedSlot, deathTick };
          }
        }
        const deadTeam =
          (observedPlayer && observedPlayer[1]) ||
          dEv?.victim_team ||
          this.metaBySlot.get(observedSlot)?.team ||
          3;
        const elapsedSec = deathTick !== null ? (tick - deathTick) / tickRate : Infinity;
        if (deathTick !== null && elapsedSec >= 0 && elapsedSec < 3.2) {
          deathCamActive = true;
          deathCamElapsed = elapsedSec;
          deathCamPos = dEv?.victim_pos || (observedPlayer ? [observedPlayer[2], observedPlayer[3], observedPlayer[4]] : null);
        } else {
          const mateSlot = findNextAliveTeammate(snap.players, observedSlot, deadTeam);
          if (mateSlot >= 0) {
            this.povSlot = mateSlot;
            observedSlot = mateSlot;
            observedPlayer = snap.players[mateSlot];
            this._deathCam = null;
            povSlotChanged = true;
          } else {
            // Last player on team died -> stay in free cam (never jump to killer)
            this.cameraMode = 'free';
            this.orbit.enabled = false;
            this.viewModelGroup.visible = false;
            this.camera.fov = WORLD_FOV_VERTICAL;
            this.camera.updateProjectionMatrix();
            if (this.povFillLight) this.povFillLight.visible = false;
            this.freePos.copy(this.camera.position);
            const dir = new THREE.Vector3();
            this.camera.getWorldDirection(dir);
            this.freeYaw = Math.atan2(-dir.x, -dir.z);
            this.freePitch = Math.asin(Math.max(-0.99, Math.min(0.99, dir.y)));
            this._deathCam = null;
            povSlotChanged = true;
          }
        }
      }
    }

    const demoTimeSec = tick / Math.max(1, tickRate);
    for (const rig of this.playerRigs) {
      const slot = rig.slot;
      const p = snap.players[slot];
      const deathEvent = deathBySlot.get(slot);
      const hideForPov = this.cameraMode === 'pov' && !deathCamActive && slot === observedSlot;
      rig.root.userData.outlined = p?.[0] === 1 && !hideForPov;

      if (!p || p[0] !== 1) {
        if (deathEvent && rig.isRealOperator && deathEvent.victim_pos) {
          const [dx, dy, dz] = cs2ToThree(deathEvent.victim_pos[0], deathEvent.victim_pos[1], deathEvent.victim_pos[2]);
          rig.root.position.set(dx, dy, dz);
          rig.root.visible = !hideForPov;
          rig.bodyGroup.scale.set(1, 1, 1);
          const deadElapsedSec = Math.max(0, (tick - deathEvent.tick) / tickRate);
          this._poseOperatorSkeleton(rig, {
            dead: true,
            deadElapsedSec,
            weaponKey: rig.currentWorldWeaponKey || 'ak47',
            weaponCat: weaponCategory(rig.currentWorldWeaponKey || ''),
            team: rig.team,
          });
          // Drop last held weapon onto the ground beside the fallen operator
          if (!hideForPov && rig.currentWorldWeaponKey && rig.worldWeaponGroup.children.length > 0) {
            rig.worldWeaponGroup.visible = true;
            rig.worldWeaponGroup.position.set(16, 2.2, -10);
            rig.worldWeaponGroup.rotation.set(0, 0.55, Math.PI / 2);
            const pivotChild = rig.worldWeaponGroup.children[0];
            if (pivotChild) pivotChild.position.set(0, 0, 0);
          } else {
            rig.worldWeaponGroup.visible = false;
          }
          rig.c4BackMesh.visible = false;
          rig.footRing.visible = false;
          rig.contactShadow.visible = !hideForPov;
          if (rig.defuseKitMesh) rig.defuseKitMesh.visible = false;
          if (rig.labelEl) rig.labelEl.style.display = 'none';
        } else {
          rig.root.visible = false;
          rig.c4BackMesh.visible = false;
          if (rig.labelEl) rig.labelEl.style.display = 'none';
        }
        continue;
      }

      const team = p[1];
      const [tx, ty, tz] = cs2ToThree(p[2], p[3], p[4]);
      const yaw = p[5];
      const pitch = p[6];
      const duck = p[9];
      const scaleY = playerBodyHeight(duck) / 72;

      const { speed: frameSpeed, vx, vy, vz } = computePlayerSpeed(this.roundReplay.frames, slot, tick, tickRate);
      let speed = frameSpeed;
      if (this.playing && rig.lastPos) {
        const dx = tx - rig.lastPos[0];
        const dz = tz - rig.lastPos[2];
        const dist = Math.hypot(dx, dz);
        if (dist > 0.15 && dist < 120 && dt > 0.001) {
          speed = Math.max(speed, dist / dt);
          rig.walkPhase += Math.min(0.8, dist * 0.085);
        }
      } else if (speed > 12) {
        // Deterministic mid-stride phase when paused or scrubbing so moving players show natural run stride
        rig.walkPhase = tick * 0.14 + slot * 0.9;
      }
      rig.lastPos = [tx, ty, tz];

      rig.root.position.set(tx, ty, tz);
      rig.root.rotation.y = yaw * Math.PI / 180 - Math.PI / 2;
      rig.footRing.visible = !hideForPov;
      rig.contactShadow.visible = !hideForPov;
      rig.worldWeaponGroup.visible = !hideForPov;

      const wIdx = p[13] ?? -1;
      const weaponName = wIdx >= 0 && weapons[wIdx] ? weapons[wIdx] : '';
      const wKey = weaponNameToModelKey(weaponName, team);
      const wCat = weaponCategory(weaponName);

      let latestShotTick = -1;
      for (const sh of this.roundReplay.shots || []) {
        if (sh.slot === slot && sh.tick <= tick && tick - sh.tick <= Math.round(0.45 * tickRate)) {
          if (sh.tick > latestShotTick) latestShotTick = sh.tick;
        }
      }
      const firing = ((p[14] || 0) & 4) !== 0 || latestShotTick >= 0;
      const shotAgeSec = latestShotTick >= 0 ? (tick - latestShotTick) / tickRate : 0;

      if (rig.isRealOperator) {
        rig.bodyGroup.scale.set(1, 1, 1);
        this._poseOperatorSkeleton(rig, {
          duck,
          pitchDeg: pitch,
          yawDeg: yaw,
          walkPhase: rig.walkPhase,
          speed,
          vx,
          vy,
          vz,
          breathePhase: nowSec * 2.1 + slot * 0.7,
          weaponKey: wKey,
          weaponCat: wCat,
          team,
          firing,
          shotAgeSec,
          flashed: p[11] || 0,
          planting: slot === plantingSlot,
          defusing: slot === defusingSlot,
          demoTimeSec,
          dt,
        });
        if (rig.defuseKitMesh) {
          rig.defuseKitMesh.visible = ((p[14] || 0) & 2) !== 0;
        }
      } else {
        rig.bodyGroup.scale.set(1, scaleY, 1);
      }
      rig.c4BackMesh.visible = slot === carrierSlot;

      const color = team === 3 ? CT_COLOR : T_COLOR;
      rig.solidMat.color.setHex(color);
      rig.footRingMat.color.setHex(color);

      if (rig.root.userData.headGroup) {
        rig.root.userData.headGroup.rotation.x = -(pitch * Math.PI) / 180;
      }

      // Attach active CS2 weapon GLB synced to CS2 wpn bone (while keeping worldWeaponGroup anchored at hand_R palm)
      const useBoneAlign = rig.isRealOperator && rig.usedRealAnim && !!rig.bones?.wpn;
      if (
        rig.currentWorldWeaponKey !== wKey ||
        rig.currentWorldWeaponAligned !== useBoneAlign ||
        rig.worldWeaponGroup.children.length === 0
      ) {
        const wRot = useBoneAlign
          ? [0, 0, 0]
          : wCat === 'knife'
          ? [-1.15, Math.PI, 0.12]
          : wCat === 'grenade'
          ? [0.15, Math.PI, 0]
          : wCat === 'c4'
          ? [-0.35, Math.PI, 0]
          : [0, Math.PI, 0];
        if (
          this._setWeaponCloneOnGroup(rig.worldWeaponGroup, wKey, {
            scale: useBoneAlign ? INCHES_PER_METER : INCHES_PER_METER * 0.94,
            rotX: wRot[0],
            rotY: wRot[1],
            rotZ: wRot[2],
            alignToWeaponBone: useBoneAlign,
          })
        ) {
          rig.currentWorldWeaponKey = wKey;
          rig.currentWorldWeaponAligned = useBoneAlign;
        }
      }
      if (rig.isRealOperator && rig.bones?.hand_R) {
        rig.root.updateMatrixWorld(true);
        rig.bones.hand_R.getWorldPosition(tmpHandPos);
        if (rig.bones.finger_middle_0_R) {
          rig.bones.finger_middle_0_R.getWorldPosition(tmpHandLPos);
          tmpHandPos.lerp(tmpHandLPos, 0.52);
        }
        rig.bodyGroup.worldToLocal(tmpHandPos);
        rig.worldWeaponGroup.position.copy(tmpHandPos);

        const pivotChild = rig.worldWeaponGroup.children[0];
        if (useBoneAlign && rig.bones.wpn && pivotChild) {
          const wpnWPos = (this._tmpWpnPos || (this._tmpWpnPos = new THREE.Vector3()));
          const wpnWQ = (this._tmpWpnQ || (this._tmpWpnQ = new THREE.Quaternion()));
          const bodyWQ = (this._tmpBodyQ || (this._tmpBodyQ = new THREE.Quaternion()));
          rig.bones.wpn.getWorldPosition(wpnWPos);
          rig.bones.wpn.getWorldQuaternion(wpnWQ);
          rig.bodyGroup.worldToLocal(wpnWPos);
          rig.bodyGroup.getWorldQuaternion(bodyWQ);
          rig.worldWeaponGroup.quaternion.copy(bodyWQ.invert().multiply(wpnWQ));
          rig.worldWeaponGroup.updateMatrixWorld(true);
          rig.bones.wpn.getWorldPosition(wpnWPos);
          rig.worldWeaponGroup.worldToLocal(wpnWPos);
          pivotChild.position.copy(wpnWPos);
        } else if (
          (wCat === 'rifle' || wCat === 'sniper' || wCat === 'smg' || wCat === 'heavy') &&
          rig.bones.hand_L
        ) {
          rig.bones.hand_L.getWorldPosition(tmpHandLPos);
          rig.bodyGroup.worldToLocal(tmpHandLPos);
          const dx = tmpHandLPos.x - tmpHandPos.x;
          const dy = tmpHandLPos.y - tmpHandPos.y;
          const dz = tmpHandLPos.z - tmpHandPos.z;
          const horiz = Math.hypot(dx, dz) || 1;
          rig.worldWeaponGroup.rotation.set(
            Math.atan2(dy, horiz) - (pitch * Math.PI) / 360,
            Math.atan2(-dx, -dz),
            0
          );
          if (pivotChild) pivotChild.position.set(0, 0, 0);
        } else {
          rig.worldWeaponGroup.rotation.set(-(pitch * Math.PI) / 180, 0, 0);
          if (pivotChild) pivotChild.position.set(0, 0, 0);
        }
      } else {
        rig.worldWeaponGroup.position.set(6.8, 46 - duck * 16, -13);
        rig.worldWeaponGroup.rotation.set(-(pitch * Math.PI) / 180, 0, 0);
      }

      rig.root.visible = !hideForPov;
      if (hideForPov && rig.labelEl) {
        rig.labelEl.style.display = 'none';
      }
    }

    if (povSlotChanged) {
      this.onCameraStateChange({ cameraMode: this.cameraMode, povSlot: this.povSlot });
    }

    // Apply 1st-person POV camera (or >=3s Deathcam showing fallen body) + real CS2 viewmodel animations
    if (this.cameraMode === 'pov') {
      if (deathCamActive && deathCamPos) {
        this.viewModelGroup.visible = false;
        if (this.camera.fov !== WORLD_FOV_VERTICAL) {
          this.camera.fov = WORLD_FOV_VERTICAL;
          this.camera.updateProjectionMatrix();
        }
        const [vx, vy, vz] = cs2ToThree(deathCamPos[0], deathCamPos[1], deathCamPos[2]);
        const yawVal = observedPlayer ? observedPlayer[5] : 0;
        const [lx, , lz] = cs2LookDirThree(yawVal, 0);
        const ease = 1 - Math.pow(1 - Math.min(1, deathCamElapsed / 0.9), 2.5);
        const dist = 20 + ease * 68;
        const lookAt = (this._tmpDeathLook || (this._tmpDeathLook = new THREE.Vector3())).set(vx, vy + 20, vz);
        const desiredCam = (this._tmpDeathCamPos || (this._tmpDeathCamPos = new THREE.Vector3())).set(
          vx - lx * dist,
          vy + 32 + ease * 26,
          vz - lz * dist
        );
        if (this.mapGroup.children.length > 0) {
          const rc = (this._tmpDeathRc || (this._tmpDeathRc = new THREE.Raycaster()));
          const dir = (this._tmpDeathDir || (this._tmpDeathDir = new THREE.Vector3())).subVectors(desiredCam, lookAt);
          const len = dir.length();
          if (len > 2) {
            dir.divideScalar(len);
            rc.set(lookAt, dir);
            rc.far = len;
            const hits = rc.intersectObjects(this.mapGroup.children, true);
            if (hits.length > 0 && hits[0].distance > 12) {
              desiredCam.copy(lookAt).addScaledVector(dir, hits[0].distance - 8);
            }
          }
        }
        this.camera.position.copy(desiredCam);
        this.camera.lookAt(lookAt);
      } else if (observedPlayer && observedPlayer[0] === 1) {
        const p = observedPlayer;
        const punchPitch = p[20] || 0;
        const punchYaw = p[21] || 0;
        const [ex, ey, ez] = playerEyePosThree(p[2], p[3], p[4], p[9]);
        const [dx, dy, dz] = cs2LookDirThree(p[5] + punchYaw * 0.65, p[6] + punchPitch * 0.65);
        this.camera.position.set(ex, ey, ez);
        this.camera.lookAt(ex + dx * 200, ey + dy * 200, ez + dz * 200);

        const wIdx = p[13] ?? -1;
        const weaponName = wIdx >= 0 && weapons[wIdx] ? weapons[wIdx] : '';
        const zoomLevel = p[10] || 0;
        const desiredFov = cs2FovToVertical(povCameraFov(weaponName, zoomLevel));
        if (this.camera.fov !== desiredFov) {
          this.camera.fov = desiredFov;
          this.camera.updateProjectionMatrix();
        }

        const sniperScoped = isSniperWeapon(weaponName) && zoomLevel > 0;
        if (sniperScoped) {
          this.viewModelGroup.visible = false;
        } else {
          this.viewModelGroup.visible = true;
          const cat = weaponCategory(weaponName);
          const meshKey = this.vmMeshes[cat] ? cat : 'rifle';
          const realKey = weaponNameToModelKey(weaponName, p[1]);

          if (this.lastObservedWeaponKey !== realKey) {
            this.lastObservedWeaponKey = realKey;
            this.viewInspectPhase = 0;
            // Play draw animation only during live playback; when paused/scrubbed, show steady CS2 idle grip
            this.vmDrawTimer = this.playing ? 0.45 : 0;
          }

          let latestPovShot = -1;
          for (const sh of this.roundReplay.shots || []) {
            if (sh.slot === observedSlot && sh.tick <= tick && tick - sh.tick <= Math.round(0.45 * tickRate)) {
              if (sh.tick > latestPovShot) latestPovShot = sh.tick;
            }
          }
          const firedRecently =
            ((p[14] || 0) & 4) !== 0 ||
            (latestPovShot >= 0 && tick - latestPovShot <= 4);
          if (firedRecently) {
            this.viewRecoilOffset = 1.0;
            this.vmShotTimer = 0.32;
            this.viewInspectPhase = 0;
          } else {
            this.viewRecoilOffset = Math.max(0, this.viewRecoilOffset - dt * 10);
            this.vmShotTimer = Math.max(0, this.vmShotTimer - dt);
          }
          if (this.vmDrawTimer > 0) this.vmDrawTimer = Math.max(0, this.vmDrawTimer - dt);
          if (this.viewInspectPhase > 0) this.viewInspectPhase = Math.max(0, this.viewInspectPhase - dt * 0.25);

          const isCtTeam = p[1] === 3;
          const activeArmsRig = isCtTeam ? this.povArmsRigs.ct : this.povArmsRigs.t;
          const inactiveArmsRig = isCtTeam ? this.povArmsRigs.t : this.povArmsRigs.ct;
          if (inactiveArmsRig) inactiveArmsRig.clone.visible = false;

          // Drive real CS2 viewmodel AnimationMixer on active arms rig
          let usedRealVmAnim = false;
          if (activeArmsRig && this.operatorClips.size > 0) {
            const vmClips = resolveOperatorClipNames({ weaponKey: realKey, weaponCat: cat, team: p[1] });
            let vmClipName = vmClips.vmIdle;
            let vmTime = nowSec;
            let vmLoop = true;
            if (latestPovShot >= 0 && this.operatorClips.has(vmClips.vmShoot)) {
              vmClipName = vmClips.vmShoot;
              vmTime = (tick - latestPovShot) / tickRate;
              vmLoop = false;
            } else if (this.vmDrawTimer > 0 && this.operatorClips.has(vmClips.vmDraw)) {
              vmClipName = vmClips.vmDraw;
              vmTime = 0.45 - this.vmDrawTimer;
              vmLoop = false;
            } else if (this.viewInspectPhase > 0 && this.operatorClips.has(vmClips.vmInspect)) {
              vmClipName = vmClips.vmInspect;
              const inspClip = this.operatorClips.get(vmClips.vmInspect);
              vmTime = (1 - this.viewInspectPhase) * (inspClip?.duration || 2.5);
              vmLoop = false;
            }
            usedRealVmAnim = this._playClipOnRig(activeArmsRig, vmClipName, {
              timeSec: vmTime,
              loop: vmLoop,
              crossFadeSec: 0.08,
              dt,
            });
          }

          let showingRealVm = false;
          if (this.weaponTemplates.has(realKey)) {
            if (
              this.currentRealVmKey !== realKey ||
              this.currentRealVmAligned !== usedRealVmAnim ||
              this.vmRealContainer.children.length === 0
            ) {
              const vmRot = usedRealVmAnim
                ? [0, 0, 0]
                : cat === 'knife'
                ? [-1.15, Math.PI, 0.15]
                : cat === 'grenade'
                ? [0.15, Math.PI, 0]
                : cat === 'c4'
                ? [-0.5, Math.PI, 0]
                : [0, Math.PI, 0];
              const vmScale = usedRealVmAnim
                ? INCHES_PER_METER
                : cat === 'grenade'
                ? INCHES_PER_METER * 0.85
                : cat === 'c4'
                ? INCHES_PER_METER * 0.72
                : INCHES_PER_METER * 0.82;
              if (
                this._setWeaponCloneOnGroup(this.vmRealContainer, realKey, {
                  scale: vmScale,
                  rotX: vmRot[0],
                  rotY: vmRot[1],
                  rotZ: vmRot[2],
                  alignToWeaponBone: usedRealVmAnim,
                  castShadow: false,
                  receiveShadow: false,
                })
              ) {
                this.currentRealVmKey = realKey;
                this.currentRealVmAligned = usedRealVmAnim;
              }
            }
            showingRealVm = this.vmRealContainer.children.length > 0;
          } else {
            this._loadWeaponTemplate(realKey);
          }

          if (activeArmsRig) {
            if (!usedRealVmAnim) {
              this._posePovArmsForCategory(activeArmsRig, cat);
            }
            activeArmsRig.clone.visible = showingRealVm;
          }

          this.vmRealContainer.visible = showingRealVm;
          for (const [k, m] of Object.entries(this.vmMeshes)) {
            m.visible = !showingRealVm && k === meshKey;
          }
          this.currentViewCategory = meshKey;

          const obsSpeedInfo = computePlayerSpeed(this.roundReplay.frames, observedSlot, tick, tickRate);
          const moveBobAmt = Math.min(1, obsSpeedInfo.speed / 240);
          if (this.playing && moveBobAmt > 0.05) {
            this.viewWalkBobPhase += dt * 11.0;
          }
          const bobX = Math.sin(this.viewWalkBobPhase) * 0.28 * moveBobAmt;
          const bobY = Math.abs(Math.cos(this.viewWalkBobPhase)) * -0.22 * moveBobAmt;

          if (usedRealVmAnim && activeArmsRig?.bones?.wpn) {
            this.viewModelGroup.position.set(bobX, bobY, 0);
            this.viewModelGroup.rotation.set(0, 0, 0);
            this.viewModelGroup.updateMatrixWorld(true);
            const wpnPos = (this._tmpVmWpnP || (this._tmpVmWpnP = new THREE.Vector3()));
            const wpnQuat = (this._tmpVmWpnQ || (this._tmpVmWpnQ = new THREE.Quaternion()));
            activeArmsRig.bones.wpn.getWorldPosition(wpnPos);
            activeArmsRig.bones.wpn.getWorldQuaternion(wpnQuat);
            this.viewModelGroup.worldToLocal(wpnPos);
            this.vmRealContainer.position.copy(wpnPos);
            this.vmRealContainer.quaternion.copy(wpnQuat);
            this.vmMuzzleFlash.position.set(wpnPos.x + 0.5, wpnPos.y + 1.5, wpnPos.z - 16);
          } else {
            const idleSwayX = Math.sin(nowSec * 1.6) * 0.14;
            const idleSwayY = Math.cos(nowSec * 2.2) * 0.12;
            const adsPull = zoomLevel > 0 ? 2.2 : 0;
            const baseOffset = showingRealVm
              ? cat === 'pistol'
                ? [6.2, -5.8, -11.5]
                : cat === 'knife'
                ? [5.8, -5.2, -10.5]
                : cat === 'grenade' || cat === 'c4'
                ? [5.4, -5.4, -10.0]
                : [6.5, -6.2, -12.8]
              : [3.4, -2.8, -6.2];
            this.viewModelGroup.position.set(
              baseOffset[0] - adsPull + idleSwayX + bobX,
              baseOffset[1] + this.viewRecoilOffset * 0.35 + idleSwayY + bobY,
              baseOffset[2] + this.viewRecoilOffset * 1.4
            );
            this.viewModelGroup.rotation.set(this.viewRecoilOffset * 0.09, -0.05, 0);
            this.vmRealContainer.position.set(0, 0, 0);
            this.vmRealContainer.quaternion.set(0, 0, 0, 1);
            this.vmMuzzleFlash.position.set(0, showingRealVm ? 2.2 : 0.4, showingRealVm ? -18 : -15);
          }

          this.vmMuzzleFlash.visible =
            firedRecently &&
            (meshKey === 'rifle' || meshKey === 'sniper' || meshKey === 'pistol' || meshKey === 'smg');
        }
      } else {
        this.viewModelGroup.visible = false;
      }
    } else {
      this.viewModelGroup.visible = false;
    }

    // Bomb
    if (snap.bomb && (snap.bomb[4] === 0 || snap.bomb[4] === 2 || snap.bomb[4] === 3)) {
      const [bx, by, bz] = cs2ToThree(snap.bomb[0], snap.bomb[1], snap.bomb[2]);
      this.bombGroup.position.set(bx, by + 4, bz);
      this.bombGroup.visible = true;
      const planted = snap.bomb[4] === 3 || snap.bomb[4] === 2;
      const blink = planted ? (Math.sin(performance.now() * 0.014) > 0 ? 1 : 0.25) : 0.2;
      this.bombLed.visible = planted;
      this.bombLed.material.color.setHex(blink > 0.5 ? 0xff2d20 : 0x550000);
      this.bombPulseRing.visible = snap.bomb[4] === 3;
      if (snap.bomb[4] === 3) {
        const phase = (performance.now() * 0.0025) % 1;
        const s = 0.6 + phase * 2.2;
        this.bombPulseRing.scale.set(s, s, 1);
        this.bombPulseRing.material.opacity = 0.75 * (1 - phase);
      }
    } else {
      this.bombGroup.visible = false;
    }

    // Volumetric Multi-Puff CS2 Smokes (Fresnel soft-edge grey cloud shader, <= 144u radius)
    const activeSmokes = [];
    let smokeIdx = 0;
    for (const sm of this.roundReplay.smokes || []) {
      const env = smokeEnvelope(sm, tick, tickRate);
      if (!env.active) continue;
      activeSmokes.push(sm);
      const item = this._getSmokePoolItem(smokeIdx++);
      const [sx, sy, sz] = cs2ToThree(sm.position[0], sm.position[1], sm.position[2] + 54);
      item.cluster.visible = true;
      item.cluster.position.set(sx, sy, sz);
      item.cluster.scale.set(144 * env.scale, 122 * env.scale, 144 * env.scale);
      item.cluster.updateMatrixWorld(true);
      item.smokeMat.uniforms.uOpacity.value = Math.min(0.97, env.opacity * 1.38);
      const smokeInverse = (this._smokeInverse ??= new THREE.Matrix4()).copy(item.volumeMesh.matrixWorld).invert();
      const cameraLocal = item.smokeMat.uniforms.uCameraLocal.value.copy(this.camera.position).applyMatrix4(smokeInverse);
      item.smokeMat.uniforms.uSunLocal.value.copy(SUN_DIR).transformDirection(smokeInverse);
      const inside = cameraLocal.lengthSq() < 1;
      item.smokeMat.uniforms.uInside.value = inside ? 1.0 : 0.0;
      const wantSide = inside ? THREE.BackSide : THREE.FrontSide;
      if (item.smokeMat.side !== wantSide) {
        item.smokeMat.side = wantSide;
        item.smokeMat.depthTest = !inside;
        item.smokeMat.needsUpdate = true;
      }
    }
    this._activeSmokeCount = smokeIdx;
    for (let i = smokeIdx; i < this._smokePool.length; i++) {
      this._smokePool[i].cluster.visible = false;
    }

    // Molotov / Incendiary floor fire zones (2 InstancedMesh draw calls total)
    const useInfernoXray = this.xray && this.cameraMode !== 'pov';
    this._infernoPatchMat.depthTest = !useInfernoXray;
    this._infernoFlameMat.depthTest = !useInfernoXray;
    const fireM = (this._tmpFireMat4 || (this._tmpFireMat4 = new THREE.Matrix4()));
    const fireP = (this._tmpFirePos || (this._tmpFirePos = new THREE.Vector3()));
    const fireQ = (this._tmpFireQuat || (this._tmpFireQuat = new THREE.Quaternion()));
    const fireS = (this._tmpFireScale || (this._tmpFireScale = new THREE.Vector3(1, 1, 1)));
    let fireIdx = 0;
    const maxFire = this._infernoPatches.instanceMatrix.count;
    for (const inf of this.roundReplay.infernos || []) {
      if (tick < inf.start_tick || (inf.end_tick > 0 && tick > inf.end_tick)) continue;
      const pts = inf.points?.length ? inf.points : inf.center ? [inf.center] : [];
      for (const pt of pts) {
        if (fireIdx >= maxFire) break;
        const coveredBySmoke = activeSmokes.some((sm) => {
          const dx = sm.position[0] - pt[0];
          const dy = sm.position[1] - pt[1];
          return dx * dx + dy * dy < 145 * 145;
        });
        if (coveredBySmoke) continue;
        const [fx, fy, fz] = cs2ToThree(pt[0], pt[1], pt[2] + 3);
        fireP.set(fx, fy, fz);
        fireM.compose(fireP, fireQ, fireS);
        this._infernoPatches.setMatrixAt(fireIdx, fireM);
        fireP.set(fx, fy + 18, fz);
        fireM.compose(fireP, fireQ, fireS);
        this._infernoFlames.setMatrixAt(fireIdx, fireM);
        fireIdx++;
      }
      if (fireIdx >= maxFire) break;
    }
    this._activeInfernoCount = fireIdx;
    this._infernoPatches.count = fireIdx;
    this._infernoFlames.count = fireIdx;
    if (fireIdx > 0) {
      this._infernoPatches.instanceMatrix.needsUpdate = true;
      this._infernoFlames.instanceMatrix.needsUpdate = true;
    }

    // Grenade trajectories, HE explosions, Flash bursts, and Decoys (pooled, zero allocations)
    let gIdx = 0;
    for (const g of this.roundReplay.grenades || []) {
      const traj = g.traj || [];
      const endTick = g.end_tick || g.det_tick || (traj.length ? traj[traj.length - 1][0] : g.throw_tick);
      if (tick < g.throw_tick || tick > endTick) continue;

      const item = this._getGrenadePoolItem(gIdx++);
      item.group.visible = true;
      const colorHex =
        g.type === 'flash'
          ? 0xfef08a
          : g.type === 'he'
          ? 0xef4444
          : g.type === 'smoke'
          ? 0x94a3b8
          : g.type === 'decoy'
          ? 0xa855f7
          : 0xf97316;

      let showTraj = false;
      if (traj.length >= 2 && (!g.det_tick || tick <= g.det_tick + Math.round(1.0 * tickRate))) {
        let ptCount = 0;
        let lastGx = 0;
        let lastGy = 0;
        let lastGz = 0;
        const step = Math.max(1, Math.ceil(traj.length / item.maxPts));
        for (let i = 0; i < traj.length; i += step) {
          const p = traj[i];
          if (p[0] > tick) break;
          const [gx, gy, gz] = cs2ToThree(p[1], p[2], p[3]);
          item.lineArr[ptCount * 3] = gx;
          item.lineArr[ptCount * 3 + 1] = gy;
          item.lineArr[ptCount * 3 + 2] = gz;
          lastGx = gx;
          lastGy = gy;
          lastGz = gz;
          ptCount++;
        }
        if (ptCount >= 2) {
          showTraj = true;
          item.line.visible = true;
          item.lineMat.color.setHex(colorHex);
          item.lineAttr.needsUpdate = true;
          item.lineGeo.setDrawRange(0, ptCount);

          const gKey = grenadeTypeToModelKey(g.type);
          const gTpl = this.weaponTemplates.get(gKey);
          if (gTpl) {
            if (item.attachedKey !== gKey) {
              while (item.modelAnchor.children.length > 0) item.modelAnchor.children.pop();
              const gModel = SkeletonUtils.clone(gTpl);
              gModel.scale.setScalar(INCHES_PER_METER * 1.8);
              item.modelAnchor.add(gModel);
              item.attachedKey = gKey;
            }
            item.modelAnchor.visible = true;
            item.modelAnchor.position.set(lastGx, lastGy, lastGz);
            item.modelAnchor.rotation.set(tick * 0.14, tick * 0.18, tick * 0.1);
          } else {
            item.modelAnchor.visible = false;
            this._loadWeaponTemplate(gKey);
          }

          item.orb.visible = true;
          item.orb.position.set(lastGx, lastGy, lastGz);
          item.orb.scale.setScalar(gTpl ? 7.5 : 5.5);
          item.orbMat.color.setHex(colorHex);
          item.orbMat.transparent = !!gTpl;
          item.orbMat.opacity = gTpl ? 0.38 : 1.0;
          item.orbMat.depthWrite = !gTpl;
        }
      }
      if (!showTraj) {
        item.line.visible = false;
        item.modelAnchor.visible = false;
        item.orb.visible = false;
      }

      item.blast.visible = false;
      item.pulse.visible = false;
      if (g.det_tick > 0 && tick >= g.det_tick && g.position) {
        const [dx, dy, dz] = cs2ToThree(g.position[0], g.position[1], g.position[2] + 10);
        const ageFrac = Math.max(0, Math.min(1, (tick - g.det_tick) / Math.max(1, endTick - g.det_tick)));
        const useXrayDepth = this.xray && this.cameraMode !== 'pov';
        if (g.type === 'he') {
          const r = 30 + ageFrac * 185;
          item.blast.visible = true;
          item.blast.position.set(dx, dy, dz);
          item.blast.scale.setScalar(r);
          item.blastMat.color.setHex(0xf97316);
          item.blastMat.opacity = 0.82 * (1 - ageFrac * 0.7);
          item.blastMat.depthTest = !useXrayDepth;
        } else if (g.type === 'flash') {
          const r = 20 + ageFrac * 95;
          item.blast.visible = true;
          item.blast.position.set(dx, dy, dz);
          item.blast.scale.setScalar(r);
          item.blastMat.color.setHex(0xffffff);
          item.blastMat.opacity = 0.92 * (1 - ageFrac);
          item.blastMat.depthTest = !useXrayDepth;
        } else if (g.type === 'decoy') {
          const s = 1 + ((tick % 16) / 16) * 1.1;
          item.pulse.visible = true;
          item.pulse.position.set(dx, dy - 6, dz);
          item.pulse.scale.set(s, s, 1);
        }
      }
    }
    this._activeGrenadeCount = gIdx;
    for (let i = gIdx; i < this._grenadePool.length; i++) {
      this._grenadePool[i].group.visible = false;
    }

    // Batched shot tracers (single LineSegments draw call)
    let tracerIdx = 0;
    if (this.showTracers) {
      const tracerWindow = Math.max(4, Math.round(0.2 * tickRate));
      const maxTracers = this._tracerPositions.length / 6;
      for (const sh of this.roundReplay.shots || []) {
        if (tracerIdx >= maxTracers) break;
        if (sh.tick > tick || tick - sh.tick > tracerWindow) continue;
        const [ox, oy, oz] = cs2ToThree(sh.origin[0], sh.origin[1], sh.origin[2] + 4);
        const [dx, dy, dz] = cs2LookDirThree(sh.yaw, sh.pitch);
        const len = 1400;
        const base = tracerIdx * 6;
        this._tracerPositions[base] = ox;
        this._tracerPositions[base + 1] = oy;
        this._tracerPositions[base + 2] = oz;
        this._tracerPositions[base + 3] = ox + dx * len;
        this._tracerPositions[base + 4] = oy + dy * len;
        this._tracerPositions[base + 5] = oz + dz * len;
        const alpha = Math.max(0.22, 1 - (tick - sh.tick) / tracerWindow);
        this._tracerColors[base] = 1.0 * alpha;
        this._tracerColors[base + 1] = 0.89 * alpha;
        this._tracerColors[base + 2] = 0.54 * alpha;
        this._tracerColors[base + 3] = 1.0 * alpha * 0.45;
        this._tracerColors[base + 4] = 0.85 * alpha * 0.45;
        this._tracerColors[base + 5] = 0.45 * alpha * 0.45;
        tracerIdx++;
      }
      if (tracerIdx > 0) {
        this._tracerPosAttr.needsUpdate = true;
        this._tracerColAttr.needsUpdate = true;
      }
    }
    this._activeTracerCount = tracerIdx;
    this._tracerGeo.setDrawRange(0, tracerIdx * 2);

    // Pooled kill markers
    let killIdx = 0;
    const killWindow = Math.max(32, Math.round(2.0 * tickRate));
    for (const k of this.roundReplay.kills || []) {
      if (k.tick > tick || tick - k.tick > killWindow) continue;
      const item = this._getKillPoolItem(killIdx++);
      const [kx, ky, kz] = cs2ToThree(k.victim_pos[0], k.victim_pos[1], k.victim_pos[2] + 36);
      item.mesh.visible = true;
      item.mesh.position.set(kx, ky, kz);
      item.mat.color.setHex(k.killer_team === 3 ? CT_COLOR : T_COLOR);
      item.mat.opacity = 0.9 * (1 - (tick - k.tick) / killWindow);
    }
    for (let i = killIdx; i < this._killPool.length; i++) {
      this._killPool[i].mesh.visible = false;
    }

    snap.observedPlayer = observedPlayer;
    snap.observedSlot = observedSlot;
    snap.deathCamActive = deathCamActive;
    snap.deathCamElapsed = deathCamElapsed;
    return snap;
  }

  _update2DOverlays(snap) {
    if (!this.overlayEl || !snap) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const v = new THREE.Vector3();

    const visibleTags = [];
    for (const rig of this.playerRigs) {
      const slot = rig.slot;
      const p = snap.players[slot];
      const el = rig.labelEl;
      if (!el) continue;

      const isObservedPov = this.cameraMode === 'pov' && slot === snap.observedSlot;
      if (!p || p[0] !== 1 || isObservedPov || !this.xray) {
        el.style.display = 'none';
        continue;
      }

      const [tx, ty, tz] = cs2ToThree(p[2], p[3], p[4] + 84);
      v.set(tx, ty, tz).project(this.camera);
      if (v.z < -1 || v.z > 1) {
        el.style.display = 'none';
        continue;
      }
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      if (sx < -40 || sx > w + 40 || sy < -30 || sy > h + 30) {
        el.style.display = 'none';
        continue;
      }

      visibleTags.push({ id: slot, rig, p, sx, sy });
    }

    // Clamp tags inside safe stage bounds clearing radar (left 196px), top CS2 bar (98px), right overlay (324px), and bottom POV HUD
    const bounds = {
      minX: 280,
      maxX: Math.max(380, w - 404),
      minY: 102,
      maxY: Math.max(140, h - 88),
    };
    const placed = deoverlapScreenTags(visibleTags, 26, 152, 320, bounds);
    for (const item of placed) {
      const { rig, p, sx, sy } = item;
      const el = rig.labelEl;
      el.style.display = 'flex';
      el.style.transform = `translate3d(${Math.round(sx)}px, ${Math.round(sy)}px, 0) translate(-50%, -100%)`;
      el.classList.toggle('team-ct', p[1] === 3);
      el.classList.toggle('team-t', p[1] === 2);
      el.querySelector('.tag-slot').textContent = String((rig.slot + 1) % 10);
      el.querySelector('.tag-name').textContent = rig.meta?.name || `P${rig.slot + 1}`;
      el.querySelector('.tag-hp').textContent = `${Math.round(p[7])}`;
    }
  }
}
