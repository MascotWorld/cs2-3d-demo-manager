import * as THREE from 'three';

export class PlayerOutline {
  constructor(renderer, ctColor, tColor) {
    this.renderer = renderer;
    this.maskScene = new THREE.Scene();
    this.maskScene.matrixWorldAutoUpdate = false;
    this.mask = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.ctMask = new THREE.MeshBasicMaterial({ color: 0xff0000, toneMapped: false });
    this.tMask = new THREE.MeshBasicMaterial({ color: 0x00ff00, toneMapped: false });
    this.players = [];
    this.clearColor = new THREE.Color();
    this.drawingSize = new THREE.Vector2();
    this.viewProjection = new THREE.Matrix4();
    this.clipPoint = new THREE.Vector4();
    this.playerBounds = new THREE.Vector4();
    this.edge = new THREE.ShaderMaterial({
      uniforms: {
        playerMask: { value: this.mask.texture },
        playerDepth: { value: this.mask.depthTexture },
        stepUv: { value: new THREE.Vector2() },
        screenRegion: { value: new THREE.Vector4(0, 0, 1, 1) },
        ctColor: { value: new THREE.Color(ctColor) },
        tColor: { value: new THREE.Color(tColor) },
      },
      depthFunc: THREE.GreaterDepth,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      vertexShader: `
        uniform vec4 screenRegion;
        varying vec2 vUv;
        void main() {
          vUv = mix(screenRegion.xy, screenRegion.zw, uv);
          gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D playerMask;
        uniform sampler2D playerDepth;
        uniform vec2 stepUv;
        uniform vec3 ctColor;
        uniform vec3 tColor;
        varying vec2 vUv;

        void findEdge(vec2 uv, inout float depth, inout vec3 color) {
          vec2 team = texture2D(playerMask, uv).rg;
          if (team.r + team.g < 0.5) return;
          float z = texture2D(playerDepth, uv).r;
          if (z >= depth) return;
          depth = z;
          color = team.r > team.g ? ctColor : tColor;
        }

        void main() {
          vec2 center = texture2D(playerMask, vUv).rg;
          if (center.r + center.g > 0.5) discard;
          float depth = 1.0;
          vec3 color = vec3(0.0);
          findEdge(vUv + vec2(stepUv.x, 0.0), depth, color);
          findEdge(vUv - vec2(stepUv.x, 0.0), depth, color);
          findEdge(vUv + vec2(0.0, stepUv.y), depth, color);
          findEdge(vUv - vec2(0.0, stepUv.y), depth, color);
          if (depth == 1.0) discard;
          gl_FragDepth = depth - 0.0000005;
          gl_FragColor = vec4(color, 0.9);
          #include <colorspace_fragment>
        }
      `,
    });
    this.edgeScene = new THREE.Scene();
    this.edgeCamera = new THREE.Camera();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.edge);
    this.quad.frustumCulled = false;
    this.edgeScene.add(this.quad);
  }

  add(root, body, team, defuseKit) {
    const material = team === 3 ? this.ctMask : this.tMask;
    const parts = [];
    body.traverse((source) => {
      if (!source.isMesh || (!source.visible && source !== defuseKit)) return;
      if (!Array.isArray(source.material) && source.material.transparent) return;
      const proxy = source.isSkinnedMesh
        ? new THREE.SkinnedMesh(source.geometry, material)
        : new THREE.Mesh(source.geometry, material);
      if (source.isSkinnedMesh) {
        proxy.skeleton = source.skeleton;
        proxy.bindMatrix.copy(source.bindMatrix);
      }
      proxy.frustumCulled = source.frustumCulled;
      this.maskScene.add(proxy);
      parts.push({ source, proxy });
    });
    this.players.push({ root, parts });
  }

  clear() {
    this.maskScene.clear();
    this.players.length = 0;
  }

  projectPlayerBounds(root) {
    const { elements } = root.matrixWorld;
    const { clipPoint, playerBounds, viewProjection } = this;
    playerBounds.set(Infinity, Infinity, -Infinity, -Infinity);
    let pointsAhead = 0;
    for (let i = 0; i < 8; i++) {
      clipPoint.set(
        elements[12] + (i & 1 ? 64 : -64),
        elements[13] + (i & 2 ? 110 : -32),
        elements[14] + (i & 4 ? 64 : -64),
        1,
      ).applyMatrix4(viewProjection);
      if (clipPoint.w <= 0) continue;
      pointsAhead++;
      const x = clipPoint.x / clipPoint.w * 0.5 + 0.5;
      const y = clipPoint.y / clipPoint.w * 0.5 + 0.5;
      playerBounds.x = Math.min(playerBounds.x, x);
      playerBounds.y = Math.min(playerBounds.y, y);
      playerBounds.z = Math.max(playerBounds.z, x);
      playerBounds.w = Math.max(playerBounds.w, y);
    }
    if (pointsAhead === 0) return false;
    if (pointsAhead < 8) playerBounds.set(0, 0, 1, 1);
    return playerBounds.z >= 0 && playerBounds.w >= 0 && playerBounds.x <= 1 && playerBounds.y <= 1;
  }

  render(camera) {
    let hasPlayers = false;
    const screenRegion = this.edge.uniforms.screenRegion.value.set(1, 1, 0, 0);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    for (const { root, parts } of this.players) {
      const outlined = root.visible && root.userData.outlined && this.projectPlayerBounds(root);
      if (outlined) {
        hasPlayers = true;
        const { x, y, z, w } = this.playerBounds;
        screenRegion.set(
          Math.min(screenRegion.x, x), Math.min(screenRegion.y, y),
          Math.max(screenRegion.z, z), Math.max(screenRegion.w, w),
        );
      }
      for (const { source, proxy } of parts) {
        proxy.visible = outlined && source.visible;
        if (!proxy.visible) continue;
        proxy.matrixWorld.copy(source.matrixWorld);
        if (proxy.isSkinnedMesh) proxy.bindMatrixInverse.copy(source.bindMatrixInverse);
      }
    }
    if (!hasPlayers) return;

    const { renderer, mask, drawingSize } = this;
    renderer.getDrawingBufferSize(drawingSize);
    if (mask.width !== drawingSize.x || mask.height !== drawingSize.y) {
      mask.setSize(drawingSize.x, drawingSize.y);
    }
    const canvas = renderer.domElement;
    const pixelX = 1 / Math.max(1, canvas.clientWidth);
    const pixelY = 1 / Math.max(1, canvas.clientHeight);
    this.edge.uniforms.stepUv.value.set(1.85 * pixelX, 1.85 * pixelY);
    screenRegion.set(
      Math.max(0, screenRegion.x - 4 * pixelX), Math.max(0, screenRegion.y - 4 * pixelY),
      Math.min(1, screenRegion.z + 4 * pixelX), Math.min(1, screenRegion.w + 4 * pixelY),
    );
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(mask);
    renderer.setClearColor(0, 0);
    renderer.clear();
    renderer.render(this.maskScene, camera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(this.clearColor, clearAlpha);
    renderer.render(this.edgeScene, this.edgeCamera);
  }

  dispose() {
    this.clear();
    this.mask.dispose();
    this.ctMask.dispose();
    this.tMask.dispose();
    this.quad.geometry.dispose();
    this.edge.dispose();
  }
}
